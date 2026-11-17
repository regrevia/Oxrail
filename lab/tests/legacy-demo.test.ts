import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const script = path.resolve("lab/scripts/legacy-demo.mjs");

describe("legacy credential fixture cleanup", () => {
  it("purges only the explicit old build cache", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "oxrail-lab-legacy-"));
    const legacy = path.join(home, ".oxrail", "credential-demo");
    const productState = path.join(home, ".oxrail", "runtime-state", "keep");
    await mkdir(legacy, { recursive: true });
    await mkdir(path.dirname(productState), { recursive: true });
    await writeFile(path.join(legacy, "fixture"), "build cache");
    await writeFile(productState, "product state");

    const result = spawnSync(process.execPath, [script, "purge-build-cache"], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      resource: "LEGACY_FIXTURE_BUILD_CACHE_ONLY",
      status: "PURGED",
      keychainTouched: false,
      productStateTouched: false,
    });
    await expect(readFile(path.join(legacy, "fixture"))).rejects.toThrow();
    await expect(readFile(productState, "utf8")).resolves.toBe("product state");
  });
});
