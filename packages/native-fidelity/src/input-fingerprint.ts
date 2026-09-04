import { deterministicDigest } from "../../protocol/src/index.js";

export interface PassThroughCheck {
  disposition:
    | "PASS_THROUGH_ORIGINAL"
    | "SEMANTIC_HINT_ONLY"
    | "BLOCK_BEFORE_EXECUTION";
  originalHash: string;
  forwardedHash: string;
  primitiveHashMatches: boolean;
}

const LOW_LEVEL_INPUT_PATH =
  /(?:^|\.)(?:x|y|pointer|coordinate|viewport|screen|frame|window|tab|mouse|button|click|drag|scroll|key|keyboard|modifier|hover|focus|screenshot|path|delta|duration|zoom|scale)(?:\.|$)/i;

function validateSemanticHintPaths(paths: readonly string[]): void {
  if (paths.some((path) => !path || LOW_LEVEL_INPUT_PATH.test(path))) {
    throw new NativeInputMutationError();
  }
}

function withoutPaths(value: unknown, paths: readonly string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const clone = structuredClone(value) as Record<string, unknown>;
  for (const path of paths) {
    const parts = path.split(".");
    let current: Record<string, unknown> | undefined = clone;
    for (const part of parts.slice(0, -1)) {
      const next: unknown = current?.[part];
      current =
        next && typeof next === "object" && !Array.isArray(next)
          ? (next as Record<string, unknown>)
          : undefined;
      if (!current) break;
    }
    if (current) delete current[parts.at(-1)!];
  }
  return clone;
}

export function fingerprintNativeInput(input: unknown): string {
  return deterministicDigest("oxrail-native-input-v1", input);
}

export function checkNativeInputPassThrough(
  original: unknown,
  forwarded: unknown,
  semanticHintPaths: readonly string[] = [],
): PassThroughCheck {
  validateSemanticHintPaths(semanticHintPaths);
  const originalHash = fingerprintNativeInput(original);
  const forwardedHash = fingerprintNativeInput(forwarded);
  if (originalHash === forwardedHash) {
    return {
      disposition: "PASS_THROUGH_ORIGINAL",
      originalHash,
      forwardedHash,
      primitiveHashMatches: true,
    };
  }
  const primitiveHashMatches =
    fingerprintNativeInput(withoutPaths(original, semanticHintPaths)) ===
    fingerprintNativeInput(withoutPaths(forwarded, semanticHintPaths));
  return {
    disposition: primitiveHashMatches
      ? "SEMANTIC_HINT_ONLY"
      : "BLOCK_BEFORE_EXECUTION",
    originalHash,
    forwardedHash,
    primitiveHashMatches,
  };
}

export class NativeInputMutationError extends Error {
  constructor() {
    super("Oxrail refused an unauthorized Native Computer Use input mutation");
    this.name = "NativeInputMutationError";
  }
}

export function assertNativeInputPassThrough(
  original: unknown,
  forwarded: unknown,
  semanticHintPaths: readonly string[] = [],
): PassThroughCheck {
  const result = checkNativeInputPassThrough(
    original,
    forwarded,
    semanticHintPaths,
  );
  if (result.disposition === "BLOCK_BEFORE_EXECUTION")
    throw new NativeInputMutationError();
  return result;
}
