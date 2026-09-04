import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const canonical = await readFile("spec/OXRAIL_SPEC.md", "utf8");
const lines = canonical.split("\n");
const index = JSON.parse(await readFile("spec/OXRAIL_SPEC_INDEX.json", "utf8"));
const version = canonical.match(/唯一实现规范（SPEC）v([^\s]+)/)?.[1];
if (!version) throw new Error("missing spec version");

index.spec_version = version;
index.spec_sha256 = createHash("sha256")
  .update(Buffer.from(canonical))
  .digest("hex");
index.generated_at = new Date().toISOString().slice(0, 10);

const locations = (id) =>
  lines.flatMap((line, offset) =>
    new RegExp(
      `(^|[^A-Z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z0-9-]|$)`,
    ).test(line)
      ? [offset + 1]
      : [],
  );
const groups = [
  "requirements",
  "gates",
  "kill_criteria",
  "tests",
  "evidence",
  "architecture_decisions",
];
for (const group of groups) {
  for (const [id, value] of Object.entries(index[group] ?? {}))
    value.locations = locations(id);
}

const sectionEntries = Object.entries(index.sections);
for (let offset = 0; offset < sectionEntries.length; offset += 1) {
  const [, section] = sectionEntries[offset];
  const start =
    lines.findIndex((line) => line === `<a id="${section.anchor}"></a>`) + 1;
  const next = sectionEntries[offset + 1]?.[1];
  const end = next
    ? lines.findIndex((line) => line === `<a id="${next.anchor}"></a>`)
    : lines.length;
  section.start_line = start;
  section.end_line = end;
}
const workEntries = Object.entries(index.work_packages);
for (let offset = 0; offset < workEntries.length; offset += 1) {
  const [, workPackage] = workEntries[offset];
  const start =
    lines.findIndex((line) => line === `<a id="${workPackage.anchor}"></a>`) +
    1;
  const later = workEntries.slice(offset + 1).map(([, value]) => value.anchor);
  const endIndex = lines.findIndex(
    (line, lineOffset) =>
      lineOffset + 1 > start &&
      later.some((anchor) => line === `<a id="${anchor}"></a>`),
  );
  workPackage.start_line = start;
  workPackage.end_line = endIndex === -1 ? lines.length : endIndex;
}

const output = `${JSON.stringify(index, null, 2)}\n`;
await writeFile("spec/OXRAIL_SPEC_INDEX.json", output);
await writeFile("docs/generated/spec-index.json", output);
console.log(`updated spec index ${version}`);
