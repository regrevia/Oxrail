import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

export const MAX_TOOL_CALL_SLOTS = 1_024;
export const TOOL_CALL_POST_MAX_AGE_MS = 10 * 60_000;

const MAX_ID_LENGTH = 4_096;
const MAX_MARKER_BYTES = 256;

/**
 * IGNORED covers duplicate, out-of-order, late, invalid, and unavailable
 * claims. Callers must fail open; an active user lease must be denied by Guard
 * before this idempotency claim runs.
 */
export type ToolCallClaimResult = "CLAIMED" | "IGNORED";
export type ToolCallPhase = "PreToolUse" | "PostToolUse";

export interface ToolCallClaimInput {
  phase: ToolCallPhase;
  sessionId: string;
  taskId: string;
  toolUseId: string;
}

interface ClaimMarker {
  createdAt: number;
  phase: ToolCallPhase;
  schemaVersion: 1;
  toolDigest: string;
}

type MarkerRead =
  | { kind: "INVALID" | "MISSING" }
  | { kind: "VALID"; marker: ClaimMarker };

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;

function digest(domain: string, ...values: string[]): string {
  const hash = createHash("sha256").update(domain);
  for (const value of values) {
    hash
      .update("\0")
      .update(String(Buffer.byteLength(value)))
      .update(":")
      .update(value);
  }
  return hash.digest("hex");
}

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_ID_LENGTH;

function validInput(input: ToolCallClaimInput): boolean {
  return (
    Boolean(input) &&
    validId(input.sessionId) &&
    validId(input.taskId) &&
    validId(input.toolUseId) &&
    (input.phase === "PreToolUse" || input.phase === "PostToolUse")
  );
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      !["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(errorCode(error) ?? "")
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function isMarker(value: unknown, phase: ToolCallPhase): value is ClaimMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<ClaimMarker>;
  return (
    marker.schemaVersion === 1 &&
    marker.phase === phase &&
    typeof marker.toolDigest === "string" &&
    /^[a-f0-9]{64}$/.test(marker.toolDigest) &&
    Number.isSafeInteger(marker.createdAt) &&
    marker.createdAt! >= 0
  );
}

async function readMarker(
  filename: string,
  phase: ToolCallPhase,
): Promise<MarkerRead> {
  let handle;
  try {
    handle = await open(filename, "r");
    if ((await handle.stat()).size > MAX_MARKER_BYTES)
      return { kind: "INVALID" };
    const contents = await handle.readFile();
    if (contents.byteLength > MAX_MARKER_BYTES) return { kind: "INVALID" };
    const value: unknown = JSON.parse(contents.toString("utf8"));
    return isMarker(value, phase)
      ? { kind: "VALID", marker: value }
      : { kind: "INVALID" };
  } catch (error) {
    return { kind: errorCode(error) === "ENOENT" ? "MISSING" : "INVALID" };
  } finally {
    await handle?.close();
  }
}

type CreateResult = "CREATED" | "ERROR" | "EXISTS";

async function createMarker(
  directory: string,
  slot: string,
  marker: ClaimMarker,
): Promise<CreateResult> {
  const phase = marker.phase === "PreToolUse" ? "pre" : "post";
  const destination = path.join(directory, `${slot}.${phase}.json`);
  const temporary = path.join(
    directory,
    `.${slot}.${phase}.${randomUUID()}.tmp`,
  );
  let handle;
  let ownsTemporary = false;
  try {
    try {
      handle = await open(temporary, "wx", 0o600);
      ownsTemporary = true;
    } catch {
      return "ERROR";
    }
    const contents = `${JSON.stringify(marker)}\n`;
    if (Buffer.byteLength(contents) > MAX_MARKER_BYTES) return "ERROR";
    await handle.writeFile(contents, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
      await syncDirectory(directory);
      return "CREATED";
    } catch (error) {
      return errorCode(error) === "EEXIST" ? "EXISTS" : "ERROR";
    }
  } finally {
    await handle?.close();
    if (ownsTemporary) await unlink(temporary).catch(() => undefined);
  }
}

const slotName = (index: number) => index.toString(16).padStart(3, "0");

const slotPath = (directory: string, index: number, phase: "post" | "pre") =>
  path.join(directory, `${slotName(index)}.${phase}.json`);

async function claimPre(
  directory: string,
  toolDigest: string,
  now: number,
): Promise<ToolCallClaimResult> {
  const start =
    Number.parseInt(toolDigest.slice(0, 8), 16) % MAX_TOOL_CALL_SLOTS;
  for (let offset = 0; offset < MAX_TOOL_CALL_SLOTS; offset += 1) {
    const index = (start + offset) % MAX_TOOL_CALL_SLOTS;
    const existing = await readMarker(
      slotPath(directory, index, "pre"),
      "PreToolUse",
    );
    if (existing.kind === "INVALID") return "IGNORED";
    if (existing.kind === "VALID") {
      if (existing.marker.toolDigest === toolDigest) return "IGNORED";
      continue;
    }
    const created = await createMarker(directory, slotName(index), {
      createdAt: now,
      phase: "PreToolUse",
      schemaVersion: 1,
      toolDigest,
    });
    if (created === "CREATED") return "CLAIMED";
    if (created !== "EXISTS") return "IGNORED";
    const winner = await readMarker(
      slotPath(directory, index, "pre"),
      "PreToolUse",
    );
    if (winner.kind !== "VALID") return "IGNORED";
    if (winner.marker.toolDigest === toolDigest) return "IGNORED";
  }
  return "IGNORED";
}

async function claimPost(
  directory: string,
  toolDigest: string,
  now: number,
): Promise<ToolCallClaimResult> {
  const start =
    Number.parseInt(toolDigest.slice(0, 8), 16) % MAX_TOOL_CALL_SLOTS;
  for (let offset = 0; offset < MAX_TOOL_CALL_SLOTS; offset += 1) {
    const index = (start + offset) % MAX_TOOL_CALL_SLOTS;
    const pre = await readMarker(
      slotPath(directory, index, "pre"),
      "PreToolUse",
    );
    if (pre.kind !== "VALID") return "IGNORED";
    if (pre.marker.toolDigest !== toolDigest) continue;
    const age = now - pre.marker.createdAt;
    if (age < 0 || age > TOOL_CALL_POST_MAX_AGE_MS) return "IGNORED";
    const postPath = slotPath(directory, index, "post");
    if ((await readMarker(postPath, "PostToolUse")).kind !== "MISSING") {
      return "IGNORED";
    }
    return (await createMarker(directory, slotName(index), {
      createdAt: now,
      phase: "PostToolUse",
      schemaVersion: 1,
      toolDigest,
    })) === "CREATED"
      ? "CLAIMED"
      : "IGNORED";
  }
  return "IGNORED";
}

export async function claimToolCallPhase(
  root: string,
  input: ToolCallClaimInput,
): Promise<ToolCallClaimResult> {
  try {
    if (!validInput(input)) return "IGNORED";
    const sessionDirectory = path.join(
      root,
      digest("oxrail-tool-call-session-v1", input.sessionId),
    );
    const taskDirectory = path.join(
      sessionDirectory,
      digest("oxrail-tool-call-task-v1", input.taskId),
    );
    const directory = path.join(taskDirectory, "tool-calls");
    await privateDirectory(root);
    await privateDirectory(sessionDirectory);
    await privateDirectory(taskDirectory);
    await privateDirectory(directory);
    const toolDigest = digest(
      "oxrail-tool-call-v1",
      input.sessionId,
      input.taskId,
      input.toolUseId,
    );
    return await (input.phase === "PreToolUse"
      ? claimPre(directory, toolDigest, Date.now())
      : claimPost(directory, toolDigest, Date.now()));
  } catch {
    return "IGNORED";
  }
}
