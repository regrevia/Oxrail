import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { LabCollector } from "./collector.js";

const MAX_FRAME_BYTES = 10_240;
const encode = (value: unknown) => `${JSON.stringify(value)}\n`;
const rejected = encode({
  schemaVersion: 1,
  accepted: false,
  code: "REJECTED",
});

export type CollectorIpc = Readonly<{
  socketPath: string;
  sessionToken: string;
  close: () => Promise<void>;
}>;

export const startCollectorIpc = async (options: {
  root: string;
  collector: LabCollector;
}): Promise<CollectorIpc> => {
  if (process.platform === "win32") throw new Error("UNSUPPORTED_PLATFORM");
  const ipcRoot = path.join(path.resolve(options.root), "ipc");
  await mkdir(ipcRoot, { recursive: true, mode: 0o700 });
  await chmod(ipcRoot, 0o700);
  const socketPath = path.join(ipcRoot, `collector-${process.pid}.sock`);
  await rm(socketPath, { force: true });
  const sessionToken = randomBytes(32).toString("base64url");
  const expectedToken = Buffer.from(sessionToken);

  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    let answered = false;
    const answer = (value: string) => {
      if (answered) return;
      answered = true;
      socket.end(value);
    };
    socket.on("data", (chunk) => {
      if (answered) return;
      buffered = Buffer.concat(
        [buffered, chunk],
        buffered.length + chunk.length,
      );
      if (buffered.length > MAX_FRAME_BYTES) {
        answer(rejected);
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) return;
      if (newline !== buffered.length - 1) {
        answer(rejected);
        return;
      }
      try {
        const envelope = JSON.parse(
          buffered.subarray(0, newline).toString("utf8"),
        );
        if (
          !envelope ||
          typeof envelope !== "object" ||
          Array.isArray(envelope) ||
          Object.keys(envelope).sort().join(",") !==
            "event,protocolVersion,sessionToken" ||
          envelope.protocolVersion !== 1 ||
          typeof envelope.sessionToken !== "string"
        ) {
          answer(rejected);
          return;
        }
        const receivedToken = Buffer.from(envelope.sessionToken);
        if (
          receivedToken.length !== expectedToken.length ||
          !timingSafeEqual(receivedToken, expectedToken)
        ) {
          answer(rejected);
          return;
        }
        const result = options.collector.offer(envelope.event);
        answer(encode({ schemaVersion: 1, ...result }));
      } catch {
        answer(rejected);
      } finally {
        buffered.fill(0);
      }
    });
    socket.on("error", () => undefined);
  });
  server.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);

  return {
    socketPath,
    sessionToken,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    },
  };
};
