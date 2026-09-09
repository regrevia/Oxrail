import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { SafeEventSchema, type SafeEvent } from "../protocol/index.js";

export type CollectorResult = Readonly<{
  accepted: boolean;
  code:
    | "ACCEPTED"
    | "DUPLICATE"
    | "INVALID"
    | "OVERSIZE"
    | "QUEUE_FULL"
    | "WRITE_UNAVAILABLE";
}>;

export type CollectorHealth = Readonly<{
  accepted: number;
  duplicates: number;
  dropped: number;
  persisted: number;
  incomplete: boolean;
  writeUnavailable: boolean;
}>;

type Pending = { event: SafeEvent };

export class LabCollector {
  readonly #runId: string;
  readonly #tracePath: string;
  readonly #maxEventBytes: number;
  readonly #maxQueue: number;
  readonly #write: (filename: string, data: string) => Promise<void>;
  readonly #seen = new Set<string>();
  readonly #queue: Pending[] = [];
  #draining = false;
  #inFlight = 0;
  #flushPromise: Promise<void> = Promise.resolve();
  #health = {
    accepted: 0,
    duplicates: 0,
    dropped: 0,
    persisted: 0,
    incomplete: false,
    writeUnavailable: false,
  };

  private constructor(options: {
    runId: string;
    tracePath: string;
    maxEventBytes: number;
    maxQueue: number;
    write?: (filename: string, data: string) => Promise<void>;
  }) {
    this.#runId = options.runId;
    this.#tracePath = options.tracePath;
    this.#maxEventBytes = options.maxEventBytes;
    this.#maxQueue = options.maxQueue;
    this.#write =
      options.write ??
      ((filename, data) => appendFile(filename, data, { mode: 0o600 }));
  }

  static async create(options: {
    root: string;
    runId: string;
    maxEventBytes?: number;
    maxQueue?: number;
    write?: (filename: string, data: string) => Promise<void>;
  }): Promise<LabCollector> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.runId))
      throw new Error("INVALID_RUN_ID");
    const root = path.resolve(options.root);
    const runRoot = path.join(root, "runs", options.runId);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(path.join(root, "runs"), 0o700);
    await chmod(runRoot, 0o700);
    const tracePath = path.join(runRoot, "events.jsonl");
    const handle = await open(tracePath, "a", 0o600);
    await handle.close();
    await chmod(tracePath, 0o600);
    return new LabCollector({
      runId: options.runId,
      tracePath,
      maxEventBytes: options.maxEventBytes ?? 8_192,
      maxQueue: options.maxQueue ?? 256,
      ...(options.write ? { write: options.write } : {}),
    });
  }

  offer(input: unknown): CollectorResult {
    let serialized: string;
    try {
      serialized = JSON.stringify(input);
    } catch {
      this.#drop();
      return { accepted: false, code: "INVALID" };
    }
    if (Buffer.byteLength(serialized) > this.#maxEventBytes) {
      this.#drop();
      return { accepted: false, code: "OVERSIZE" };
    }
    const parsed = SafeEventSchema.safeParse(input);
    if (!parsed.success || parsed.data.runId !== this.#runId) {
      this.#drop();
      return { accepted: false, code: "INVALID" };
    }
    if (this.#seen.has(parsed.data.eventId)) {
      this.#health.duplicates += 1;
      return { accepted: true, code: "DUPLICATE" };
    }
    if (this.#queue.length + this.#inFlight >= this.#maxQueue) {
      this.#drop();
      return { accepted: false, code: "QUEUE_FULL" };
    }
    this.#seen.add(parsed.data.eventId);
    this.#health.accepted += 1;
    this.#queue.push({ event: parsed.data });
    this.#scheduleDrain();
    return { accepted: true, code: "ACCEPTED" };
  }

  health(): CollectorHealth {
    return { ...this.#health };
  }

  async flush(): Promise<void> {
    await this.#flushPromise;
  }

  #drop(): void {
    this.#health.dropped += 1;
    this.#health.incomplete = true;
  }

  #scheduleDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#flushPromise = this.#drain();
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const pending = this.#queue.shift()!;
      this.#inFlight = 1;
      try {
        await this.#write(
          this.#tracePath,
          `${JSON.stringify(pending.event)}\n`,
        );
        this.#health.persisted += 1;
      } catch {
        this.#health.dropped += 1;
        this.#health.incomplete = true;
        this.#health.writeUnavailable = true;
      } finally {
        this.#inFlight = 0;
      }
    }
    this.#draining = false;
  }
}

export const purgeExpiredRuns = async (options: {
  root: string;
  olderThanDays?: number;
  nowMs?: number;
}): Promise<number> => {
  const root = path.resolve(options.root);
  const runsRoot = path.join(root, "runs");
  const cutoff =
    (options.nowMs ?? Date.now()) - (options.olderThanDays ?? 7) * 86_400_000;
  let removed = 0;
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const runRoot = path.join(runsRoot, entry.name);
    const info = await stat(runRoot);
    if (info.mtimeMs < cutoff) {
      await rm(runRoot, { recursive: true, force: false });
      removed += 1;
    }
  }
  return removed;
};

export const readPersistedEvents = async (
  root: string,
  runId: string,
): Promise<SafeEvent[]> => {
  const text = await readFile(
    path.join(path.resolve(root), "runs", runId, "events.jsonl"),
    "utf8",
  );
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => SafeEventSchema.parse(JSON.parse(line)));
};
