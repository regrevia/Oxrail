import { createHash } from "node:crypto";

const SENSITIVE_KEY =
  /(?:password|passwd|passcode|pwd|otp|token|cookie|authorization|credential|secret|api[_-]?key|private[_-]?key|recovery[_-]?code|clipboard|value|text|keys?|input)$/i;

function hash(domain: string, value: string): string {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(value)
    .digest("hex");
}

function canonicalize(
  value: unknown,
  redact: boolean,
  key = "",
  seen = new WeakSet<object>(),
): unknown {
  if (redact && key && SENSITIVE_KEY.test(key)) {
    return "[REDACTED]";
  }
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Only finite JSON numbers can be fingerprinted");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object")
    throw new TypeError("Only JSON-compatible values can be fingerprinted");
  if (seen.has(value))
    throw new TypeError("Cyclic values cannot be fingerprinted");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, redact) ?? null);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Only plain JSON objects can be fingerprinted");
    }
    const result: Record<string, unknown> = {};
    for (const nestedKey of Object.keys(
      value as Record<string, unknown>,
    ).sort()) {
      const nested = canonicalize(
        (value as Record<string, unknown>)[nestedKey],
        redact,
        nestedKey,
        seen,
      );
      if (nested !== undefined) result[nestedKey] = nested;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function deterministicDigest(domain: string, value: unknown): string {
  return hash(domain, JSON.stringify(canonicalize(value, false)));
}

export function redactedDeterministicDigest(
  domain: string,
  value: unknown,
): string {
  return hash(domain, JSON.stringify(canonicalize(value, true)));
}
