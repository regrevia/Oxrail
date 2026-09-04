import { request } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";
import {
  assertPairedInitialState,
  fingerprint,
  pairedSchedule,
} from "../benchmarks/harness/paired.mjs";
import {
  createFixtureServer,
  createResetReceipt,
  FIXTURE_INITIAL_POSTCONDITIONS,
} from "../benchmarks/harness/server.mjs";

describe("paired benchmark harness", () => {
  it("creates a deterministic, interleaved paired schedule", () => {
    const ids = [
      "TEST-NIF-001",
      "TEST-NIF-002",
      "TEST-NIF-003",
      "TEST-NIF-004",
    ];
    const first = pairedSchedule(ids, "run-7");

    expect(pairedSchedule(ids, "run-7")).toEqual(first);
    expect(first.map(({ testId }) => testId).sort()).toEqual([...ids].sort());
    expect(first.every(({ variants }) => new Set(variants).size === 2)).toBe(
      true,
    );
    expect(new Set(first.map(({ variants }) => variants[0])).size).toBe(2);
  });

  it("hashes key order identically and rejects mismatched initial state", () => {
    expect(fingerprint({ b: 2, a: { d: 4, c: 3 } })).toBe(
      fingerprint({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(
      assertPairedInitialState(
        { page: "fixture", seed: 1 },
        { seed: 1, page: "fixture" },
      ),
    ).toHaveLength(64);
    expect(() => assertPairedInitialState({ seed: 1 }, { seed: 2 })).toThrow(
      "paired initial state mismatch",
    );
  });

  it("creates a deterministic, arm-bound, no-side-effect reset receipt", async () => {
    const input = {
      run_id: "pilot-1",
      arm_id: "pilot-1-P0-LUNA-001-native",
      task_id: "P0-LUNA-001",
      seed: "pilot-seed",
    };
    const first = await createResetReceipt(input);

    expect(await createResetReceipt(input)).toEqual(first);
    expect(first.initial_state).toEqual(FIXTURE_INITIAL_POSTCONDITIONS);
    expect(first.initial_state_hash).toBe(
      fingerprint(FIXTURE_INITIAL_POSTCONDITIONS),
    );
    expect(new URL(first.reset_url).searchParams.get("reset")).toBe(
      first.receipt_id,
    );
    expect(
      (await createResetReceipt({ ...input, arm_id: `${input.arm_id}-2` }))
        .receipt_id,
    ).not.toBe(first.receipt_id);
  });

  it("ignores a spoofed Host header and restores safe fixture headers", async () => {
    const server = createFixtureServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const { port } = server.address() as AddressInfo;
      const result = await new Promise<{
        body: string;
        headers: Record<string, string | string[] | undefined>;
        status: number | undefined;
      }>((resolve, reject) => {
        const input = JSON.stringify({
          run_id: "pilot-2",
          arm_id: "pilot-2-P0-LUNA-001-native",
          task_id: "P0-LUNA-001",
          seed: "pilot-seed",
        });
        const call = request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/reset",
            method: "POST",
            headers: {
              "content-length": Buffer.byteLength(input),
              "content-type": "application/json",
              host: "attacker.example",
            },
          },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () =>
              resolve({
                body,
                headers: response.headers,
                status: response.statusCode,
              }),
            );
          },
        );
        call.on("error", reject);
        call.end(input);
      });

      expect(result.status).toBe(200);
      expect(new URL(JSON.parse(result.body).reset_url).origin).toBe(
        "http://127.0.0.1:4173",
      );
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.headers["content-security-policy"]).toContain(
        "default-src 'self'",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
