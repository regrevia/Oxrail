import { lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { ToolNameSchema } from "../protocol/index.js";

const ToolAliasSchema = z.enum([
  "NATIVE_BROWSER",
  "BUILTIN_BROWSER",
  "OTHER_REGISTERED",
]);

export const HookSessionConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("ACTIVE"),
    runId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    pairId: z.enum(["control", "chrome"]),
    socketPath: z.string().min(1).max(1024),
    sessionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    inventoryStatus: z.enum(["UNAVAILABLE_PUBLIC_API", "PROVIDED_UNVERIFIED"]),
    toolBindings: z
      .record(ToolNameSchema, ToolAliasSchema)
      .refine((bindings) => Object.keys(bindings).length <= 64),
  })
  .strict();

export type HookSessionConfig = z.infer<typeof HookSessionConfigSchema>;

export const defaultLabRoot = (): string =>
  process.env.OXRAIL_LAB_ROOT && path.isAbsolute(process.env.OXRAIL_LAB_ROOT)
    ? path.resolve(process.env.OXRAIL_LAB_ROOT)
    : path.join(os.homedir(), ".oxrail-lab");

export const activeHookSessionPath = (root = defaultLabRoot()): string =>
  path.join(path.resolve(root), "codex-local-hook-v1", "active.json");

export const loadActiveHookSession = async (
  root = defaultLabRoot(),
): Promise<HookSessionConfig> => {
  const rootPath = path.resolve(root);
  const filename = activeHookSessionPath(rootPath);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("UNSAFE_SESSION_CONFIG");
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error("UNSAFE_SESSION_CONFIG");
  if (info.size > 16_384) throw new Error("UNSAFE_SESSION_CONFIG");
  const resolved = await realpath(filename);
  const expectedRoot = `${rootPath}${path.sep}`;
  if (!resolved.startsWith(expectedRoot))
    throw new Error("UNSAFE_SESSION_CONFIG");
  return HookSessionConfigSchema.parse(
    JSON.parse(await readFile(resolved, "utf8")),
  );
};
