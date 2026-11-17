import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  LabCollector,
  purgeExpiredRuns,
  readPersistedEvents,
} from "../monitor/collector.js";
import { startCollectorIpc } from "../monitor/ipc.js";
import { SafeEventSchema } from "../protocol/index.js";

const runId = "safe-run";
const event = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  eventId: randomUUID(),
  runId,
  pairId: null,
  source: "FIXTURE",
  sourceClockId: "fixture-clock",
  sourceSequence: 1,
  observedMonotonicMs: 10,
  receivedMonotonicMs: 11,
  sessionRef: "a".repeat(64),
  callRef: "b".repeat(64),
  actor: "AGENT",
  kind: "TOOL_REQUEST_OBSERVED",
  toolAlias: "NATIVE_BROWSER",
  granularity: "TOOL_INVOCATION",
  outcome: "UNKNOWN",
  metrics: {
    toolRequests: {
      value: 1,
      quality: "MEASURED",
      source: "FIXTURE",
      basis: "OBSERVED_EVENT_COUNT",
      missingReason: null,
    },
  },
  ...overrides,
});

const send = async (socketPath: string, value: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(JSON.parse(output)));
    socket.on("error", reject);
  });

describe("WP-LAB-003 safe collector", () => {
  it("strictly rejects escape fields and inconsistent metrics", () => {
    expect(SafeEventSchema.safeParse(event()).success).toBe(true);
    for (const candidate of [
      event({ raw: "private page" }),
      event({ message: "private page" }),
      event({ metrics: { arbitrary: { value: 1 } } }),
      event({
        metrics: {
          inputTokens: {
            value: 1,
            quality: "UNAVAILABLE",
            source: null,
            basis: "NOT_AVAILABLE",
            missingReason: null,
          },
        },
      }),
    ]) {
      expect(SafeEventSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("persists only validated events with private modes and idempotent IDs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oxrail-lab-collector-"));
    const collector = await LabCollector.create({ root, runId });
    const accepted = event();
    expect(collector.offer(accepted)).toEqual({
      accepted: true,
      code: "ACCEPTED",
    });
    expect(collector.offer(accepted)).toEqual({
      accepted: true,
      code: "DUPLICATE",
    });
    expect(collector.offer(event({ sourceSequence: 0 }))).toEqual({
      accepted: true,
      code: "ACCEPTED",
    });
    await collector.flush();

    expect(await readPersistedEvents(root, runId)).toHaveLength(2);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(path.join(root, "runs", runId, "events.jsonl"))).mode & 0o777,
    ).toBe(0o600);
    expect(collector.health()).toMatchObject({
      accepted: 2,
      duplicates: 1,
      persisted: 2,
      incomplete: false,
    });
  });

  it("drops secret-bearing, oversized, full-queue, and failed writes without throwing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oxrail-lab-overload-"));
    let releaseWrite!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const collector = await LabCollector.create({
      root,
      runId,
      maxQueue: 1,
      maxEventBytes: 2_048,
      write: async () => blocked,
    });
    const canary = "credential-canary-must-not-persist";
    expect(collector.offer(event({ payload: canary }))).toMatchObject({
      code: "INVALID",
    });
    expect(collector.offer(event({ eventId: randomUUID() }))).toMatchObject({
      code: "ACCEPTED",
    });
    expect(collector.offer(event({ eventId: randomUUID() }))).toMatchObject({
      code: "QUEUE_FULL",
    });
    expect(
      collector.offer({ ...event(), padding: canary.repeat(200) }),
    ).toMatchObject({ code: "OVERSIZE" });
    releaseWrite();
    await collector.flush();
    expect(
      await readFile(path.join(root, "runs", runId, "events.jsonl"), "utf8"),
    ).not.toContain(canary);

    const failed = await LabCollector.create({
      root: await mkdtemp(path.join(tmpdir(), "oxrail-lab-failed-")),
      runId,
      write: async () => {
        throw new Error(canary);
      },
    });
    expect(() => failed.offer(event())).not.toThrow();
    await failed.flush();
    expect(failed.health()).toMatchObject({
      incomplete: true,
      writeUnavailable: true,
    });
  });

  it("accepts one bounded authenticated IPC event without exposing policy controls", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(path.join(tmpdir(), "oxrail-lab-ipc-"));
    const collector = await LabCollector.create({ root, runId });
    const ipc = await startCollectorIpc({ root, collector });
    try {
      await expect(
        send(ipc.socketPath, {
          protocolVersion: 1,
          sessionToken: "wrong",
          event: event(),
        }),
      ).resolves.toEqual({
        schemaVersion: 1,
        accepted: false,
        code: "REJECTED",
      });
      const response = await send(ipc.socketPath, {
        protocolVersion: 1,
        sessionToken: ipc.sessionToken,
        event: event(),
      });
      expect(response).toEqual({
        schemaVersion: 1,
        accepted: true,
        code: "ACCEPTED",
      });
      expect(JSON.stringify(response)).not.toMatch(
        /allow|deny|context|message|input|output/i,
      );
      await collector.flush();
    } finally {
      await ipc.close();
    }
  });

  it("purges only expired real directories below the Lab run root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oxrail-lab-retention-"));
    const outside = await mkdtemp(path.join(tmpdir(), "oxrail-outside-"));
    const old = path.join(root, "runs", "old-run");
    const recent = path.join(root, "runs", "recent-run");
    await mkdir(old, { recursive: true });
    await mkdir(recent, { recursive: true });
    await writeFile(path.join(outside, "keep"), "outside");
    await symlink(outside, path.join(root, "runs", "outside-link"));
    await utimes(old, new Date(0), new Date(0));

    await expect(
      purgeExpiredRuns({ root, olderThanDays: 7, nowMs: 8 * 86_400_000 }),
    ).resolves.toBe(1);
    await expect(stat(old)).rejects.toThrow();
    await expect(stat(recent)).resolves.toBeDefined();
    await expect(readFile(path.join(outside, "keep"), "utf8")).resolves.toBe(
      "outside",
    );
  });
});
