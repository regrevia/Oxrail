import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { z } from "zod";

import {
  LabCollector,
  readPersistedEvents,
  startCollectorIpc,
} from "../monitor/index.js";
import { ToolNameSchema } from "../protocol/index.js";
import {
  HookSessionConfigSchema,
  activeHookSessionPath,
  defaultLabRoot,
  type HookSessionConfig,
} from "./session-config.js";
import { classifyChromeHookTrial, type ChromePostcondition } from "./trial.js";

const InventorySchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.literal("host-tool-inventory"),
    chromeToolNames: z.array(ToolNameSchema).min(1).max(32),
    builtinToolNames: z.array(ToolNameSchema).max(32).default([]),
    otherToolNames: z.array(ToolNameSchema).max(32).default([]),
  })
  .strict()
  .refine((value) => {
    const all = [
      ...value.chromeToolNames,
      ...value.builtinToolNames,
      ...value.otherToolNames,
    ];
    return new Set(all).size === all.length;
  }, "tool inventory categories overlap");

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
};

const runId = argument("--run-id");
if (!runId || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(runId)) {
  console.error(
    "usage: chrome-hook-trial --run-id <safe-id> [--inventory <json>]",
  );
  process.exit(2);
}

const root = defaultLabRoot();
const activePath = activeHookSessionPath(root);
const activeRoot = path.dirname(activePath);
await mkdir(activeRoot, { recursive: true, mode: 0o700 });
await chmod(root, 0o700);
await chmod(activeRoot, 0o700);

const inventoryPath = argument("--inventory");
const inventory = inventoryPath
  ? InventorySchema.parse(JSON.parse(await readFile(inventoryPath, "utf8")))
  : null;
const toolBindings: Record<
  string,
  "NATIVE_BROWSER" | "BUILTIN_BROWSER" | "OTHER_REGISTERED"
> = { Bash: "OTHER_REGISTERED" };
for (const name of inventory?.chromeToolNames ?? [])
  toolBindings[name] = "NATIVE_BROWSER";
for (const name of inventory?.builtinToolNames ?? [])
  toolBindings[name] = "BUILTIN_BROWSER";
for (const name of inventory?.otherToolNames ?? [])
  toolBindings[name] = "OTHER_REGISTERED";

const collector = await LabCollector.create({ root, runId });
const ipc = await startCollectorIpc({ root, collector });
const baseConfig = {
  schemaVersion: 1,
  status: "ACTIVE",
  runId,
  socketPath: ipc.socketPath,
  sessionToken: ipc.sessionToken,
  inventoryStatus: inventory ? "PROVIDED_UNVERIFIED" : "UNAVAILABLE_PUBLIC_API",
  toolBindings,
} as const;

const writeConfig = async (pairId: "control" | "chrome", initial = false) => {
  const config: HookSessionConfig = HookSessionConfigSchema.parse({
    ...baseConfig,
    pairId,
  });
  if (initial) {
    const handle = await open(activePath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(config)}\n`);
    await handle.close();
    await chmod(activePath, 0o600);
    return;
  }
  const temporary = `${activePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, activePath);
};

const readline = createInterface({ input: stdin, output: stdout });
let clean = false;
const cleanup = async () => {
  if (clean) return;
  clean = true;
  await rm(activePath, { force: true });
  await collector.flush();
  await ipc.close();
  readline.close();
};
process.once("SIGINT", () => void cleanup().then(() => process.exit(130)));
process.once("SIGTERM", () => void cleanup().then(() => process.exit(143)));

try {
  await writeConfig("control", true);
  console.log(`runId=${runId}`);
  console.log(`labRoot=${root}`);
  console.log(
    `inventoryStatus=${baseConfig.inventoryStatus}; exact browser names are never guessed`,
  );
  console.log(
    "Enable and trust the separate oxrail-lab-codex-hook plugin, then open a new Codex chat.",
  );
  await readline.question("Press Enter when the new chat is ready: ");
  console.log(
    "CONTROL: ask that chat to run one harmless local read-only shell command.",
  );
  await readline.question(
    "Press Enter after the shell command has completed: ",
  );

  await writeConfig("chrome");
  console.log(
    "CHROME: explicitly select @Chrome and perform one controlled same-tab action with a visible postcondition.",
  );
  await readline.question(
    "Press Enter after the Chrome task has completed or failed: ",
  );
  const answer = (
    await readline.question(
      "Visible Chrome postcondition [pass/fail/unknown]: ",
    )
  )
    .trim()
    .toLowerCase();
  const postcondition: ChromePostcondition =
    answer === "pass" ? "PASS" : answer === "fail" ? "FAIL" : "UNKNOWN";

  await rm(activePath, { force: true });
  await collector.flush();
  const events = await readPersistedEvents(root, runId);
  const report = {
    ...classifyChromeHookTrial(events, postcondition),
    runId,
    inventoryStatus: baseConfig.inventoryStatus,
    eventCount: events.length,
  };
  const reportPath = path.join(root, "runs", runId, "chrome-hook-summary.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(reportPath, 0o600);
  console.log(JSON.stringify(report, null, 2));
  console.log(`summary=${reportPath}`);
} finally {
  await cleanup();
}
