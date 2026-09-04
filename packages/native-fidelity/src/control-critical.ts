import {
  ControlCriticalContractSchema,
  type ControlCriticalContract,
} from "../../protocol/src/index.js";

export function resultTransformationAllowed(input: unknown): boolean {
  const contract: ControlCriticalContract =
    ControlCriticalContractSchema.parse(input);
  return (
    contract.verdict === "PASS" &&
    contract.originalResultTiming === "PRE_MODEL_PROVEN" &&
    contract.rules.length > 0 &&
    contract.rules.every((rule) => rule.criticality !== "UNKNOWN")
  );
}
