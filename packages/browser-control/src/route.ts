/* The opt-in Browser Control route: one Chrome process we own, driven over CDP.
 *
 * This is the route the spec calls "opt-in, default-off": nothing here runs
 * unless a host explicitly configured the MCP server, and nothing here is
 * reported as Hook-visible or as a substitute for Native Computer Use. It is
 * kept in its own package so the native route never gains a CDP dependency by
 * accident.
 *
 * Three behaviours matter more than the tool list, because they are what a
 * person notices after the first hour of use:
 *   - a browser that dies at launch must fail in milliseconds, not wait out the
 *     port timeout (fixed upstream for DSH; kept here);
 *   - closing the browser must go through `Browser.close` so cookies reach the
 *     profile, otherwise every restart loses the sign-in;
 *   - an idle browser must be reclaimed, but not while the person is still
 *     watching a page the route just showed them.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CdpConnection } from "./cdp.js";
import {
  ChromeProcess,
  chromeArgs,
  profileDir,
  stateDir,
  type ChromeBinary,
} from "./chrome.js";
import {
  RouteClosedError,
  StaleRefError,
  type BrowserRoute,
  type Control,
  type LoginState,
  type OpenOptions,
  type ReadOptions,
  type RouteState,
  type Shot,
  type ShotOptions,
  type Snapshot,
  type ToolResult,
} from "./types.js";

const VIEW_WIDTH = 1280;
const VIEW_HEIGHT = 900;
const DEFAULT_MAX_CHARS = 6_000;
const DEFAULT_IDLE_MS = 5 * 60_000;
const MAX_IDLE_MS = 15 * 60_000;
const MIN_IDLE_MS = 60_000;
const LOAD_TIMEOUT_MS = 20_000;

/** Read the idle window from the environment, bounded the way `rest.js` is. */
export function idleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OXRAIL_BROWSER_IDLE_MS);
  if (!Number.isFinite(raw)) return DEFAULT_IDLE_MS;
  return Math.min(MAX_IDLE_MS, Math.max(MIN_IDLE_MS, Math.floor(raw)));
}

export function headlessFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OXRAIL_BROWSER_HEADLESS !== "0";
}

/** What a page reports about the space a screenshot and a click share. */
export interface ViewMetrics {
  readonly width: number;
  readonly height: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly documentHeight: number;
}

/**
 * The clip that puts a capture in CSS pixels, the same space `browser_click`
 * takes coordinates in. Naming the rect explicitly is the only way to do that;
 * it also makes the result independent of how far the page is scrolled, and it
 * drops the scrollbar from the width, so a full-page capture is exactly as wide
 * as the viewport.
 */
export function shotClip(
  view: ViewMetrics,
  fullPage: boolean,
): { x: number; y: number; width: number; height: number; scale: number } {
  const width = Math.max(1, Math.round(view.width));
  if (fullPage) {
    return {
      x: 0,
      y: 0,
      width,
      height: Math.max(1, Math.round(view.documentHeight)),
      scale: 1,
    };
  }
  return {
    x: Math.round(view.scrollX),
    y: Math.round(view.scrollY),
    width,
    height: Math.max(1, Math.round(view.height)),
    scale: 1,
  };
}

export function profileFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OXRAIL_BROWSER_PROFILE;
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : "default";
}

export function viewSize(env: NodeJS.ProcessEnv = process.env): {
  width: number;
  height: number;
} {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(env.OXRAIL_BROWSER_VIEW ?? "");
  if (match === null) return { width: VIEW_WIDTH, height: VIEW_HEIGHT };
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** The page walk, as one expression: it must run in the page and return JSON. */
export function snapshotExpression(options: {
  mode: "text" | "links" | "forms";
  maxChars: number;
}): string {
  const mode = JSON.stringify(options.mode);
  const maxChars = Math.max(400, Math.floor(options.maxChars));
  // Kept as a string on purpose: `read.js` in the DSH engine is the same shape,
  // and a pure expression can be unit-tested without a browser.
  return `(() => {
  const MODE = ${mode};
  const MAX_CHARS = ${maxChars};
  const MAX_CONTROLS = 160;
  const MAX_NODES = 9000;

  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (style.opacity !== "" && Number(style.opacity) < 0.05) return false;
    return true;
  };

  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim() !== "") return aria.trim();
    const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    if (text !== "") return text.slice(0, 160);
    const title = el.getAttribute("title");
    if (title && title.trim() !== "") return title.trim().slice(0, 160);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim() !== "") return placeholder.trim().slice(0, 160);
    const alt = el.getAttribute("alt");
    if (alt && alt.trim() !== "") return alt.trim().slice(0, 160);
    const value = el.value;
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 160);
    return "";
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    return "control";
  };

  let nodes = 0;
  let truncated = false;
  const clickable = document.querySelectorAll(
    'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
  );
  const controls = [];
  for (const el of clickable) {
    if (controls.length >= MAX_CONTROLS) { truncated = true; break; }
    nodes += 1;
    if (nodes > MAX_NODES) { truncated = true; break; }
    if (!visible(el)) continue;
    const name = nameOf(el);
    if (name === "" && !el.hasAttribute("contenteditable") && el.tagName.toLowerCase() !== "input") continue;
    const ref = controls.length + 1;
    el.setAttribute("data-oxrail-ref", String(ref));
    controls.push({ ref, role: roleOf(el), name, tag: el.tagName.toLowerCase() });
  }

  const body = document.body;
  let text = body ? body.innerText || "" : "";
  if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); truncated = true; }
  text = text.replace(/\\n{3,}/g, "\\n\\n").trim();

  if (MODE === "links") {
    const links = [];
    for (const el of document.querySelectorAll("a[href]")) {
      if (!visible(el)) continue;
      const name = nameOf(el);
      if (name === "") continue;
      links.push("- [" + name + "](" + el.href + ")");
      if (links.length >= 200) break;
    }
    text = links.length > 0 ? links.join("\\n") : "(no visible links)";
  }
  if (MODE === "forms") {
    const rows = [];
    for (const el of controls) {
      const node = document.querySelector('[data-oxrail-ref="' + el.ref + '"]');
      const value = node && typeof node.value === "string" ? node.value : "";
      const type = node ? (node.getAttribute("type") || "") : "";
      rows.push("[" + el.ref + "] " + el.role + (type ? ":" + type : "") + (value ? " = " + value : "") + (el.name ? " — " + el.name : ""));
    }
    text = rows.length > 0 ? rows.join("\\n") : "(no visible controls)";
  }

  return {
    url: location.href,
    title: document.title || "",
    text,
    controls,
    truncated,
  };
})()`;
}

interface PageSession {
  readonly sessionId: string;
  readonly targetId: string;
}

type EvaluateResult = {
  result?: { value?: unknown; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

/**
 * The route. One page is enough: every tool call addresses "the page", and a
 * second tab would only make the numbered controls ambiguous.
 */
export class CdpBrowserRoute implements BrowserRoute {
  private chrome: ChromeProcess | null = null;
  private cdp: CdpConnection | null = null;
  private page: PageSession | null = null;
  private readonly idleWindow: number;
  private lastUse = 0;
  private restTimer: NodeJS.Timeout | null = null;
  private readonly profile: string;
  private readonly headless: boolean;
  private readonly size: { width: number; height: number };
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options?: { env?: NodeJS.ProcessEnv }) {
    const env = options?.env ?? process.env;
    this.idleWindow = idleMs(env);
    this.profile = profileFromEnv(env);
    this.headless = headlessFromEnv(env);
    this.size = viewSize(env);
  }

  /** Tools must not interleave on one page; one queue keeps refs coherent. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private touch(): void {
    this.lastUse = Date.now();
    this.armRest();
  }

  private armRest(): void {
    if (this.restTimer !== null) clearTimeout(this.restTimer);
    this.restTimer = null;
    if (this.chrome === null) return;
    const wait = Math.max(1_000, this.lastUse + this.idleWindow - Date.now());
    this.restTimer = setTimeout(() => {
      this.restTimer = null;
      void this.close().catch(() => undefined);
    }, wait);
    this.restTimer.unref();
  }

  private async ensure(): Promise<{ cdp: CdpConnection; page: PageSession }> {
    if (this.chrome === null || this.cdp === null || this.page === null) {
      throw new RouteClosedError(
        "browser is not open; call browser_open first",
      );
    }
    return { cdp: this.cdp, page: this.page };
  }

  async open(options: OpenOptions = {}): Promise<RouteState> {
    return this.serial(async () => {
      if (this.chrome !== null && this.cdp !== null && this.page !== null) {
        if (options.url !== undefined && options.url !== "")
          await this.navigate(options.url);
        // Report where the page actually is: a caller that passed a URL must not
        // see `url: null` back from the same call.
        return this.state();
      }
      const profile = options.profile ?? this.profile;
      const headless = options.headless ?? this.headless;
      const dir = profileDir(profile);
      mkdirSync(dir, { recursive: true });
      const chrome = await ChromeProcess.launch({
        headless,
        profile,
        ...(process.env.OXRAIL_CHROME !== undefined
          ? { binaryPath: process.env.OXRAIL_CHROME }
          : {}),
        windowSize: this.size,
      });
      this.chrome = chrome;
      const cdp = await CdpConnection.connect(chrome.browserWsUrl, {
        timeoutMs: 10_000,
      });
      this.cdp = cdp;
      const page = await this.attachPage(cdp);
      this.page = page;
      this.closed = false;
      this.touch();
      if (options.url !== undefined && options.url !== "")
        await this.navigate(options.url);
      return this.state();
    });
  }

  private async attachPage(cdp: CdpConnection): Promise<PageSession> {
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    let targetId: string | null = null;
    for (let attempt = 0; attempt < 50 && targetId === null; attempt += 1) {
      const targets = await cdp.send<{
        targetInfos: Array<{ targetId: string; type: string }>;
      }>("Target.getTargets");
      const page = targets.targetInfos.find((info) => info.type === "page");
      targetId = page?.targetId ?? null;
      if (targetId === null)
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (targetId === null) {
      const created = await cdp.send<{ targetId: string }>(
        "Target.createTarget",
        { url: "about:blank" },
      );
      targetId = created.targetId;
    }
    const attached = await cdp.send<{ sessionId: string }>(
      "Target.attachToTarget",
      {
        targetId,
        flatten: true,
      },
    );
    const sessionId = attached.sessionId;
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    return { sessionId, targetId };
  }

  private async navigate(url: string): Promise<void> {
    const { cdp, page } = await this.ensure();
    const loaded = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), LOAD_TIMEOUT_MS);
      timer.unref();
      cdp.on("Page.loadEventFired", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await cdp.send("Page.navigate", { url }, page.sessionId);
    await loaded;
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const { cdp, page } = await this.ensure();
    const reply = await cdp.send<EvaluateResult>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
      page.sessionId,
    );
    if (reply.exceptionDetails !== undefined) {
      const message =
        reply.exceptionDetails.exception?.description ??
        reply.exceptionDetails.text ??
        "evaluation failed";
      throw new Error(message.split("\n")[0] ?? "evaluation failed");
    }
    return reply.result?.value as T;
  }

  async read(options: ReadOptions = {}): Promise<Snapshot> {
    return this.serial(async () => {
      await this.ensure();
      const mode = options.mode ?? "text";
      const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
      const snapshot = await this.evaluate<Snapshot>(
        snapshotExpression({ mode, maxChars }),
      );
      this.touch();
      return {
        url: snapshot.url,
        title: snapshot.title,
        text: snapshot.text,
        controls: snapshot.controls,
        truncated: snapshot.truncated === true,
      };
    });
  }

  /** Resolve a numbered control or a text match to a point that will hit it. */
  private async locate(target: {
    ref?: number;
    text?: string;
  }): Promise<{ x: number; y: number; label: string }> {
    if (target.ref !== undefined && target.text !== undefined) {
      throw new Error("give either ref or text, not both");
    }
    const expression = `(() => {
  const el = ${
    target.ref !== undefined
      ? `document.querySelector('[data-oxrail-ref="${target.ref}"]')`
      : `(() => {
    const needle = ${JSON.stringify(target.text ?? "")}.replace(/\\s+/g, " ").trim().toLowerCase();
    if (needle === "") return null;
    const all = document.querySelectorAll('a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"]');
    let best = null, bestArea = Infinity;
    for (const node of all) {
      const text = (node.innerText || node.value || node.getAttribute("aria-label") || node.getAttribute("title") || "").replace(/\\s+/g, " ").trim().toLowerCase();
      if (text === "" || !text.includes(needle)) continue;
      const box = node.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      const area = box.width * box.height;
      if (area < bestArea) { best = node; bestArea = area; }
    }
    return best;
  })()`
  };
  if (!el) return { found: false };
  el.scrollIntoView({ block: "center", inline: "center" });
  const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const box = el.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return { found: true, label, blocked: "it has no area on screen to click" };
  /* The point must be one where a real press would reach this control: an
     overlay, a sticky header or a modal owns that pixel otherwise, and clicking
     it anyway would report success while the page never heard the press. Five
     samples, centre first, so a control covered only in the middle still gets
     clicked where it is reachable. */
  const within = (value, limit) => Math.min(Math.max(value, 1), Math.max(limit - 2, 1));
  const spread = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]];
  for (const [fx, fy] of spread) {
    const x = within(box.x + box.width * fx, innerWidth);
    const y = within(box.y + box.height * fy, innerHeight);
    const hit = document.elementFromPoint(x, y);
    if (hit !== null && (hit === el || el.contains(hit) || hit.contains(el))) return { found: true, x, y, label };
  }
  const top = document.elementFromPoint(within(box.x + box.width / 2, innerWidth), within(box.y + box.height / 2, innerHeight));
  const owner = top === null
    ? "the page has nothing at that point"
    : "it is behind " + top.tagName.toLowerCase() + (top.id ? "#" + top.id : "") + (typeof top.className === "string" && top.className.trim() !== "" ? "." + top.className.trim().split(/\\s+/).slice(0, 2).join(".") : "") + " \\"" + (top.innerText || top.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 60) + "\\"";
  return { found: true, label, blocked: owner };
})()`;
    const found = await this.evaluate<{
      found: boolean;
      x?: number;
      y?: number;
      label?: string;
      blocked?: string;
    }>(expression);
    if (found.found !== true) {
      if (target.ref !== undefined)
        throw new StaleRefError(
          `the page changed; control ${target.ref} is gone — call browser_view again`,
        );
      throw new Error(
        `no visible control contains ${JSON.stringify(target.text ?? "")}`,
      );
    }
    const label = found.label ?? "";
    if (found.blocked !== undefined) {
      const named = label === "" ? "control" : JSON.stringify(label);
      throw new Error(
        found.blocked.startsWith("it has no area")
          ? `${named} cannot be clicked: ${found.blocked}.`
          : `${named} cannot be clicked because ${found.blocked}. Close or dismiss what covers it, then call browser_view and retry.`,
      );
    }
    if (found.x === undefined || found.y === undefined) {
      throw new Error(
        `${label === "" ? "control" : JSON.stringify(label)} has no reachable point on screen.`,
      );
    }
    return { x: found.x, y: found.y, label };
  }

  private async mouseClick(x: number, y: number): Promise<void> {
    const { cdp, page } = await this.ensure();
    const base = {
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
      modifiers: 0,
    };
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", ...base, buttons: 0 },
      page.sessionId,
    );
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", ...base, buttons: 1 },
      page.sessionId,
    );
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", ...base, buttons: 0 },
      page.sessionId,
    );
  }

  async click(target: { ref?: number; text?: string }): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      const box = await this.locate(target);
      await this.mouseClick(box.x, box.y);
      this.touch();
      return {
        content: [
          {
            type: "text",
            text: `clicked ${box.label === "" ? "control" : JSON.stringify(box.label)}`,
          },
        ],
      };
    });
  }

  private keyEvent(key: string): {
    key: string;
    code: string;
    keyCode: number;
    text?: string;
  } {
    const table: Record<
      string,
      { key: string; code: string; keyCode: number; text?: string }
    > = {
      Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
      Tab: { key: "Tab", code: "Tab", keyCode: 9 },
      Escape: { key: "Escape", code: "Escape", keyCode: 27 },
      Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      Delete: { key: "Delete", code: "Delete", keyCode: 46 },
      ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
      PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
      PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
      Home: { key: "Home", code: "Home", keyCode: 36 },
      End: { key: "End", code: "End", keyCode: 35 },
    };
    const named = table[key];
    if (named !== undefined) return named;
    if (key.length === 1) {
      const upper = key.toUpperCase();
      return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
    }
    throw new Error(`unknown key ${JSON.stringify(key)}`);
  }

  async key(key: string): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      const event = this.keyEvent(key);
      const { cdp, page } = await this.ensure();
      await cdp.send(
        "Input.dispatchKeyEvent",
        {
          type: "rawKeyDown",
          key: event.key,
          code: event.code,
          windowsVirtualKeyCode: event.keyCode,
          nativeVirtualKeyCode: event.keyCode,
        },
        page.sessionId,
      );
      if (event.text !== undefined) {
        await cdp.send(
          "Input.dispatchKeyEvent",
          {
            type: "char",
            text: event.text,
            key: event.key,
            code: event.code,
            windowsVirtualKeyCode: event.keyCode,
          },
          page.sessionId,
        );
      }
      await cdp.send(
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          key: event.key,
          code: event.code,
          windowsVirtualKeyCode: event.keyCode,
          nativeVirtualKeyCode: event.keyCode,
        },
        page.sessionId,
      );
      this.touch();
      return { content: [{ type: "text", text: `pressed ${key}` }] };
    });
  }

  async type(target: {
    ref?: number;
    text: string;
    submit?: boolean;
    clear?: boolean;
  }): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      if (target.ref !== undefined) {
        const ok = await this.focus(target.ref);
        if (!ok)
          throw new StaleRefError(
            `the page changed; control ${target.ref} is gone — call browser_view again`,
          );
      }
      if (target.clear === true) {
        await this.evaluate(`(() => {
  const el = document.activeElement;
  if (el && typeof el.select === "function") { el.select(); return true; }
  if (el && el.isContentEditable) { document.execCommand("selectAll"); return true; }
  return false;
})()`);
        await this.evaluate(
          `(() => { const el = document.activeElement; if (el && "value" in el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); } else if (el && el.isContentEditable) { document.execCommand("delete"); } return true; })()`,
        );
      }
      const { cdp, page } = await this.ensure();
      await cdp.send("Input.insertText", { text: target.text }, page.sessionId);
      if (target.submit === true) {
        const event = this.keyEvent("Enter");
        await cdp.send(
          "Input.dispatchKeyEvent",
          {
            type: "rawKeyDown",
            key: event.key,
            code: event.code,
            windowsVirtualKeyCode: event.keyCode,
            nativeVirtualKeyCode: event.keyCode,
          },
          page.sessionId,
        );
        await cdp.send(
          "Input.dispatchKeyEvent",
          {
            type: "char",
            text: "\r",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
          },
          page.sessionId,
        );
        await cdp.send(
          "Input.dispatchKeyEvent",
          {
            type: "keyUp",
            key: event.key,
            code: event.code,
            windowsVirtualKeyCode: event.keyCode,
          },
          page.sessionId,
        );
      }
      this.touch();
      return {
        content: [
          {
            type: "text",
            text: `typed ${target.text.length} characters${target.submit === true ? " and pressed Enter" : ""}`,
          },
        ],
      };
    });
  }

  private async focus(ref: number): Promise<boolean> {
    return this.evaluate<boolean>(`(() => {
  const el = document.querySelector('[data-oxrail-ref="${ref}"]');
  if (!el) return false;
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus();
  return document.activeElement === el;
})()`);
  }

  async nav(options: {
    url?: string;
    back?: boolean;
    reload?: boolean;
  }): Promise<RouteState> {
    return this.serial(async () => {
      await this.ensure();
      if (options.url !== undefined && options.url !== "") {
        await this.navigate(options.url);
      } else if (options.back === true) {
        await this.evaluate("history.back()");
        await this.waitIdle();
      } else if (options.reload === true) {
        const { cdp, page } = await this.ensure();
        await cdp.send("Page.reload", {}, page.sessionId);
        await this.waitIdle();
      }
      this.touch();
      return this.state();
    });
  }

  private async waitIdle(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await this.evaluate<string>("document.readyState");
      if (state === "complete") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async shot(options: ShotOptions = {}): Promise<Shot> {
    return this.serial(async () => {
      const { cdp, page } = await this.ensure();
      /* Pin the image to CSS pixels. On a screen with a device pixel ratio
         above 1 the default capture returns device pixels, so a reader that
         takes a coordinate from the picture and hands it back as a click lands
         at half the intended place. Asking for scale 1 keeps the picture and
         the input domain in one space on every display. */
      const view = await this.evaluate<ViewMetrics>(`({
  width: innerWidth,
  height: innerHeight,
  scrollX: pageXOffset,
  scrollY: pageYOffset,
  documentHeight: Math.max(document.documentElement.scrollHeight, innerHeight)
})`);
      const clip = shotClip(view, options.fullPage === true);
      const reply = await cdp.send<{ data: string }>(
        "Page.captureScreenshot",
        {
          format: "png",
          clip,
          captureBeyondViewport: true,
        },
        page.sessionId,
      );
      const dir = join(stateDir(), "shots");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `shot-${Date.now()}.png`);
      writeFileSync(path, Buffer.from(reply.data, "base64"));
      this.touch();
      return { png: reply.data, path };
    });
  }

  private stateSync(): RouteState {
    const running =
      this.chrome !== null && this.cdp !== null && this.page !== null;
    return {
      running,
      pid: this.chrome?.pid ?? null,
      profile: this.profile,
      url: null,
      title: null,
      headless: this.headless,
      idleMs: running ? Math.max(0, Date.now() - this.lastUse) : 0,
      closesInMs: running
        ? Math.max(0, this.lastUse + this.idleWindow - Date.now())
        : null,
    };
  }

  async state(): Promise<RouteState> {
    const base = this.stateSync();
    if (base.running !== true) return base;
    try {
      const page = await this.evaluate<{ url: string; title: string }>(
        `({ url: location.href, title: document.title || "" })`,
      );
      return { ...base, url: page.url, title: page.title };
    } catch {
      return base;
    }
  }

  async login(): Promise<LoginState> {
    const dir = profileDir(this.profile);
    const cookies = join(dir, "Default", "Cookies");
    let saved = false;
    try {
      saved = existsSync(cookies) && statSync(cookies).size > 1024;
    } catch {
      saved = false;
    }
    return {
      profile: this.profile,
      saved,
      text: `profile ${this.profile}: ${saved ? "saved sign-ins present" : "no saved sign-ins yet"} (${dir})`,
    };
  }

  async close(): Promise<RouteState> {
    if (this.restTimer !== null) clearTimeout(this.restTimer);
    this.restTimer = null;
    const chrome = this.chrome;
    const cdp = this.cdp;
    this.chrome = null;
    this.cdp = null;
    this.page = null;
    this.closed = true;
    if (cdp !== null) cdp.close();
    if (chrome !== null) await chrome.close().catch(() => undefined);
    return this.stateSync();
  }
}

/** Kept for hosts that want to validate a binary without launching it. */
export function inspectBinary(
  env: NodeJS.ProcessEnv = process.env,
): ChromeBinary {
  const binary = (env.OXRAIL_CHROME ?? "").trim();
  if (binary !== "" && existsSync(binary)) {
    return {
      path: binary,
      args: chromeArgs({ userDataDir: "", headless: true }),
    };
  }
  throw new Error("set OXRAIL_CHROME to a Chrome or Chromium binary path");
}
