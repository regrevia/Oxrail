import { stdin } from "node:process";

import { projectCodexHookEvent } from "./adapter.js";
import { offerHookEvent } from "./ipc-client.js";
import { loadActiveHookSession } from "./session-config.js";

const MAX_STDIN_BYTES = 65_536;

const readBoundedStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_STDIN_BYTES) throw new Error("OVERSIZE_HOOK_INPUT");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, length).toString("utf8");
};

try {
  const config = await loadActiveHookSession();
  const input = JSON.parse(await readBoundedStdin());
  const event = projectCodexHookEvent(input, config);
  await offerHookEvent(config, event);
} catch {
  // Lab observation is strictly fail-open and emits no model-visible context.
}
