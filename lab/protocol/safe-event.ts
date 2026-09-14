import { z } from "zod";

const hexRef = z.string().regex(/^[a-f0-9]{64}$/);
const boundedId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const ToolNameSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_.:-]+$/);

export const SourceSchema = z.enum([
  "HOST_HOOK",
  "HOST_TRACE",
  "FIXTURE",
  "PRODUCT_STATUS",
]);
export const GranularitySchema = z.enum([
  "TOOL_INVOCATION",
  "TRANSACTION",
  "PRIMITIVE",
  "UNKNOWN",
]);
export const EventKindSchema = z.enum([
  "TOOL_REQUEST_OBSERVED",
  "TOOL_RESULT_OBSERVED",
  "TOOL_DENIAL_CONFIRMED",
  "HANDOFF_PHASE_OBSERVED",
  "POSTCONDITION_OBSERVED",
  "SOURCE_HEALTH",
]);
export const MetricKeySchema = z.enum([
  "browserPrimitiveCount",
  "elapsedMs",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "toolCompletions",
  "toolRequests",
]);
export const MetricBasisSchema = z.enum([
  "HOST_REPORTED",
  "SAME_CLOCK_DELTA",
  "OBSERVED_EVENT_COUNT",
  "CONTROLLED_POSTCONDITION",
  "NOT_AVAILABLE",
]);
export const MissingReasonSchema = z.enum([
  "HOST_NOT_PROVIDED",
  "CLOCK_DOMAIN_UNKNOWN",
  "GRANULARITY_UNKNOWN",
  "EVENT_INCOMPLETE",
  "NOT_APPLICABLE",
]);

export const MetricSchema = z
  .object({
    value: z.number().finite().nonnegative().nullable(),
    quality: z.enum(["MEASURED", "ESTIMATED", "UNAVAILABLE"]),
    source: SourceSchema.nullable(),
    basis: MetricBasisSchema,
    missingReason: MissingReasonSchema.nullable(),
  })
  .strict()
  .superRefine((metric, context) => {
    if (metric.quality === "UNAVAILABLE" && metric.value !== null) {
      context.addIssue({
        code: "custom",
        message: "unavailable metric has value",
      });
    }
    if (metric.value === null && metric.missingReason === null) {
      context.addIssue({
        code: "custom",
        message: "missing metric lacks reason",
      });
    }
    if (metric.value !== null && metric.missingReason !== null) {
      context.addIssue({
        code: "custom",
        message: "present metric has missing reason",
      });
    }
  });

const metricsSchema = z
  .partialRecord(MetricKeySchema, MetricSchema)
  .refine((metrics) => Object.keys(metrics).length <= 7);

export const SafeEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().uuid(),
    runId: boundedId,
    pairId: boundedId.nullable(),
    source: SourceSchema,
    sourceClockId: boundedId,
    sourceSequence: z.number().int().nonnegative().safe(),
    observedMonotonicMs: z.number().finite().nonnegative().nullable(),
    receivedMonotonicMs: z.number().finite().nonnegative(),
    sessionRef: hexRef,
    callRef: hexRef.nullable(),
    actor: z.enum(["AGENT", "HUMAN", "UNKNOWN"]),
    kind: EventKindSchema,
    toolAlias: z
      .enum(["NATIVE_BROWSER", "BUILTIN_BROWSER", "OTHER_REGISTERED"])
      .nullable(),
    toolName: ToolNameSchema.nullable().optional(),
    granularity: GranularitySchema,
    outcome: z.enum(["SUCCESS", "FAILURE", "DENIED", "UNKNOWN"]),
    metrics: metricsSchema,
  })
  .strict();

export type SafeEvent = z.infer<typeof SafeEventSchema>;
