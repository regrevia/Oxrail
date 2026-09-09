import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile("dist/product-dependencies.json", "utf8"),
);
const forbidden = [
  "lab/",
  "benchmarks/",
  "lab/evidence/",
  "packages/native-fidelity/",
];
const violations = manifest.inputs.filter((input) =>
  forbidden.some((prefix) => input.startsWith(prefix)),
);
if (violations.length > 0) {
  console.error(
    `product dependency boundary violation:\n${violations.join("\n")}`,
  );
  process.exit(1);
}
console.log("product dependency boundaries: ok");
