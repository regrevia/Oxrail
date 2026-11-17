import net from "node:net";

import type { SafeEvent } from "../protocol/index.js";
import type { HookSessionConfig } from "./session-config.js";

export const offerHookEvent = async (
  config: HookSessionConfig,
  event: SafeEvent,
  timeoutMs = 100,
): Promise<void> =>
  new Promise((resolve) => {
    const socket = net.createConnection(config.socketPath);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve();
    };
    socket.setTimeout(timeoutMs, finish);
    socket.on("connect", () => {
      socket.end(
        `${JSON.stringify({
          protocolVersion: 1,
          sessionToken: config.sessionToken,
          event,
        })}\n`,
      );
    });
    socket.on("data", () => undefined);
    socket.on("end", finish);
    socket.on("error", finish);
  });
