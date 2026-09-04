import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function pairedSchedule(testIds, seed) {
  return testIds
    .map((testId) => {
      const rank = fingerprint({ seed, testId });
      const variants =
        Number.parseInt(rank.slice(-2), 16) % 2
          ? ["oxrail", "baseline"]
          : ["baseline", "oxrail"];
      return { testId, rank, variants };
    })
    .sort((left, right) => left.rank.localeCompare(right.rank));
}

export function assertPairedInitialState(baseline, oxrail) {
  const baselineHash = fingerprint(baseline);
  const oxrailHash = fingerprint(oxrail);
  if (baselineHash !== oxrailHash) {
    throw new Error(
      `paired initial state mismatch: ${baselineHash} != ${oxrailHash}`,
    );
  }
  return baselineHash;
}
