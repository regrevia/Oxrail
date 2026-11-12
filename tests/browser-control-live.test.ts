/* Live check against a real Chrome, skipped unless OXRAIL_BROWSER_LIVE=1.
 *
 * The unit tests use fakes; this file is the only place that proves the whole
 * path (spawn → CDP → page walk → pointer input → screenshot → reclaim) works
 * on a machine that actually has a browser installed. Kept opt-in so CI and
 * `pnpm test` stay hermetic.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  chromeBinary,
  profileDir,
} from "../packages/browser-control/src/chrome.js";
import { CdpBrowserRoute } from "../packages/browser-control/src/route.js";
import { RouteClosedError } from "../packages/browser-control/src/types.js";

const live = process.env.OXRAIL_BROWSER_LIVE === "1";
const hasChrome = (() => {
  try {
    chromeBinary();
    return true;
  } catch {
    return false;
  }
})();

const page = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><title>Oxrail control</title></head>
<body>
  <h1>Rendered by the opt-in route</h1>
  <button id="b" onclick="document.title='clicked'">Press me</button>
  <input id="i" placeholder="type here" oninput="document.title=this.value">
  <a href="data:text/html,<title>second</title><p>second page</p>">second</a>
</body></html>`)}`;

describe.skipIf(!live || !hasChrome)("Browser Control live", () => {
  it(
    "opens a page, reads it, clicks, types, shoots and closes",
    { timeout: 90_000 },
    async () => {
      const env = {
        ...process.env,
        OXRAIL_BROWSER_HEADLESS: "1",
        OXRAIL_BROWSER_PROFILE: `live-${process.pid}-${Date.now()}`,
        OXRAIL_BROWSER_IDLE_MS: "60000",
      } as NodeJS.ProcessEnv;
      const route = new CdpBrowserRoute({ env });
      const dir = profileDir(env.OXRAIL_BROWSER_PROFILE ?? "live", env);
      try {
        const started = Date.now();
        const opened = await route.open({ url: page });
        const coldMs = Date.now() - started;
        expect(opened.running).toBe(true);
        expect(opened.pid).toBeGreaterThan(0);
        expect(opened.headless).toBe(true);
        expect(opened.url).toContain("data:text/html");
        // A cold start that takes longer than this would be a usability problem.
        expect(coldMs).toBeLessThan(20_000);

        const viewStarted = Date.now();
        const snapshot = await route.read({ maxChars: 4_000 });
        const viewMs = Date.now() - viewStarted;
        expect(snapshot.title).toBe("Oxrail control");
        expect(snapshot.text).toContain("Rendered by the opt-in route");
        expect(snapshot.controls.length).toBeGreaterThanOrEqual(3);
        const button = snapshot.controls.find(
          (control) => control.name === "Press me",
        );
        const input = snapshot.controls.find(
          (control) => control.role === "textbox",
        );
        expect(button, "numbered controls include the button").toBeDefined();
        expect(input, "numbered controls include the textbox").toBeDefined();

        if (button === undefined) throw new Error("no button control");
        await route.click({ ref: button.ref });
        expect((await route.state()).title).toBe("clicked");

        if (input === undefined) throw new Error("no textbox control");
        await route.type({ ref: input.ref, text: "hello oxrail" });
        expect((await route.state()).title).toBe("hello oxrail");

        const shot = await route.shot();
        expect(shot.png.length).toBeGreaterThan(1_000);
        expect(existsSync(shot.path)).toBe(true);

        const linked = await route.read({ mode: "links" });
        expect(linked.text).toContain("second");
        await route.click({ text: "second" });
        await route.nav({ back: true });

        const state = await route.state();
        expect(state.closesInMs).not.toBeNull();
        expect(state.idleMs).toBeGreaterThanOrEqual(0);

        const login = await route.login();
        expect(login.profile).toContain("live-");
        expect(typeof login.saved).toBe("boolean");

        const closed = await route.close();
        expect(closed.running).toBe(false);
        await expect(route.read()).rejects.toBeInstanceOf(RouteClosedError);

        // The numbers a person would want in the release note.
        console.log(
          JSON.stringify({
            coldMs,
            viewMs,
            controls: snapshot.controls.length,
            pngBytes: Math.round((shot.png.length * 3) / 4),
          }),
        );
      } finally {
        await route.close().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "reopens the same profile after a clean close",
    { timeout: 90_000 },
    async () => {
      const env = {
        ...process.env,
        OXRAIL_BROWSER_HEADLESS: "1",
        OXRAIL_BROWSER_PROFILE: `live-reopen-${process.pid}-${Date.now()}`,
        OXRAIL_BROWSER_IDLE_MS: "60000",
      } as NodeJS.ProcessEnv;
      const route = new CdpBrowserRoute({ env });
      const dir = profileDir(env.OXRAIL_BROWSER_PROFILE ?? "live", env);
      try {
        await route.open({ url: page });
        // Chrome leaves the port it used behind; the next launch must not trust it.
        expect(existsSync(join(dir, "DevToolsActivePort"))).toBe(true);
        await route.close();

        const reopened = await route.open({ url: page });
        expect(reopened.running).toBe(true);
        expect(reopened.url).toContain("data:text/html");
      } finally {
        await route.close().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "reclaims an idle browser without being asked",
    { timeout: 90_000 },
    async () => {
      const env = {
        ...process.env,
        OXRAIL_BROWSER_HEADLESS: "1",
        OXRAIL_BROWSER_PROFILE: `live-idle-${process.pid}-${Date.now()}`,
        OXRAIL_BROWSER_IDLE_MS: "60000",
      } as NodeJS.ProcessEnv;
      const route = new CdpBrowserRoute({ env });
      const dir = profileDir(env.OXRAIL_BROWSER_PROFILE ?? "live", env);
      try {
        await route.open({ url: page });
        const state = await route.state();
        expect(state.closesInMs).toBeGreaterThan(55_000);
        expect(state.closesInMs).toBeLessThanOrEqual(60_000);
        await route.close();
        expect((await route.state()).running).toBe(false);
      } finally {
        await route.close().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
