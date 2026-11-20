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

/* A tool result carries text parts and image parts; only the text answers the
   display question, so read that rather than narrowing at each call site. */
function textOf(result: { content: readonly { type: string }[] }): string {
  return result.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

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
    "refuses to click a control a layer covers, and clicks the reachable one",
    { timeout: 90_000 },
    async () => {
      const env = {
        ...process.env,
        OXRAIL_BROWSER_HEADLESS: "1",
        OXRAIL_BROWSER_PROFILE: `live-covered-${process.pid}-${Date.now()}`,
        OXRAIL_BROWSER_IDLE_MS: "60000",
      } as NodeJS.ProcessEnv;
      const route = new CdpBrowserRoute({ env });
      const dir = profileDir(env.OXRAIL_BROWSER_PROFILE ?? "live", env);
      const covered = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><title>fired:</title></head>
<body>
  <button id="under" onclick="document.title += ',under'">Hidden action</button>
  <button id="free" onclick="document.title += ',free'">Free action</button>
  <div id="sheet" style="position:fixed;inset:0;z-index:99;background:#fff">
    <button onclick="document.title += ',sheet'; this.parentNode.remove()">Dismiss</button>
  </div>
</body></html>`)}`;
      try {
        await route.open({ url: covered });
        const snapshot = await route.read();
        const under = snapshot.controls.find(
          (control) => control.name === "Hidden action",
        );
        const free = snapshot.controls.find(
          (control) => control.name === "Free action",
        );
        const dismiss = snapshot.controls.find(
          (control) => control.name === "Dismiss",
        );
        expect(under, "the covered control is still numbered").toBeDefined();
        if (under === undefined) throw new Error("no covered control");
        if (free === undefined) throw new Error("no free control");
        if (dismiss === undefined) throw new Error("no dismiss control");

        // A covered control must not report success while the page hears nothing.
        await expect(route.click({ ref: under.ref })).rejects.toThrow(
          /behind/u,
        );
        expect((await route.state()).title).toBe("fired:");

        await route.click({ ref: dismiss.ref });
        expect((await route.state()).title).toBe("fired:,sheet");

        // The sheet is gone, so the control it covered is now clickable.
        await route.click({ text: "Free action" });
        expect((await route.state()).title).toBe("fired:,sheet,free");
      } finally {
        await route.close().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "types into a control the read numbered and the caller focused",
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
      /* The legitimate shape: read, click the field the read numbered, then
         type without a number. The gate must let this through. */
      const form = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><title>typed</title></head>
<body>
  <input id="f" placeholder="email" oninput="document.title=this.value||'empty'">
</body></html>`)}`;
      try {
        await route.open({ url: form });
        const read = await route.read({ maxChars: 2_000 });
        const field = read.controls.find((c) => c.role === "textbox");
        if (field === undefined) throw new Error("no textbox control");
        await route.click({ ref: field.ref });
        await route.type({ text: "hello@example.test" });
        expect((await route.state()).title).toBe("hello@example.test");
      } finally {
        await route.close().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "refuses to type into a control the page focused on its own",
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
      /* The field is hidden when the page is read, so that read never
         numbered it; the button reveals it and the page then focuses it. The
         focus is real, and it is on a control the caller was never handed. */
      const own = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><title>self focus</title></head>
<body>
  <input id="ghost" style="display:none" oninput="document.title=this.value||'empty'">
  <button onclick="const g=document.getElementById('ghost');g.style.display='block';g.focus()">Reveal</button>
</body></html>`)}`;
      try {
        await route.open({ url: own });
        const read = await route.read({ maxChars: 2_000 });
        const reveal = read.controls.find((c) => c.name === "Reveal");
        if (reveal === undefined) throw new Error("no reveal control");
        await route.click({ ref: reveal.ref });
        await expect(route.type({ text: "should not land" })).rejects.toThrow(
          /not one the last read/u,
        );
        expect((await route.state()).title).toBe("self focus");
      } finally {
        await route.close().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "refuses to type into a control the last read did not include",
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
      /* The field is numbered by the first read, hidden for the second one, so
         it is absent from the list that second read handed out — and its number
         survives on the element. Focusing it afterwards must still be refused:
         the number is older than the read that would be trusted. */
      const hidden = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><title>stale focus</title></head>
<body>
  <input id="ghost" oninput="document.title=this.value||'empty'">
  <button id="hide" onclick="document.getElementById('ghost').style.display='none'">Hide</button>
  <button id="back" onclick="const g=document.getElementById('ghost');g.style.display='';g.focus()">Back</button>
</body></html>`)}`;
      try {
        await route.open({ url: hidden });
        const first = await route.read({ maxChars: 2_000 });
        const ghost = first.controls.find((c) => c.role === "textbox");
        if (ghost === undefined) throw new Error("no textbox in first read");
        const hide = first.controls.find((c) => c.name === "Hide");
        if (hide === undefined) throw new Error("no hide control");
        await route.click({ ref: hide.ref });

        const second = await route.read({ maxChars: 2_000 });
        expect(second.controls.every((c) => c.ref !== ghost.ref)).toBe(true);
        const back = second.controls.find((c) => c.name === "Back");
        if (back === undefined) throw new Error("no back control");
        await route.click({ ref: back.ref });

        await expect(route.type({ text: "should not land" })).rejects.toThrow(
          /not one the last read/u,
        );
        expect((await route.state()).title).toBe("stale focus");
      } finally {
        await route.close().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "captures the screenshot in the same pixel space as the click",
    { timeout: 90_000 },
    async () => {
      const env = {
        ...process.env,
        OXRAIL_BROWSER_HEADLESS: "1",
        OXRAIL_BROWSER_PROFILE: `live-pixels-${process.pid}-${Date.now()}`,
        OXRAIL_BROWSER_IDLE_MS: "60000",
      } as NodeJS.ProcessEnv;
      const route = new CdpBrowserRoute({ env });
      const dir = profileDir(env.OXRAIL_BROWSER_PROFILE ?? "live", env);
      try {
        await route.open({
          url: `data:text/html;charset=utf-8,${encodeURIComponent(
            '<!doctype html><html><head><title>pixels</title></head><body style="margin:0"><p>pixels</p></body></html>',
          )}`,
        });
        const shot = await route.shot();
        // PNG header: width and height live at bytes 16..24, big endian.
        const bytes = Buffer.from(shot.png, "base64");
        const width = bytes.readUInt32BE(16);
        const height = bytes.readUInt32BE(20);
        // The input domain uses CSS pixels, so the picture must too.
        expect(width).toBe(1280);
        expect(height).toBeGreaterThan(600);
        expect(height).toBeLessThan(1280);
      } finally {
        await route.close().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "clicks a control a smooth-scrolling page has to animate into view",
    { timeout: 90_000 },
    async () => {
      const env = {
        ...process.env,
        OXRAIL_BROWSER_HEADLESS: "1",
        OXRAIL_BROWSER_PROFILE: `live-smooth-${process.pid}-${Date.now()}`,
        OXRAIL_BROWSER_IDLE_MS: "60000",
      } as NodeJS.ProcessEnv;
      const route = new CdpBrowserRoute({ env });
      const dir = profileDir(env.OXRAIL_BROWSER_PROFILE ?? "live", env);
      const smooth = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><title>fired:</title>
<style>html{scroll-behavior:smooth}body{margin:0}</style></head>
<body>
  <button id="top" onclick="document.title += ',top'">Top action</button>
  <div style="height:4000px"></div>
  <button id="far" onclick="document.title += ',far'">Far action</button>
  <div style="height:800px"></div>
</body></html>`)}`;
      try {
        await route.open({ url: smooth });
        const snapshot = await route.read();
        const far = snapshot.controls.find(
          (control) => control.name === "Far action",
        );
        expect(far, "the far control is numbered").toBeDefined();
        if (far === undefined) throw new Error("no far control");

        // scrollIntoView animates on this page, so the rect it reports right
        // after the call is the one from before the scroll: clicking there
        // reported success while the page never heard the press.
        await route.click({ ref: far.ref });
        expect((await route.state()).title).toBe("fired:,far");
      } finally {
        await route.close().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "clicks a control whose own child takes the press",
    { timeout: 90_000 },
    async () => {
      const env = {
        ...process.env,
        OXRAIL_BROWSER_HEADLESS: "1",
        OXRAIL_BROWSER_PROFILE: `live-child-${process.pid}-${Date.now()}`,
        OXRAIL_BROWSER_IDLE_MS: "60000",
      } as NodeJS.ProcessEnv;
      const route = new CdpBrowserRoute({ env });
      const dir = profileDir(env.OXRAIL_BROWSER_PROFILE ?? "live", env);
      const nested = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><title>fired:</title></head>
<body>
  <button id="nested" onclick="document.title += ',nested'"
          style="padding:0;border:0;background:none">
    <span style="display:block;padding:14px">Nested label</span>
  </button>
</body></html>`)}`;
      try {
        await route.open({ url: nested });
        const snapshot = await route.read();
        const nestedControl = snapshot.controls.find(
          (control) => control.name === "Nested label",
        );
        if (nestedControl === undefined) throw new Error("no nested control");
        // The press lands on the span and bubbles to the button: refusing here
        // would be a false positive that blocks a working control.
        await route.click({ ref: nestedControl.ref });
        expect((await route.state()).title).toBe("fired:,nested");
      } finally {
        await route.close().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "shows the window unless the caller asks for headless",
    { timeout: 90_000 },
    async () => {
      // The default is the half that matters: a browser nobody can see makes a
      // wrong page look like a wrong reading, so visible is the default and
      // headless has to be asked for. Both directions run against a real
      // window, because a unit test cannot tell a flag from a flag that works.
      const shown = {
        ...process.env,
        OXRAIL_BROWSER_PROFILE: `live-shown-${process.pid}-${Date.now()}`,
        OXRAIL_BROWSER_IDLE_MS: "60000",
      } as NodeJS.ProcessEnv;
      delete shown.OXRAIL_BROWSER_HEADLESS;
      const route = new CdpBrowserRoute({ env: shown });
      const dir = profileDir(shown.OXRAIL_BROWSER_PROFILE ?? "live", shown);
      try {
        const opened = await route.open({ url: page });
        expect(opened.headless).toBe(false);
        expect((await route.state()).headless).toBe(false);

        // A one-shot override hides this window, and the report describes the
        // window that exists rather than the setting that asked for it.
        await route.close();
        const hidden = await route.open({ url: page, headless: true });
        expect(hidden.headless).toBe(true);
        expect((await route.state()).headless).toBe(true);

        // The standing choice is untouched: reopening without the override
        // shows a window again, which is the part a one-shot must not change.
        await route.close();
        expect((await route.open({ url: page })).headless).toBe(false);

        // Switching on a running browser keeps the page it was on.
        await route.close();
        await route.open({ url: page });
        const switched = await route.mode({ display: "headless" });
        const said = textOf(switched);
        expect(said).toContain("hidden now");
        const after = await route.state();
        expect(after.headless).toBe(true);
        expect(after.running).toBe(true);
        expect(after.url).toContain("data:text/html");

        const back = await route.mode({ display: "visible" });
        expect(textOf(back)).toContain("shown now");
        expect((await route.state()).headless).toBe(false);
        expect((await route.state()).url).toContain("data:text/html");
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

  it(
    "only clicks a number a read gave, and reports a stale one as stale",
    { timeout: 90_000 },
    async () => {
      const env = {
        ...process.env,
        OXRAIL_BROWSER_HEADLESS: "1",
        OXRAIL_BROWSER_PROFILE: `live-addressable-${process.pid}-${Date.now()}`,
        OXRAIL_BROWSER_IDLE_MS: "60000",
      } as NodeJS.ProcessEnv;
      const route = new CdpBrowserRoute({ env });
      const dir = profileDir(env.OXRAIL_BROWSER_PROFILE ?? "live", env);
      try {
        await route.open({ url: page });

        // A number nobody read is refused, and it does not land anywhere.
        await expect(route.click({ ref: 9999 })).rejects.toThrow(
          /browser_view/u,
        );
        expect((await route.state()).title).toBe("Oxrail control");

        const snapshot = await route.read({ maxChars: 4_000 });
        const button = snapshot.controls.find(
          (control) => control.name === "Press me",
        );
        if (button === undefined) throw new Error("no button control");
        await route.click({ ref: button.ref });
        expect((await route.state()).title).toBe("clicked");

        // The same number after a navigation addresses nothing: the page that
        // handed it out is gone, and a fresh page must not answer to it.
        await route.nav({ back: true });
        await expect(route.click({ ref: button.ref })).rejects.toThrow(
          /browser_view/u,
        );
      } finally {
        await route.close().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
