export interface WorkflowCacheKey {
  sessionId: string;
  taskId: string;
  hostProfileId: string;
  browserPath: string;
  topOrigin: string;
  routePattern: string;
  documentFingerprint: string;
  goalSignature: string;
  schemaVersion: number;
  rankingVersion: string;
  revision: number;
  targetCacheEpoch: number;
}

export interface WorkflowRecipe {
  recipeVersion: number;
  goalSignature: string;
  originPattern: string;
  routePattern: string;
  prerequisiteSignals: string[];
  targetRecipe: Array<{
    role?: string;
    namePattern?: string;
    regionPattern?: string;
    verification: string;
  }>;
  expectedPostconditions: string[];
  riskClass: string;
  invalidationRules: string[];
}

export interface CacheValidationRequest {
  currentRevision: number;
  targetCacheEpoch: number;
  reResolveTarget: true;
  revalidateRisk: true;
  verifyOriginAndRoute: true;
  verifyPrerequisites: true;
}

export interface CacheValidation {
  originMatches: boolean;
  routeMatches: boolean;
  prerequisiteSignalsMatch: boolean;
  targetResolvedRevision: number | null;
  risk: "UNCHANGED" | "APPROVAL_REQUIRED" | "HANDOFF_REQUIRED" | "INVALID";
}

export type WorkflowCacheResult =
  | {
      status: "MISS";
      reason: string;
      fallback?: "NATIVE_APPROVAL" | "HANDOFF";
    }
  | {
      status: "HIT";
      recipe: WorkflowRecipe;
      requirements: {
        nativeComputerUseExecutes: true;
        postconditionVerificationRequired: true;
        riskRevalidated: true;
        targetReResolvedOnRevision: number;
      };
    };

interface Entry {
  expiresAt: number;
  key: WorkflowCacheKey;
  recipe: WorkflowRecipe;
}

const keyFields = [
  "sessionId",
  "taskId",
  "hostProfileId",
  "browserPath",
  "topOrigin",
  "routePattern",
  "documentFingerprint",
  "goalSignature",
  "schemaVersion",
  "rankingVersion",
  "revision",
  "targetCacheEpoch",
] as const;
const recipeFields = [
  "recipeVersion",
  "goalSignature",
  "originPattern",
  "routePattern",
  "prerequisiteSignals",
  "targetRecipe",
  "expectedPostconditions",
  "riskClass",
  "invalidationRules",
] as const;
const targetFields = [
  "role",
  "namePattern",
  "regionPattern",
  "verification",
] as const;
const validationFields = [
  "originMatches",
  "routeMatches",
  "prerequisiteSignalsMatch",
  "targetResolvedRevision",
  "risk",
] as const;
const sensitiveValue =
  /(?:Bearer\s+\S+|github_pat_|gh[pousr]_|sk-[A-Za-z0-9_-]{12,}|(?:password|passwd|passcode|pwd|otp|token|cookie|authorization|credential|secret|api[_-]?key|private[_-]?key)\s*[:=])/i;

const invalidInput = (): never => {
  throw new TypeError("invalid workflow cache input");
};

function strictRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidInput();
  const record = value as object;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) invalidInput();
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(record);
  if (
    required.some((field) => !keys.includes(field)) ||
    keys.some((field) => typeof field !== "string" || !allowed.has(field))
  ) {
    invalidInput();
  }
  for (const field of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalidInput();
  }
  return record as Record<string, unknown>;
}

function stringValue(value: unknown, maximum = 512): string {
  if (typeof value !== "string") invalidInput();
  const result = value as string;
  if (
    result.length === 0 ||
    result.length > maximum ||
    result.trim() !== result ||
    /[\u0000-\u001f\u007f]/.test(result) ||
    sensitiveValue.test(result)
  ) {
    invalidInput();
  }
  return result;
}

function identifier(value: unknown): string {
  const result = stringValue(value, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(result)) invalidInput();
  return result;
}

function hash(value: unknown): string {
  if (typeof value !== "string") invalidInput();
  const result = value as string;
  if (!/^[a-f0-9]{64}$/.test(result)) invalidInput();
  return result;
}

function integer(value: unknown, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    invalidInput();
  return value as number;
}

function origin(value: unknown): string {
  const result = stringValue(value, 512);
  try {
    const parsed = new URL(result);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.origin !== result
    ) {
      invalidInput();
    }
  } catch {
    invalidInput();
  }
  return result;
}

function route(value: unknown): string {
  const result = stringValue(value, 512);
  if (!result.startsWith("/") || /[?#]/.test(result)) invalidInput();
  return result;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    invalidInput();
  const list = value as unknown[];
  return list.map((item) => stringValue(item));
}

function normalizeKey(value: unknown): WorkflowCacheKey {
  const input = strictRecord(value, keyFields);
  return {
    sessionId: identifier(input.sessionId),
    taskId: identifier(input.taskId),
    hostProfileId: identifier(input.hostProfileId),
    browserPath: identifier(input.browserPath),
    topOrigin: origin(input.topOrigin),
    routePattern: route(input.routePattern),
    documentFingerprint: hash(input.documentFingerprint),
    goalSignature: hash(input.goalSignature),
    schemaVersion: integer(input.schemaVersion, 1),
    rankingVersion: identifier(input.rankingVersion),
    revision: integer(input.revision, 0),
    targetCacheEpoch: integer(input.targetCacheEpoch, 0),
  };
}

function normalizeRecipe(
  value: unknown,
  key: WorkflowCacheKey,
): WorkflowRecipe {
  const input = strictRecord(value, recipeFields);
  if (
    !Array.isArray(input.targetRecipe) ||
    input.targetRecipe.length === 0 ||
    input.targetRecipe.length > 64
  )
    invalidInput();
  const targets = input.targetRecipe as unknown[];
  const result: WorkflowRecipe = {
    recipeVersion: integer(input.recipeVersion, 1),
    goalSignature: hash(input.goalSignature),
    originPattern: origin(input.originPattern),
    routePattern: route(input.routePattern),
    prerequisiteSignals: stringList(input.prerequisiteSignals),
    targetRecipe: targets.map((candidate) => {
      const target = strictRecord(candidate, ["verification"], targetFields);
      return {
        ...(target.role === undefined
          ? {}
          : { role: stringValue(target.role, 256) }),
        ...(target.namePattern === undefined
          ? {}
          : { namePattern: stringValue(target.namePattern, 256) }),
        ...(target.regionPattern === undefined
          ? {}
          : { regionPattern: stringValue(target.regionPattern, 256) }),
        verification: stringValue(target.verification, 256),
      };
    }),
    expectedPostconditions: stringList(input.expectedPostconditions),
    riskClass: identifier(input.riskClass),
    invalidationRules: stringList(input.invalidationRules),
  };
  if (
    result.goalSignature !== key.goalSignature ||
    result.originPattern !== key.topOrigin ||
    result.routePattern !== key.routePattern
  ) {
    invalidInput();
  }
  return result;
}

function normalizeValidation(value: unknown): CacheValidation {
  const input = strictRecord(value, validationFields);
  if (
    typeof input.originMatches !== "boolean" ||
    typeof input.routeMatches !== "boolean" ||
    typeof input.prerequisiteSignalsMatch !== "boolean" ||
    (input.targetResolvedRevision !== null &&
      (!Number.isSafeInteger(input.targetResolvedRevision) ||
        (input.targetResolvedRevision as number) < 0)) ||
    !["UNCHANGED", "APPROVAL_REQUIRED", "HANDOFF_REQUIRED", "INVALID"].includes(
      input.risk as string,
    )
  ) {
    invalidInput();
  }
  return {
    originMatches: input.originMatches as boolean,
    routeMatches: input.routeMatches as boolean,
    prerequisiteSignalsMatch: input.prerequisiteSignalsMatch as boolean,
    targetResolvedRevision: input.targetResolvedRevision as number | null,
    risk: input.risk as CacheValidation["risk"],
  };
}

const cacheKey = (key: WorkflowCacheKey): string =>
  JSON.stringify([
    key.sessionId,
    key.taskId,
    key.hostProfileId,
    key.browserPath,
    key.topOrigin,
    key.routePattern,
    key.documentFingerprint,
    key.goalSignature,
    key.schemaVersion,
    key.rankingVersion,
    key.revision,
    key.targetCacheEpoch,
  ]);

export class WorkflowCache {
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options: {
    ttlMs: number;
    maxEntries?: number;
    now?: () => number;
  }) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) invalidInput();
    const maxEntries = options.maxEntries ?? 256;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) invalidInput();
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = maxEntries;
    this.#now = options.now ?? Date.now;
  }

  #time(): number {
    let value: unknown = undefined;
    try {
      value = this.#now();
    } catch {
      invalidInput();
    }
    if (typeof value !== "number" || !Number.isFinite(value)) invalidInput();
    return value as number;
  }

  put(key: WorkflowCacheKey, recipe: WorkflowRecipe): void {
    const normalizedKey = normalizeKey(key);
    const normalizedRecipe = normalizeRecipe(recipe, normalizedKey);
    const expiresAt = this.#time() + this.#ttlMs;
    if (!Number.isFinite(expiresAt)) invalidInput();
    const id = cacheKey(normalizedKey);
    this.#entries.delete(id);
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    this.#entries.set(id, {
      expiresAt,
      key: normalizedKey,
      recipe: normalizedRecipe,
    });
  }

  invalidateForHandoff(sessionId: string): void {
    const normalizedSessionId = identifier(sessionId);
    for (const [id, entry] of this.#entries) {
      if (entry.key.sessionId === normalizedSessionId) this.#entries.delete(id);
    }
  }

  lookup(
    key: WorkflowCacheKey,
    validate: (
      recipe: WorkflowRecipe,
      request: CacheValidationRequest,
    ) => CacheValidation,
  ): WorkflowCacheResult {
    let normalizedKey: WorkflowCacheKey;
    try {
      normalizedKey = normalizeKey(key);
    } catch {
      return { status: "MISS", reason: "INVALID_KEY" };
    }
    const entry = this.#entries.get(cacheKey(normalizedKey));
    if (!entry) return { status: "MISS", reason: "NOT_FOUND" };
    let now: number;
    try {
      now = this.#time();
    } catch {
      this.#entries.clear();
      return { status: "MISS", reason: "CLOCK_INVALID" };
    }
    if (now >= entry.expiresAt) {
      this.#entries.delete(cacheKey(normalizedKey));
      return { status: "MISS", reason: "EXPIRED" };
    }

    let validation: CacheValidation;
    try {
      validation = normalizeValidation(
        validate(structuredClone(entry.recipe), {
          currentRevision: normalizedKey.revision,
          targetCacheEpoch: normalizedKey.targetCacheEpoch,
          reResolveTarget: true,
          revalidateRisk: true,
          verifyOriginAndRoute: true,
          verifyPrerequisites: true,
        }),
      );
    } catch {
      return { status: "MISS", reason: "VALIDATION_FAILED" };
    }
    if (validation.risk === "APPROVAL_REQUIRED") {
      return {
        status: "MISS",
        reason: "RISK_CHANGED",
        fallback: "NATIVE_APPROVAL",
      };
    }
    if (validation.risk === "HANDOFF_REQUIRED") {
      return {
        status: "MISS",
        reason: "RISK_CHANGED",
        fallback: "HANDOFF",
      };
    }
    if (
      !validation.originMatches ||
      !validation.routeMatches ||
      !validation.prerequisiteSignalsMatch ||
      validation.targetResolvedRevision !== normalizedKey.revision ||
      validation.risk !== "UNCHANGED"
    ) {
      return { status: "MISS", reason: "VALIDATION_FAILED" };
    }

    return {
      status: "HIT",
      recipe: structuredClone(entry.recipe),
      requirements: {
        nativeComputerUseExecutes: true,
        postconditionVerificationRequired: true,
        riskRevalidated: true,
        targetReResolvedOnRevision: normalizedKey.revision,
      },
    };
  }
}
