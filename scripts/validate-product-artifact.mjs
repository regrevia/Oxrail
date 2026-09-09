import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("release/oxrail");
const inventory = JSON.parse(
  await readFile(path.join(root, "product-files.json"), "utf8"),
);
const walk = async (directory, prefix = "") => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path.join(directory, entry.name), relative)));
    } else {
      files.push(relative);
    }
  }
  return files;
};
const actual = (await walk(root)).sort();
const expected = [...inventory.files].sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error("product artifact differs from its exact allowlist");
  console.error(JSON.stringify({ actual, expected }, null, 2));
  process.exit(1);
}
const forbidden =
  /(^|\/)(lab|benchmarks|evidence|tests?|fixtures?|demo|pilot)(\/|\.|-|$)/i;
const violations = actual.filter((file) => forbidden.test(file));
if (violations.length > 0) {
  console.error(`forbidden product artifact paths:\n${violations.join("\n")}`);
  process.exit(1);
}
console.log("product artifact allowlist: ok");
