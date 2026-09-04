import { describe, expect, it } from "vitest";

import { CredentialKeychainProbeResultSchema } from "../packages/protocol/src/index.js";

const canary = "oxrail_api_key_probe_output_canary";

describe("macOS Keychain synthetic probe result", () => {
  it("accepts only fixed secret-free output shapes", () => {
    for (const line of [
      '{"schemaVersion":1,"probe":"KEYCHAIN_ROUND_TRIP","status":"PASSED"}',
      '{"schemaVersion":1,"probe":"KEYCHAIN_ROUND_TRIP","status":"FAILED"}',
      '{"schemaVersion":1,"probe":"KEYCHAIN_ROUND_TRIP","status":"USAGE"}',
      `{"schemaVersion":1,"probe":"KEYCHAIN_ROUND_TRIP","status":"CLEANUP_FAILED","probeId":"${"a".repeat(32)}"}`,
    ]) {
      expect(
        CredentialKeychainProbeResultSchema.safeParse(JSON.parse(line)).success,
      ).toBe(true);
    }
  });

  it("rejects secret, free-text, persistent-ref, and malformed cleanup output", () => {
    for (const output of [
      {
        schemaVersion: 1,
        probe: "KEYCHAIN_ROUND_TRIP",
        status: "PASSED",
        value: canary,
      },
      {
        schemaVersion: 1,
        probe: "KEYCHAIN_ROUND_TRIP",
        status: "FAILED",
        message: canary,
      },
      {
        schemaVersion: 1,
        probe: "KEYCHAIN_ROUND_TRIP",
        status: "PASSED",
        persistentRef: canary,
      },
      {
        schemaVersion: 1,
        probe: "KEYCHAIN_ROUND_TRIP",
        status: "CLEANUP_FAILED",
      },
      {
        schemaVersion: 1,
        probe: "KEYCHAIN_ROUND_TRIP",
        status: "CLEANUP_FAILED",
        probeId: canary,
      },
    ]) {
      const parsed = CredentialKeychainProbeResultSchema.safeParse(output);
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain(canary);
    }
  });
});
