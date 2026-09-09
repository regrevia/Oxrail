import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

describe("WP-LAB-001 product artifact", () => {
  it("stages only the declared product allowlist", async () => {
    const packaged = spawnSync(
      process.execPath,
      ["scripts/package-product.mjs"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(packaged.status, packaged.stderr).toBe(0);

    const validated = spawnSync(
      process.execPath,
      ["scripts/validate-product-artifact.mjs"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(validated.status, validated.stderr).toBe(0);

    const files = JSON.parse(
      await readFile("release/oxrail/product-files.json", "utf8"),
    ).files as string[];
    expect(files).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/lab/i),
        expect.stringMatching(/benchmark/i),
        expect.stringMatching(/evidence/i),
        expect.stringMatching(/credential.*demo/i),
        expect.stringMatching(/pilot/i),
      ]),
    );
  });

  it("runs doctor after the source tree and Lab are absent", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "oxrail-product-"));
    const installRoot = path.join(temporary, "install");
    const dataHome = path.join(temporary, "home");
    await cp("release/oxrail", installRoot, { recursive: true });

    const result = spawnSync(process.execPath, ["dist/doctor.mjs", "--json"], {
      cwd: installRoot,
      env: {
        HOME: dataHome,
        PATH: process.env.PATH,
        PLUGIN_ROOT: installRoot,
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      stage: "INSTALLED",
      optimization: "BYPASSED",
      safetyProtectionActive: false,
      handoffProtectionActive: false,
      credentialProtectionActive: false,
    });
    await expect(readdir(path.join(dataHome, ".oxrail-lab"))).rejects.toThrow();
  });
});
