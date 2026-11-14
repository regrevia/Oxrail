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

// Anchoring collection on one section or one heading shape is how the index
// drifted: the catalogue writes `### WP-...` headings and backticked test ids
// while the Lab contract writes `####` and bare ones, so anything outside the
// Lab block was invisible here until somebody edited the JSON by hand.
const WORK_PACKAGE = /^#{3,4} (WP-[A-Z0-9]+-\d{3}) \u2014 (.+)$/;
const TEST_ROW = /^\| `?(TEST-[A-Z0-9]+-\d{3})`? \| (.+?) \| (.+?) \|$/;

// The heading says only what a package is called. Everything the index is
// actually read for -- milestone, priority, status, dependencies -- is in the
// metadata table underneath, so the table is read too. A row value may wrap
// onto further lines, and a cell may be `None`; both are handled before use.
const META_ROW = /^\|\s*([A-Za-z][A-Za-z ]*?)\s*\|(.*)$/;
const NOTHING = /^(None|N\/A|—|-|无)$/;
const META_FIELDS = {
  Milestone: "milestone",
  Priority: "priority",
  Status: "status",
  Depends: "depends_on",
};
const bare = (text) => text.replaceAll("`", "").trim();
const STABLE_ID = String.raw`\b(?:SEC-\d{2}|REQ-[A-Z0-9]+-\d{3}|GATE-G\d+|KILL-K\d+|WP-[A-Z0-9]+-\d{3}|TEST-(?:[A-Z0-9]+-)+\d{3}|BENCH-(?:\d{3}|[A-Z][A-Z0-9]*)|HR-\d{2}|EVID-[A-Z0-9]+-\d{3}|ADR-[A-Z0-9]+-\d{3})\b`;

// A work package block is five `**...**` sections; the prose the index wants
// is one bullet list each, plus a lead paragraph. Reading them means a package
// that appears in a new spec section comes back whole instead of as a stub.
function proseOf(block) {
  const sections = {};
  let current;
  for (const line of block) {
    const heading = line.match(/^\*\*(.+?)\*\*$/);
    if (heading !== null) {
      current = heading[1];
      sections[current] = [];
    } else if (current !== undefined) {
      sections[current].push(line);
    }
  }
  return sections;
}

function bullets(section) {
  const items = [];
  for (const line of section) {
    const opening = line.match(/^\s*- (?:\[[ x]\] )?(.*)$/);
    if (opening !== null) items.push(opening[1].trim());
    else if (items.length !== 0 && line.trim() !== "" && /^\s{2,}\S/.test(line))
      items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

function readProse(sections) {
  const lead = (sections["目标"] ?? []).join("\n").trim();
  return {
    goal: lead
      .split(/\n\s*\n/)[0]
      .replace(/\n/g, " ")
      .trim(),
    deliverables: bullets(sections["产物"] ?? []),
    acceptance: bullets(sections["验收"] ?? []),
    blockers: bullets(sections["阻断 / Kill"] ?? []),
    tests: idsIn((sections["测试 / 证据"] ?? []).join("\n")).filter((id) =>
      /^(TEST|BENCH|HR)-/.test(id),
    ),
  };
}

function idsIn(text) {
  const found = text.match(new RegExp(STABLE_ID, "g")) ?? [];
  return [...new Set(found)];
}

function relatedRow(block) {
  for (const [label, value] of metaRows(block)) {
    if (label === "Related") return value;
  }
  return undefined;
}

// `| Depends | ... |` and friends; a cell can wrap, so a row continues until a
// line that ends with the closing pipe.
function* metaRows(block) {
  for (let at = 0; at < block.length; at += 1) {
    const first = block[at].match(META_ROW);
    if (first === null) continue;
    let value = first[2];
    while (!value.trimEnd().endsWith("|") && at + 1 < block.length) {
      at += 1;
      value += ` ${block[at].trim()}`;
    }
    yield [first[1], value.replace(/\|\s*$/, "").trim()];
  }
}

const heads = [];
lines.forEach((line, offset) => {
  const match = line.match(WORK_PACKAGE);
  if (match !== null) heads.push({ id: match[1], title: match[2], at: offset });
});

const collectedWork = new Set();
const collectedTest = new Set();
const addedWork = [];
const addedTest = [];

// A block ends at the next work package or at any shallower heading, whichever
// comes first: the last package in a section is followed by `## 49.18`, and
// without that bound its body would swallow the rest of the document.

for (const [position, head] of heads.entries()) {
  const next = heads[position + 1]?.at ?? lines.length;
  let end = next;
  for (let at = head.at + 1; at < next; at += 1) {
    if (/^#{2,4} /.test(lines[at])) {
      end = at;
      break;
    }
  }
  const block = lines.slice(head.at, end);
  collectedWork.add(head.id);

  // The block states its goal, deliverables, acceptance and kill criteria in
  // full, so those are read every time: the index follows the spec instead of
  // holding a paraphrase that drifts from it. The block is lossy only for
  // `tests` and `related_ids` -- the index legitimately carries ids its own
  // lists omit -- so a present entry keeps those two as it has them.
  const fresh = index.work_packages[head.id] === undefined;
  const entry = (index.work_packages[head.id] ??= {});
  if (fresh) addedWork.push(head.id);

  entry.anchor = head.id.toLowerCase();
  entry.title = head.title;
  const prose = readProse(proseOf(block));
  entry.goal = prose.goal;
  entry.deliverables = prose.deliverables;
  entry.acceptance = prose.acceptance;
  entry.blockers = prose.blockers;
  entry.tests ??= prose.tests;
  entry.related_ids ??= idsIn(relatedRow(block) ?? "");

  // The metadata table is the spec's own statement, so it is always applied.
  for (const [label, value] of metaRows(block)) {
    const field = META_FIELDS[label];
    if (field === undefined) continue;
    if (field === "depends_on") {
      entry.depends_on = value
        .split(",")
        .map(bare)
        .filter((id) => id !== "" && NOTHING.test(id) === false);
    } else if (NOTHING.test(bare(value)) === false) {
      entry[field] = bare(value);
    }
  }
  entry.depends_on ??= [];
}

for (const line of lines) {
  const test = line.match(TEST_ROW);
  if (test === null || collectedTest.has(test[1])) continue;
  collectedTest.add(test[1]);
  const fresh = index.tests[test[1]] === undefined;
  const entry = (index.tests[test[1]] ??= {});
  if (fresh) addedTest.push(test[1]);
  entry.title = test[2];
  entry.expected = test[3];
}

// The Lab contract only says which package comes after which; it carries no
// metadata table, so those entries are the one place this script authors
// fields rather than reading them.
for (const id of collectedWork) {
  if (!id.startsWith("WP-LAB-")) continue;
  const number = Number(id.slice(-3));
  index.work_packages[id] = {
    anchor: id.toLowerCase(),
    title: index.work_packages[id].title,
    status: "READY",
    depends_on:
      number === 0
        ? []
        : number === 7
          ? Array.from(
              { length: 6 },
              (_, offset) => `WP-LAB-${String(offset + 1).padStart(3, "0")}`,
            )
          : [`WP-LAB-${String(number - 1).padStart(3, "0")}`],
  };
}

// Every work package is a heading, so an entry this pass did not see is one the
// spec no longer has, and keeping it would leave a ghost pointing at a stale
// line range. Tests are not pruned the same way: they are also named from
// bullets and Related rows that carry no title or expectation, so an entry this
// pass did not see is usually still referenced and only the row is missing.
const goneWork = Object.keys(index.work_packages).filter(
  (id) => !collectedWork.has(id),
);
for (const id of goneWork) delete index.work_packages[id];
if (goneWork.length !== 0)
  console.log(
    `dropped ${goneWork.length} work packages the spec no longer has: ${goneWork.join(", ")}`,
  );

const labStart = lines.indexOf('<a id="sec-51"></a>');
if (labStart !== -1) {
  index.sections["SEC-51"] = {
    anchor: "sec-51",
    title: "产品 Skill 与内部 Lab 分离实施合同",
  };
  index.architecture_decisions["ADR-LAB-001"] = {
    title: "产品与内部 Lab 独立交付",
    path: "docs/adr/ADR-LAB-001.md",
  };
}
if (addedWork.length !== 0 || addedTest.length !== 0)
  console.log(
    `collected ${addedWork.length} work packages and ${addedTest.length} tests the index did not have yet`,
  );

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
  // The last package in a section is followed by a plain heading rather than
  // another package, so stopping only at the next anchor would run its range to
  // the end of the document. The package's own title heading sits directly
  // under its anchor, so the search starts below it.
  const titleAt = lines.findIndex(
    (line, lineOffset) => lineOffset + 1 >= start && /^#{2,4} /.test(line),
  );
  const endIndex = lines.findIndex(
    (line, lineOffset) =>
      lineOffset > titleAt &&
      (later.some((anchor) => line === `<a id="${anchor}"></a>`) ||
        /^#{2,4} /.test(line)),
  );
  workPackage.start_line = start;
  workPackage.end_line = endIndex === -1 ? lines.length : endIndex;
}

const output = `${JSON.stringify(index, null, 2)}\n`;
await writeFile("spec/OXRAIL_SPEC_INDEX.json", output);
await writeFile("docs/generated/spec-index.json", output);
console.log(`updated spec index ${version}`);
