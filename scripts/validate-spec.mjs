import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const spec = await readFile("SPEC.md", "utf8");
const canonical = await readFile("spec/OXRAIL_SPEC.md", "utf8");
const index = JSON.parse(await readFile("spec/OXRAIL_SPEC_INDEX.json", "utf8"));
const generatedIndex = await readFile("docs/generated/spec-index.json", "utf8");
const canonicalIndex = await readFile("spec/OXRAIL_SPEC_INDEX.json", "utf8");
const specChecksum = await readFile("SPEC.sha256", "utf8");
const canonicalChecksum = await readFile("spec/OXRAIL_SPEC.sha256", "utf8");
const hash = createHash("sha256").update(Buffer.from(canonical)).digest("hex");
const failures = [];

if (spec !== canonical)
  failures.push("SPEC.md is not byte-identical to spec/OXRAIL_SPEC.md");
if (index.spec_sha256 !== hash)
  failures.push("spec index hash does not match the canonical spec");
if (generatedIndex !== canonicalIndex)
  failures.push(
    "docs/generated/spec-index.json is not byte-identical to the canonical index",
  );
if (specChecksum !== `${hash}  SPEC.md\n`)
  failures.push("SPEC.sha256 does not match SPEC.md");
if (canonicalChecksum !== `${hash}  spec/OXRAIL_SPEC.md\n`)
  failures.push("spec/OXRAIL_SPEC.sha256 does not match the canonical spec");
const version = canonical.match(/唯一实现规范（SPEC）v([^\s]+)/)?.[1];
if (!version || version !== index.spec_version)
  failures.push("spec header and index version differ");
if (!canonical.includes(`### v${version} —`))
  failures.push("current spec version lacks a changelog entry");

const anchors = new Set(
  [...canonical.matchAll(/<a id="([^"]+)"/g)].map((match) => match[1]),
);
for (let number = 0; number <= 50; number += 1) {
  const id = `sec-${String(number).padStart(2, "0")}`;
  if (!anchors.has(id)) failures.push(`missing section anchor ${id}`);
}
for (const href of canonical.matchAll(/\]\(#([^)]+)\)/g)) {
  if (!anchors.has(href[1]))
    failures.push(`dangling internal link #${href[1]}`);
}
for (const [id, section] of Object.entries(index.sections)) {
  if (!anchors.has(section.anchor))
    failures.push(`${id} has missing anchor ${section.anchor}`);
}

const workPackages = index.work_packages ?? {};
for (const [id, workPackage] of Object.entries(workPackages)) {
  if (!anchors.has(workPackage.anchor))
    failures.push(`${id} has missing anchor ${workPackage.anchor}`);
  for (const dependency of workPackage.depends_on ?? []) {
    if (!workPackages[dependency])
      failures.push(`${id} has unknown dependency ${dependency}`);
  }
}
const visiting = new Set();
const visited = new Set();
const visit = (id) => {
  if (visiting.has(id))
    return failures.push(`work-package dependency cycle at ${id}`);
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dependency of workPackages[id]?.depends_on ?? [])
    visit(dependency);
  visiting.delete(id);
  visited.add(id);
};
Object.keys(workPackages).forEach(visit);

const indexedIds = new Set([
  ...Object.keys(index.sections ?? {}),
  ...Object.keys(index.requirements ?? {}),
  ...Object.keys(index.gates ?? {}),
  ...Object.keys(index.kill_criteria ?? {}),
  ...Object.keys(index.work_packages ?? {}),
  ...Object.keys(index.tests ?? {}),
  ...Object.keys(index.evidence ?? {}),
  ...Object.keys(index.architecture_decisions ?? {}),
]);
const concreteId =
  /\b(?:SEC-\d{2}|REQ-[A-Z0-9]+-\d{3}|GATE-G\d+|KILL-K\d+|WP-[A-Z0-9]+-\d{3}|TEST-(?:[A-Z0-9]+-)+\d{3}|BENCH-(?:\d{3}|[A-Z][A-Z0-9]*)|HR-\d{2}|EVID-[A-Z0-9]+-\d{3}|ADR-[A-Z0-9]+-\d{3})\b/g;
for (const match of canonical.matchAll(concreteId)) {
  if (!indexedIds.has(match[0]))
    failures.push(`stable ID missing from index: ${match[0]}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`spec validation: ok (${version}, ${hash})`);
