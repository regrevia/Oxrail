import type { HostProfile } from "../../protocol/src/index.js";

export type ToolClassification = "BROWSER" | "UNRELATED";

/**
 * Hook registration intentionally matches all tools. Classification is literal
 * and comes only from the current evidence-backed Host Profile.
 */
export function classifyTool(
  profile: HostProfile,
  toolName: string,
): ToolClassification {
  return profile.route.canonicalToolMatchers.includes(toolName)
    ? "BROWSER"
    : "UNRELATED";
}
