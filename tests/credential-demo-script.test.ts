import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const script = path.resolve("skills/oxrail/scripts/credential.mjs");
const unavailable = {
  schemaVersion: 1,
  status: "ERROR",
  errorCode: "UNAVAILABLE",
};

describe("macOS credential demo Skill launcher", () => {
  it("fails closed with a fixed secret-free result off macOS", () => {
    const result = spawnSync(process.execPath, [script, "prompt"], {
      encoding: "utf8",
      env: { ...process.env, OXRAIL_TEST_PLATFORM: "linux" },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(unavailable);
    expect(result.stderr).toBe("");
  });

  it("never accepts a credential value as an argument", () => {
    const canary = "oxrail_test_argument_canary";
    const result = spawnSync(process.execPath, [script, "prompt", canary], {
      encoding: "utf8",
      env: { ...process.env, OXRAIL_TEST_PLATFORM: "darwin" },
    });

    expect(result.status).toBe(64);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      status: "ERROR",
      errorCode: "SCOPE_MISMATCH",
    });
    expect(result.stdout).not.toContain(canary);
    expect(result.stderr).not.toContain(canary);
  });
});
