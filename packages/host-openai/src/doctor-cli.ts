import { fileURLToPath } from "node:url";

import type { HostProfile } from "../../protocol/src/index.js";
import { readHostInventory } from "./bootstrap.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { oxrailDataDirectory } from "./state.js";

const args = process.argv.slice(2);
const valueAfter = (flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const surface = valueAfter("--surface") as
  | HostProfile["identity"]["surface"]
  | undefined;
const browser = valueAfter("--browser");
const browserPath =
  browser === "chrome"
    ? "chrome-extension"
    : (browser as HostProfile["identity"]["browserPath"] | undefined);
const sessionId = valueAfter("--session-id");
const hostBuild = valueAfter("--host-build");
const computerUsePluginVersion = valueAfter("--computer-use-version");
const codexVersion = valueAfter("--codex-version");
const os = valueAfter("--os") as HostProfile["identity"]["os"] | undefined;
const inventoryPath = valueAfter("--host-inventory");
const inventoryIdentity = inventoryPath
  ? (await readHostInventory(inventoryPath)).inventory
  : undefined;
const currentIdentity = inventoryIdentity
  ? {
      surface: inventoryIdentity.surface,
      hostBuild: inventoryIdentity.hostBuild,
      ...(inventoryIdentity.codexVersion
        ? { codexVersion: inventoryIdentity.codexVersion }
        : {}),
      computerUsePluginVersion: inventoryIdentity.computerUsePluginVersion,
      browserPath: inventoryIdentity.browserPath,
      os: inventoryIdentity.os,
    }
  : surface && browserPath && hostBuild && computerUsePluginVersion && os
    ? {
        surface,
        hostBuild,
        ...(codexVersion ? { codexVersion } : {}),
        computerUsePluginVersion,
        browserPath,
        os,
      }
    : undefined;
const bundledRoot = fileURLToPath(new URL("../", import.meta.url));
const pluginRoot = process.env.PLUGIN_ROOT ?? bundledRoot;
const pluginData = oxrailDataDirectory();

const report = await runDoctor({
  pluginData,
  pluginRoot,
  ...(currentIdentity ? { currentIdentity } : {}),
  ...(sessionId ? { sessionId } : {}),
  ...(browserPath ? { browserPath } : {}),
  ...(surface ? { surface } : {}),
});
process.stdout.write(
  args.includes("--json")
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatDoctorReport(report)}\n`,
);
