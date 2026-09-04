import type { HandoffChromeApi } from "./presenter.js";
import { runSameTabProbe, type SameTabProbeTarget } from "./probe.js";

declare const __OXRAIL_HANDOFF_PROBE_BUILD_HASH__: string;

interface ChromeActionApi {
  onClicked: {
    addListener(listener: (tab: SameTabProbeTarget) => void): void;
  };
}

interface ChromeProbeRuntime extends HandoffChromeApi {
  action: ChromeActionApi;
  runtime: {
    readonly id: string;
    getManifest(): { readonly version: string };
  };
}

const runtime = (
  globalThis as typeof globalThis & { chrome?: ChromeProbeRuntime }
).chrome;

function chromeVersion(userAgent: string): string {
  if (/\b(?:Edg|OPR|CriOS)\//.test(userAgent)) return "UNKNOWN";
  return (
    /\bChrome\/([0-9]+(?:\.[0-9]+){0,3})\b/.exec(userAgent)?.[1] ?? "UNKNOWN"
  );
}

if (runtime) {
  let running = false;
  runtime.action.onClicked.addListener((tab) => {
    if (running) return;
    running = true;
    void (async () => {
      const userAgent = globalThis.navigator?.userAgent ?? "";
      const result = await runSameTabProbe(runtime, tab, {
        browserVersion: chromeVersion(userAgent),
        buildHash: __OXRAIL_HANDOFF_PROBE_BUILD_HASH__,
        extensionId: runtime.runtime.id,
        extensionVersion: runtime.runtime.getManifest().version,
        platform: /\bMacintosh\b/.test(userAgent) ? "macOS" : "UNSUPPORTED",
        recordedAt: Date.now(),
      });
      console.info(`OXRAIL_SAME_TAB_PROBE ${JSON.stringify(result)}`);
    })().finally(() => {
      running = false;
    });
  });
}
