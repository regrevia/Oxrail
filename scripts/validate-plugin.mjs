import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const load = async (file) =>
  JSON.parse(await readFile(path.join(root, file), "utf8"));
const exists = async (file) =>
  access(path.join(root, file)).then(
    () => true,
    () => false,
  );
const fail = (message) => {
  console.error(`plugin validation: ${message}`);
  process.exitCode = 1;
};

const manifest = await load(".codex-plugin/plugin.json");
const pkg = await load("package.json");
const marketplace = await load(".agents/plugins/marketplace.json");

if (manifest.name !== "oxrail") fail("manifest name must be oxrail");
if (
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    manifest.version,
  )
) {
  fail("manifest version must be strict semver");
}
if (manifest.version !== pkg.version)
  fail("manifest and package versions differ");
for (const key of ["description", "skills", "interface"]) {
  if (!manifest[key]) fail(`missing manifest field ${key}`);
}
for (const field of ["skills", "composerIcon", "logo"]) {
  const value =
    field === "skills" ? manifest.skills : manifest.interface?.[field];
  if (typeof value !== "string" || !value.startsWith("./"))
    fail(`${field} must be a ./ path`);
  else if (!(await exists(value)))
    fail(`${field} path does not exist: ${value}`);
}
if (!(await exists("hooks/hooks.json")))
  fail("default hooks/hooks.json is missing");
const hooks = await load("hooks/hooks.json");
const expectedBuildStamp = ` --oxrail-build ${manifest.version}`;
for (const event of [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
]) {
  if (!Array.isArray(hooks.hooks?.[event])) fail(`missing hook event ${event}`);
}
for (const [event, groups] of Object.entries(hooks.hooks ?? {})) {
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (handler?.type !== "command") continue;
      for (const field of ["command", "commandWindows"]) {
        if (
          typeof handler[field] !== "string" ||
          !handler[field].endsWith(expectedBuildStamp)
        ) {
          fail(
            `${event} ${field} must end with the manifest build stamp${expectedBuildStamp}`,
          );
        }
      }
    }
  }
}
const entry = marketplace.plugins?.find((item) => item.name === "oxrail");
if (marketplace.name !== "oxrail" || !entry)
  fail("marketplace does not expose oxrail");
if (
  entry?.source?.source !== "url" ||
  entry?.source?.url !== "https://github.com/regrevia/Oxrail.git" ||
  entry?.source?.ref !== `v${manifest.version}`
) {
  fail("marketplace must install the manifest's immutable GitHub version tag");
}
if (
  !entry?.policy?.installation ||
  !entry?.policy?.authentication ||
  !entry?.category
) {
  fail("marketplace policy/category fields are incomplete");
}

const skill = await readFile(path.join(root, "skills/oxrail/SKILL.md"), "utf8");
if (Buffer.byteLength(skill) >= 8192 || skill.split("\n").length > 250)
  fail("SKILL.md exceeds SEC-11 limits");
if (/\[TODO:/.test(JSON.stringify(manifest)))
  fail("manifest contains scaffold placeholders");
if (!process.exitCode) console.log("plugin validation: ok");
