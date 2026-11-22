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
// The sections are numbered 0..N with no gaps, and N is whatever the spec has
// rather than a constant here: a range written into this file is how SEC-51 and
// SEC-52 shipped as anchors nothing checked.
const numbered = [...anchors]
  .map((id) => id.match(/^sec-(\d+)$/))
  .filter((match) => match !== null)
  .map((match) => Number(match[1]))
  .sort((left, right) => left - right);
for (let number = 0; number <= numbered.length - 1; number += 1) {
  if (numbered[number] !== number)
    failures.push(
      `section anchors are not 0..${numbered.length - 1}: no sec-${String(number).padStart(2, "0")}`,
    );
}
for (const [id, section] of Object.entries(index.sections)) {
  const number = Number(id.slice(4));
  if (section.number !== number)
    failures.push(`${id} says it is section ${section.number}`);
  if (typeof section.title !== "string" || section.title.trim() === "")
    failures.push(`${id} has no title`);
}
// A section states how it wants to be found in one line under its heading, so
// the index is checked against that line instead of the line against a copy.
const marks = new Map();
// The line belongs to the section whose anchor it sits under, which is the
// anchor and then one `# N. Title` heading and nothing else in between: with a
// bare "the last anchor I saw" rule a section that lost its anchor silently
// donated its own line to the section above it.
let held;
let headed = false;
for (const line of canonical.split("\n")) {
  const anchored = line.match(/^<a id="(sec-\d+)"><\/a>$/);
  if (anchored !== null) {
    held = anchored[1];
    headed = false;
  } else if (/^# \d+\. /.test(line) && held !== undefined) {
    if (headed) held = undefined;
    headed = true;
  }
  const mark = line.match(/^<!-- oxrail-index: (.+) -->$/);
  if (mark === null || held === undefined || !headed) continue;
  marks.set(
    held,
    mark[1]
      .split(",")
      .map((word) => word.trim())
      .filter((word) => word !== ""),
  );
}
for (const [anchor, words] of marks) {
  const entry = index.sections[anchor.toUpperCase()];
  if (entry === undefined) {
    failures.push(`${anchor} has an index line but no section entry`);
    continue;
  }
  if (JSON.stringify(entry.keywords) !== JSON.stringify(words))
    failures.push(
      `${anchor} keywords are not the ones its section declares: ${entry.keywords} vs ${words}`,
    );
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

/* `counts` and `coverage` summarise collections that sit in the same file, so
   they are checkable rather than merely stated: a summary that disagrees with
   the thing it summarises is the cheapest kind of lie, and it was how 108 was
   reported for 110 work packages. Keeping the check here means a hand edit
   cannot pass, and the generator is the only way to move the numbers. */
const counted = (value) =>
  value === undefined || value === null
    ? 0
    : Array.isArray(value)
      ? value.length
      : Object.keys(value).length;
const totals = {
  sections: counted(index.sections),
  requirements: counted(index.requirements),
  gates: counted(index.gates),
  kill_criteria: counted(index.kill_criteria),
  work_packages: counted(index.work_packages),
  tests: counted(index.tests),
  evidence_ids: counted(index.evidence),
  adrs: counted(index.architecture_decisions),
};
for (const [field, actual] of Object.entries(totals)) {
  const stated = index.counts?.[field];
  if (stated !== actual)
    failures.push(
      `index counts.${field} says ${stated}, the collection holds ${actual}`,
    );
}
const nonEmpty = (value) => counted(value) > 0;
const wired = (entries, field) =>
  Object.values(entries ?? {}).filter((entry) => nonEmpty(entry[field] ?? []))
    .length;
const derivedCoverage = {
  requirements_with_primary_work_packages: wired(
    index.requirements,
    "primary_work_packages",
  ),
  requirements_with_linked_tests: wired(index.requirements, "linked_tests"),
  gates_with_work_packages: wired(index.gates, "work_packages"),
  kill_criteria_with_work_packages: wired(index.kill_criteria, "work_packages"),
};
for (const [field, actual] of Object.entries(derivedCoverage)) {
  const stated = index.coverage?.[field];
  if (stated !== actual)
    failures.push(
      `index coverage.${field} says ${stated}, the index derives ${actual}`,
    );
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`spec validation: ok (${version}, ${hash})`);
