import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const files = [];
const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      [".git", "node_modules", "dist", "coverage", "spec"].includes(entry.name)
    )
      continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (
      /\.(?:ts|mjs|json|md|ya?ml)$/.test(entry.name) &&
      entry.name !== "SPEC.md"
    )
      files.push(file);
  }
};
await walk(".");

const failures = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  if (/[ \t]+$/m.test(text)) failures.push(`${file}: trailing whitespace`);
  if (/\r\n/.test(text)) failures.push(`${file}: CRLF line endings`);
  if (
    file.startsWith("packages/") &&
    /from ["'](?:@playwright\/test|playwright|puppeteer|chrome-remote-interface)/.test(
      text,
    )
  ) {
    failures.push(
      `${file}: production package imports a browser writer/test driver`,
    );
  }
}
const hooks = await readFile("hooks/hooks.json", "utf8");
for (const forbidden of [
  '"permissionDecision": "ask"',
  "updatedMCPToolOutput",
  "suppressOutput",
  "dangerously-bypass-hook-trust",
]) {
  if (hooks.includes(forbidden))
    failures.push(`hooks/hooks.json: forbidden ${forbidden}`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`lint: ok (${files.length} files)`);
