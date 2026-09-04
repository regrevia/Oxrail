import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const [target = ".", canary = process.env.OXRAIL_CANARY] =
  process.argv.slice(2);
const hits = [];
const walk = async (entryPath) => {
  const entries = await readdir(entryPath, { withFileTypes: true });
  for (const entry of entries) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const file = path.join(entryPath, entry.name);
    if (entry.isDirectory()) await walk(file);
    else {
      const content = await readFile(file).catch(() => null);
      if (content?.includes(Buffer.from(canary))) hits.push(file);
    }
  }
};
const trackedRaw = spawnSync("git", ["ls-files", ":(glob)evidence/**/raw/**"], {
  encoding: "utf8",
});
if (trackedRaw.status !== 0)
  throw new Error("could not inspect tracked evidence");
if (trackedRaw.stdout.trim()) {
  console.error(
    `raw evidence must not be tracked: ${trackedRaw.stdout.trim()}`,
  );
  process.exit(1);
}
if (canary) await walk(target);
if (hits.length) {
  console.error(`secret canary found in ${hits.join(", ")}`);
  process.exit(1);
}
console.log(`secret scan: clean${canary ? "" : " (tracked raw paths)"}`);
