import type { SafeEvent } from "../protocol/index.js";

export type ChromePostcondition = "PASS" | "FAIL" | "UNKNOWN";
export type ChromeHookTrialVerdict =
  | "CONTROL_HOOK_NOT_OBSERVED"
  | "CHROME_ACTION_NOT_CONFIRMED"
  | "CHROME_ROUTE_NOT_OBSERVED"
  | "CHROME_ROUTE_UNCLASSIFIED"
  | "CHROME_ROUTE_OBSERVED";

const pairedCalls = (events: readonly SafeEvent[], pairId: string) => {
  const calls = new Map<
    string,
    { pre: boolean; post: boolean; alias: SafeEvent["toolAlias"]; name: string }
  >();
  for (const event of events) {
    if (event.pairId !== pairId || !event.callRef || !event.toolName) continue;
    const call = calls.get(event.callRef) ?? {
      pre: false,
      post: false,
      alias: event.toolAlias,
      name: event.toolName,
    };
    if (event.kind === "TOOL_REQUEST_OBSERVED") call.pre = true;
    if (event.kind === "TOOL_RESULT_OBSERVED") call.post = true;
    calls.set(event.callRef, call);
  }
  return [...calls.values()].filter((call) => call.pre && call.post);
};

export const classifyChromeHookTrial = (
  events: readonly SafeEvent[],
  chromePostcondition: ChromePostcondition,
) => {
  const controlPairs = pairedCalls(events, "control").filter(
    (call) => call.name === "Bash" && call.alias === "OTHER_REGISTERED",
  );
  const chromePairs = pairedCalls(events, "chrome");
  const matchedChrome = chromePairs.filter(
    (call) => call.alias === "NATIVE_BROWSER",
  );
  let verdict: ChromeHookTrialVerdict;
  if (controlPairs.length === 0) verdict = "CONTROL_HOOK_NOT_OBSERVED";
  else if (chromePostcondition !== "PASS")
    verdict = "CHROME_ACTION_NOT_CONFIRMED";
  else if (chromePairs.length === 0) verdict = "CHROME_ROUTE_NOT_OBSERVED";
  else if (matchedChrome.length === 0) verdict = "CHROME_ROUTE_UNCLASSIFIED";
  else verdict = "CHROME_ROUTE_OBSERVED";

  return {
    schemaVersion: 1 as const,
    verdict,
    controlCalls: controlPairs.length,
    chromeWindowCalls: chromePairs.length,
    matchedChromeCalls: matchedChrome.length,
    chromeToolNames: [
      ...new Set(matchedChrome.map((call) => call.name)),
    ].sort(),
    unclassifiedChromeWindowToolNames: [
      ...new Set(
        chromePairs
          .filter((call) => call.alias !== "NATIVE_BROWSER")
          .map((call) => call.name),
      ),
    ].sort(),
  };
};
