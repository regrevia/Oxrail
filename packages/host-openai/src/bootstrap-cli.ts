import { fileURLToPath } from "node:url";

import { bootstrapHostProfile } from "./bootstrap.js";
import { oxrailDataDirectory } from "./state.js";

const inventoryPath = process.argv
  .slice(2)
  .find((argument) => argument !== "--");
if (!inventoryPath) {
  console.error("usage: oxrail bootstrap <host-inventory.json>");
  process.exit(2);
}

const pluginRoot =
  process.env.PLUGIN_ROOT ?? fileURLToPath(new URL("../", import.meta.url));
const pluginData = oxrailDataDirectory();
const profile = await bootstrapHostProfile({
  inventoryPath,
  pluginData,
  pluginRoot,
});
process.stdout.write(
  `Oxrail profile candidate installed: ${profile.profileId}\n` +
    "Hook trust remains controlled by the host. Run oxrail doctor next.\n",
);
