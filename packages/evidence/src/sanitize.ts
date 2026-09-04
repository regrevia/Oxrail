const SECRET_KEY =
  /(?:password|passwd|passcode|pwd|otp|token|cookie|authorization|credential|secret|api[_-]?key|private[_-]?key|recovery[_-]?code|clipboard|username|account|email|raw|payload|response|output|content)$/i;
const USER_OR_PAGE_TEXT_KEY =
  /(?:goalSummary|instruction|reason|siteName|label|text|name)$/;
const TOKEN_VALUE =
  /\b(?:OXRAIL_SECRET_CANARY[A-Za-z0-9_-]*|Bearer\s+[A-Za-z0-9._~+/=-]+|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{12,})\b/gi;
const SECRET_ASSIGNMENT =
  /((?:password|passwd|passcode|pwd|otp|token|secret|api[_-]?key|authorization)(?:=|:\s*|\s+))["']?[^\s,"']+/gi;
const URL = /\bhttps?:\/\/[^\s<>()"']+/gi;

function sanitizeString(value: string): string {
  return value
    .replace(TOKEN_VALUE, "[REDACTED]")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(URL, (candidate) => {
      try {
        const url = new globalThis.URL(candidate);
        return `${url.origin}${url.pathname}`;
      } catch {
        return "[REDACTED_URL]";
      }
    });
}

export function sanitizeForEvidence(
  value: unknown,
  key = "",
  seen = new WeakSet<object>(),
): unknown {
  if (SECRET_KEY.test(key) || USER_OR_PAGE_TEXT_KEY.test(key))
    return "[REDACTED]";
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Evidence only accepts finite JSON numbers");
    return value;
  }
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object")
    throw new TypeError("Evidence only accepts JSON-compatible values");
  if (seen.has(value)) throw new TypeError("Cyclic evidence is not supported");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeForEvidence(item, "", seen) ?? null);
    }
    const sanitized: Record<string, unknown> = {};
    for (const nestedKey of Object.keys(
      value as Record<string, unknown>,
    ).sort()) {
      const nested = sanitizeForEvidence(
        (value as Record<string, unknown>)[nestedKey],
        nestedKey,
        seen,
      );
      if (nested !== undefined) sanitized[nestedKey] = nested;
    }
    return sanitized;
  } finally {
    seen.delete(value);
  }
}

export function sanitizedJson(value: unknown): string {
  return `${JSON.stringify(sanitizeForEvidence(value), null, 2)}\n`;
}
