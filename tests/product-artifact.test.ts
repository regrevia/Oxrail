import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
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

  it("verifies the exact installed product and rejects mutation", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "oxrail-integrity-"));
    const installRoot = path.join(temporary, "install");
    await cp("release/oxrail", installRoot, { recursive: true });
    await mkdir(path.join(installRoot, ".git"));
    await writeFile(
      path.join(installRoot, ".git", "HEAD"),
      "transport metadata\n",
    );

    const verified = spawnSync(
      process.execPath,
      ["skills/oxrail/scripts/verify-install.mjs"],
      { cwd: installRoot, encoding: "utf8" },
    );
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      version: "0.1.0-alpha.4",
      immutableRef: "product-v0.1.0-alpha.4",
      artifactIntegrity: "PASS",
    });

    await writeFile(
      path.join(installRoot, "hooks/hooks.json"),
      '{"mutated":true}\n',
    );
    const rejected = spawnSync(
      process.execPath,
      ["skills/oxrail/scripts/verify-install.mjs"],
      { cwd: installRoot, encoding: "utf8" },
    );
    expect(rejected.status).toBe(1);
    expect(JSON.parse(rejected.stderr)).toMatchObject({
      artifactIntegrity: "FAIL",
      code: "HASH_MISMATCH:hooks/hooks.json",
    });
  });

  it("provides a single-command trial readiness report", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "oxrail-trial-"));
    const installRoot = path.join(temporary, "install");
    const dataHome = path.join(temporary, "home");
    await cp("release/oxrail", installRoot, { recursive: true });

    const result = spawnSync(
      process.execPath,
      ["skills/oxrail/scripts/trial-check.mjs"],
      {
        cwd: installRoot,
        env: { HOME: dataHome, PATH: process.env.PATH },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: "0.1.0-alpha.4",
      artifactIntegrity: "PASS",
      stage: "INSTALLED",
      readiness: "HOST_SETUP_REQUIRED",
      optimization: "BYPASSED",
      safetyProtection: "INACTIVE",
      handoffProtection: "INACTIVE",
      credentialProtection: "INACTIVE",
    });
    await expect(readdir(path.join(dataHome, ".oxrail-lab"))).rejects.toThrow();
  });
});
