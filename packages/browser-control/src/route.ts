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

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CdpConnection, DEFAULT_REQUEST_TIMEOUT_MS } from "./cdp.js";
import {
  ChromeProcess,
  chromeArgs,
  profileDir,
  stateDir,
  type ChromeBinary,
} from "./chrome.js";
import { decodePng, toGrid } from "./png.js";
import {
  RouteClosedError,
  StaleRefError,
  type BrowserRoute,
  type Control,
  type DigestOptions,
  type LoginState,
  type OpenOptions,
  type ReadOptions,
  type RouteState,
  type CheckOptions,
  type ClipboardOptions,
  type CookieOptions,
  type DialogOptions,
  type DragOptions,
  type EvalOptions,
  type ExtractOptions,
  type FindOptions,
  type GrabOptions,
  type HoverOptions,
  type LogOptions,
  type LookOptions,
  type MediaOptions,
  type NetworkOptions,
  type PrepareOptions,
  type ScrollOptions,
  type SelectOptions,
  type Shot,
  type ShotOptions,
  type Step,
  type TabsOptions,
  type UploadOptions,
  type WaitOptions,
  type Snapshot,
  type ToolResult,
  type AskOptions,
  type ReviewOptions,
  type ReviewVerdictOptions,
  type ModeOptions,
  type Verdict,
} from "./types.js";
import {
  articleExpression,
  blocksExpression,
  deltaOf,
  evidence,
  passagesToText,
  relevant,
  formatSnapshot,
  squashUrl,
  type Block,
} from "./read.js";

const VIEW_WIDTH = 1280;
const VIEW_HEIGHT = 900;
const DEFAULT_MAX_CHARS = 6_000;
const DEFAULT_IDLE_MS = 5 * 60_000;
const MAX_IDLE_MS = 15 * 60_000;
const MIN_IDLE_MS = 60_000;
const LOAD_TIMEOUT_MS = 20_000;

/** Read the idle window from the environment, bounded the way `rest.js` is. */
/** Compare a name the way a lookup does: both sides folded the same way.
 *
 * A click by text is only allowed to reach a name a read said out loud, so the
 * comparison here has to be the one the read's caller would recognise, not a
 * second opinion about spacing or case. */
/** A "x,y" string from a caller as a point, refusing anything else.
 *
 * A drag or a click by coordinate is the one place a caller hands over numbers
 * instead of a ref, so the parse has to fail loudly rather than round a typo
 * into a click somewhere on the page.
 *
 * @param value - what the caller wrote.
 * @returns the point in CSS pixels.
 */
const MARKS: readonly Verdict[] = ["fixed", "verified", "invalid", "open"];

/** The text a route method produced, for the one place that has to read it back. */
function saidOf(result: ToolResult): string {
  const first = result.content[0];
  return first === undefined || first.type !== "text" ? "" : first.text;
}

/** The numbered points a review came back with, as the numbers it printed. */
function pointList(text: string): number[] {
  const found = new Set<number>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d{1,3})[.):]\s+\S/.exec(line);
    if (match !== null) found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/** What a state reads as, for a method that answers with a state and words. */
function stateText(state: RouteState): string {
  return state.running
    ? `${state.url === "" ? "no page yet" : state.url} — ${state.title === "" ? "untitled" : state.title}`
    : "the browser is not running";
}

function normalizeName(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

export function idleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OXRAIL_BROWSER_IDLE_MS);
  if (!Number.isFinite(raw)) return DEFAULT_IDLE_MS;
  return Math.min(MAX_IDLE_MS, Math.max(MIN_IDLE_MS, Math.floor(raw)));
}

/* How long one DevTools request may wait. Chrome answers fast or not at all, and
   "not at all" used to mean forever: the reply stayed pending, the tool holding
   it stayed pending, and every call behind it waited on the same queue. `0` is
   the documented off switch for a caller that would rather wait. */
export function requestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OXRAIL_BROWSER_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return raw <= 0 ? 0 : Math.floor(raw);
}

/* Display mode is a switch with a visible default, because a person watching the
   route work is the ordinary case: a browser nobody can see makes a wrong page
   look like a wrong reading. `0` forces a window, `1` hides it, and anything
   else — including unset — shows one. `1` is the off switch rather than a truthy
   parse so that a typo cannot silently hide the window. */
export function headlessFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OXRAIL_BROWSER_HEADLESS === "1";
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

/** Where refs of controls inside frames start, so one number says which
 * document to look in. Main-frame refs stay small and unchanged. */
export const FRAME_BASE = 900_000;
/** Room for one frame's own refs between FRAME_BASE steps. */
export const FRAME_SLOT = 100_000;

/** Every tree a read numbered controls in: the document and the open shadow
 * roots under it, walked the same way `locate()` walks them. A tool that
 * resolves a ref with a plain `document.querySelector` reports a control the
 * last read handed a number to as gone, so the walk lives in one place and
 * every tool that turns a number back into an element uses it. */
const REF_ROOTS = `(() => {
  const roots = [document];
  for (let at = 0; at < roots.length && roots.length < 24; at += 1)
    for (const node of roots[at].querySelectorAll("*"))
      if (node.shadowRoot !== null && roots.length < 24) roots.push(node.shadowRoot);
  return roots;
})()`;

/** The element a ref names, or `null` when nothing in the page carries it. */
export function refExpression(ref: number): string {
  return `(() => {
  for (const root of ${REF_ROOTS}) {
    const el = root.querySelector('[data-oxrail-ref="${ref}"]');
    if (el !== null) return el;
  }
  return null;
})()`;
}

/** The page walk, as one expression: it must run in the page and return JSON. */
export function snapshotExpression(options: {
  mode: "text" | "links" | "forms" | "map";
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

  /* An element inside a frame comes from another realm, where the main
     document's Element constructor does not match it; asking its own window
     for the constructor and for getComputedStyle is what keeps a framed
     control from being reported as invisible. */
  const visible = (el) => {
    const own = el && el.ownerDocument ? el.ownerDocument.defaultView : null;
    if (own === null) return false;
    if (!(el instanceof own.Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = own.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (style.opacity !== "" && Number(style.opacity) < 0.05) return false;
    return true;
  };

  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim() !== "") return aria.trim().slice(0, 160);
    /* A form control is usually named by a <label>, and neither a wrapping
       label nor a for= one puts any text inside the control: an upload field
       written as <label>Upload <input type="file"></label> has no value, no
       placeholder and no content of its own, so every source below comes back
       empty and the control reads as nameless even though the page does name
       it. The label is the page's own answer, so it is asked first. */
    const labels = el.labels;
    if (labels && labels.length > 0) {
      const labelled = (labels[0].innerText || labels[0].textContent || "").replace(/\\s+/g, " ").trim();
      if (labelled !== "") return labelled.slice(0, 160);
    }
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

  /* A control keeps its number for as long as the element is on the page.
     Numbering a fresh list from 1 on every read would renumber the page each
     time anything above it appeared, and a delta between two reads would then
     report the renumbering as a change. The store lives on the window, so a
     navigation drops it along with the elements it points at. */
  const store = window.__oxrailRefs || {
    next: 1,
    byEl: new WeakMap(),
  };
  window.__oxrailRefs = store;
  const refOf = (el) => {
    const known = store.byEl.get(el);
    if (known !== undefined) return known;
    const ref = store.next;
    store.next += 1;
    store.byEl.set(el, ref);
    return ref;
  };

  let nodes = 0;
  let truncated = false;
  /* Which ceiling was hit, not just that one was: a caller told only
     "truncated" cannot tell a page with more controls than the read
     shows from one whose words were cut, and the two need different
     next moves. */
  let limit = "";
  const capped = (why) => { truncated = true; limit = why; };

  /* A document is not the whole page: components live in shadow roots, and a
     checkout, a player or a chat widget lives in an iframe. Reading only
     document.querySelectorAll would report such a page as having nothing to
     click, and a click tool would then be right and useless. */
  const SELECTOR = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

  /* Open shadow roots only. A closed one cannot be reached from here at all,
     and pretending otherwise would hide the gap instead of reporting it. */
  const rootsOf = (root, out, depth) => {
    if (depth > 4 || out.length >= 24) return out;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        out.push(el.shadowRoot);
        rootsOf(el.shadowRoot, out, depth + 1);
        if (out.length >= 24) break;
      }
    }
    return out;
  };

  const deepQuery = (root, selector) => {
    const found = [];
    const roots = [root];
    rootsOf(root, roots, 0);
    for (const one of roots) {
      for (const el of one.querySelectorAll(selector)) found.push(el);
      if (found.length >= 4000) return found;
    }
    return found;
  };

  /* Frames, in document order, same-origin only. A cross-origin frame throws on
     contentDocument; it is counted, not invented. */
  const frames = [];
  const unseen = [];
  const walkFrames = (doc, depth) => {
    if (depth > 2 || frames.length >= 8) return;
    for (const holder of doc.querySelectorAll("iframe,frame")) {
      let inside = null;
      try { inside = holder.contentDocument; } catch (error) { inside = null; }
      if (inside === null) { unseen.push(holder); continue; }
      if (frames.length >= 8) { unseen.push(holder); continue; }
      frames.push({ holder, doc: inside });
      walkFrames(inside, depth + 1);
    }
  };
  walkFrames(document, 0);
  if (unseen.length > 0) capped("frames");

  const offsetOf = (holder) => {
    let x = 0;
    let y = 0;
    let node = holder;
    let guard = 0;
    while (node !== null && node !== undefined && guard < 8) {
      const box = node.getBoundingClientRect();
      x += box.left + (node.clientLeft || 0);
      y += box.top + (node.clientTop || 0);
      const own = node.ownerDocument;
      const view = own === null ? null : own.defaultView;
      if (view === null || view === undefined) break;
      x -= view.scrollX || 0;
      y -= view.scrollY || 0;
      node = view.frameElement;
      guard += 1;
    }
    return { x, y };
  };

  const controls = [];
  const elements = [];
  /* A control inside a frame is numbered in its own document, because that is
     where the attribute has to be found again; the number a caller sees
     carries the frame, so a click knows which document to look in and which
     corner to add. */
  const collect = (root, slot) => {
    for (const el of deepQuery(root, SELECTOR)) {
      if (controls.length >= MAX_CONTROLS) { capped("controls"); return; }
      nodes += 1;
      if (nodes > MAX_NODES) { capped("nodes"); return; }
      if (!visible(el)) continue;
      const name = nameOf(el);
      if (name === "" && !el.hasAttribute("contenteditable") && el.tagName.toLowerCase() !== "input") continue;
      const local = refOf(el);
      el.setAttribute("data-oxrail-ref", String(local));
      elements.push(el);
      controls.push({
        ref: slot === 0 ? local : ${FRAME_BASE} + (slot - 1) * ${FRAME_SLOT} + local,
        role: roleOf(el),
        name,
        tag: el.tagName.toLowerCase(),
        frame: slot,
      });
    }
  };
  collect(document, 0);
  for (let slot = 1; slot <= frames.length; slot += 1) {
    if (controls.length >= MAX_CONTROLS) { capped("controls"); break; }
    collect(frames[slot - 1].doc, slot);
  }

  const body = document.body;
  let everything = body ? body.innerText || "" : "";
  /* A framed widget's words are part of the page for a reader: a price, an
     error, a login form. Frames after the first are labelled, because three
     silent paragraphs from three widgets read as one page. */
  for (let slot = 1; slot <= frames.length; slot += 1) {
    const inside = frames[slot - 1].doc;
    const said = inside.body ? (inside.body.innerText || "").replace(/\\s+/g, " ").trim() : "";
    if (said === "") continue;
    everything += "\\n\\n[frame " + slot + "] " + said.slice(0, 400);
  }
  let text = everything;
  /* Words, not characters: a page of Chinese is not four times longer than the
     same page in English, and a caller sizing a budget in characters will read
     four times too much of it. Same rule as the term counter in read.js. */
  const runs = everything.match(/[a-z0-9]+|[\\u3400-\\u9fff]/gi);
  const words = runs === null ? 0 : runs.length;
  if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); capped("chars"); }
  text = text.replace(/\\n{3,}/g, "\\n\\n").trim();

  if (MODE === "links") {
    const links = [];
    const roots = [document];
    rootsOf(document, roots, 0);
    for (const root of roots) for (const el of root.querySelectorAll("a[href]")) {
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
    for (const [at, el] of controls.entries()) {
      const node = elements[at];
      const value = node && typeof node.value === "string" ? node.value : "";
      const type = node ? (node.getAttribute("type") || "") : "";
      rows.push("[" + el.ref + "] " + el.role + (type ? ":" + type : "") + (value ? " = " + value : "") + (el.name ? " — " + el.name : ""));
    }
    text = rows.length > 0 ? rows.join("\\n") : "(no visible controls)";
  }

  /* A map is the shape of the page, not its words: the headings in order and
     the controls already numbered, so a caller can decide what to read next
     without having read anything yet. */
  if (MODE === "map") {
    const outline = [];
    const heads = [];
    const roots = [document];
    rootsOf(document, roots, 0);
    for (const root of roots) for (const el of root.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=\\"heading\\"]")) heads.push(el);
    for (const el of heads) {
      if (!visible(el)) continue;
      const depth = Number(el.tagName.slice(1)) || 2;
      const said = nameOf(el);
      if (said === "") continue;
      outline.push("#".repeat(Math.min(6, Math.max(1, depth))) + " " + said);
      if (outline.length >= 80) { capped("headings"); break; }
    }
    text = outline.length > 0 ? outline.join("\\n") : "(no headings)";
  }

  /* Every branch above builds its own text after the body budget was applied, so
     a page made of nothing but links, form values or headings would otherwise
     raise its own ceiling: the body was cut, then discarded, and the replacement
     was never measured. One guard covers every mode, and the next one too. */
  if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); capped("chars"); }

  return {
    url: location.href,
    title: (document.title || "").slice(0, 200),
    text,
    controls,
    truncated,
    limit,
    blindFrames: unseen.length,
    words,
  };
})()`;
}

/** Just where we are and how much there is to read, for a read that never
 * touches `snapshotExpression` (the article column is built by `read.js`). */
const META_EXPRESSION = `(() => {
  const body = document.body;
  const everything = body ? body.innerText || "" : "";
  const runs = everything.match(/[a-z0-9]+|[\\u3400-\\u9fff]/gi);
  return { url: location.href, title: (document.title || "").slice(0, 200), words: runs === null ? 0 : runs.length };
})()`;

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
/* The page expression reports "" when nothing was capped, and a missing
   field when the expression did not run at all. Both mean the same thing to a
   caller: no cap to name. */
function capOf(raw: unknown): string | undefined {
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

export class CdpBrowserRoute implements BrowserRoute {
  private chrome: ChromeProcess | null = null;
  private cdp: CdpConnection | null = null;
  private page: PageSession | null = null;
  private readonly idleWindow: number;
  private lastUse = 0;
  private restTimer: NodeJS.Timeout | null = null;
  private readonly profile: string;
  /* The mode of the running window, which a single `open({ headless })` can
     differ from the route's standing choice. Null when nothing is running, so
     a report never describes a window that is not there. */
  private runningHeadless: boolean | null = null;
  /* The same for the profile: a one-shot `open({ profile })` runs a window out
     of another directory, and a report of "default" would send the next call
     looking for sign-ins that window never had. */
  private runningProfile: string | null = null;
  private headless: boolean;
  private readonly size: { width: number; height: number };
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** The previous read, so `mode: "changed"` can answer with a delta. */
  /** What the last `text`-shaped read said, for the `changed` mode. Only reads
   * that return the same projection update it: diffing an article against a
   * snapshot would report two different shapes as a change. It carries the
   * address because a page that navigated has nothing to diff against. */
  private last: {
    url: string;
    text: string;
    controls: readonly Control[];
  } | null = null;
  /** The numbers the last read handed out, and the page they were on.
   *
   * A write may only address a control by a number a read produced: this route
   * never takes a coordinate from a caller, and never guesses a point from a
   * picture, so the number is the whole address. Keeping the set is what makes
   * that a rule instead of a convention — an invented number, or one from a
   * page that has since navigated, is refused instead of landing on whatever
   * now happens to answer to it. */
  private handed: {
    url: string;
    refs: ReadonlySet<number>;
    names: readonly string[];
  } | null = null;

  /* What the page told us since it opened, kept here rather than in the page so
     a console line that scrolls away is still answerable. Bounded: a page that
     logs in a loop must not grow this process. */
  private consoleLines: string[] = [];
  private failedRequests: Array<{
    url: string;
    method: string;
    status: number;
    type: string;
    error: string;
  }> = [];
  private responses: Array<{
    url: string;
    method: string;
    status: number;
    type: string;
  }> = [];
  private played: Array<{ url: string; kind: string; bytes: number }> = [];
  private dialogOpen: {
    type: string;
    message: string;
    defaultValue: string;
  } | null = null;
  private watching = false;
  /* A review round is a conversation that repeats, so what was already
     settled has to survive the round: otherwise the next round raises the
     same points again and the transcript grows without settling anything. */
  private reviewRounds = 0;
  private settled = new Map<number, Verdict>();
  private handoffAt = 0;
  private lastGrid: { key: string; rows: string[][] } | null = null;

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
      this.runningHeadless = headless;
      this.runningProfile = profile;
      const cdp = await CdpConnection.connect(chrome.browserWsUrl, {
        timeoutMs: 10_000,
        requestTimeoutMs: requestTimeoutMs(),
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
    return this.serial(async () => this.readNow(options));
  }

  /**
   * The read itself, inside whatever ordering the caller already holds.
   *
   * A write tool hands out fresh refs after it acts, and it runs inside
   * `serial`, so it has to call this rather than `read`: `read` takes the
   * queue again and would wait for the turn it is already holding, which is a
   * deadlock that also strands every call queued behind it.
   */
  private async readNow(options: ReadOptions = {}): Promise<Snapshot> {
    await this.ensure();
    const mode = options.mode ?? "text";
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    const snapshot = await this.evaluate<Snapshot>(
      snapshotExpression({ mode, maxChars }),
    );
    this.touch();
    this.last = {
      url: snapshot.url,
      text: snapshot.text,
      controls: snapshot.controls,
    };
    this.hand(snapshot.url, snapshot.controls);
    return {
      url: snapshot.url,
      title: snapshot.title,
      text: snapshot.text,
      controls: snapshot.controls,
      truncated: snapshot.truncated === true,
      limit: capOf(snapshot.limit),
      /* Carried out of the page expression, or a caller counting only what it
         received would call a page with an unreadable frame complete. */
      blindFrames: snapshot.blindFrames ?? 0,
      words: snapshot.words ?? 0,
      chars: snapshot.text.length,
    };
  }

  /**
   * Read the page for a few hundred words instead of a whole DOM.
   *
   * `article` renders the reading column as Markdown. `map` gives the shape of
   * the page — headings, controls, how many words there are — without the words.
   * `query` returns only the passages that answer a question, ranked in this
   * process. `changed` returns only what the last read did not already say.
   *
   * The snapshot is still the same shape, so a caller that only knows how to
   * read `text` and `controls` keeps working.
   */
  async digest(options: DigestOptions): Promise<Snapshot> {
    return this.serial(async () => {
      await this.ensure();
      const maxChars = options.maxChars ?? 2_000;
      if (options.mode === "article") {
        /* The page expression hands back JSON text rather than an object: a
           CDP evaluate returns JSON-serialisable values, and a column of page
           text is not one until it has been stringified. */
        const raw = await this.evaluate<string>(articleExpression(maxChars));
        const page = CdpBrowserRoute.parseArticle(raw);
        const seen = await this.evaluate<{
          url: string;
          title: string;
          words: number;
        }>(META_EXPRESSION);
        this.touch();
        return {
          url: seen.url,
          title: seen.title,
          text: page.text,
          controls: [],
          truncated: page.truncated === true,
          limit: page.truncated === true ? "chars" : undefined,
          mode: "article",
          words: seen.words,
          chars: page.text.length,
        };
      }
      if (options.mode === "map") {
        const page = await this.evaluate<Snapshot>(
          snapshotExpression({ mode: "map", maxChars }),
        );
        this.touch();
        this.hand(page.url, page.controls);
        return {
          url: page.url,
          title: page.title,
          text: page.text,
          controls: page.controls,
          truncated: page.truncated === true,
          limit: capOf(page.limit),
          mode: "map",
          words: page.words ?? 0,
          chars: page.text.length,
        };
      }
      if (options.mode === "query") {
        const asked = (options.query ?? "").trim();
        if (asked === "")
          throw new Error(
            "mode query needs a query: what are you looking for?",
          );
        const blocks = await this.blocksFor(maxChars);
        const found = evidence(blocks, asked, { maxChars, limit: 24 });
        const page = await this.evaluate<Snapshot>(
          snapshotExpression({ mode: "map", maxChars }),
        );
        this.touch();
        this.hand(page.url, page.controls);
        /* `hand` takes the whole list, so filtering what is printed never
           removes a landing place: a ref that was handed out stays valid even
           when its line is left out. The question decides which names are worth
           the characters, and a control the question did say something about
           can still be clicked by number after reading a different mode. */
        const shown = relevant(page.controls, asked, { maxChars });
        const text = passagesToText(found);
        return {
          url: page.url,
          title: page.title,
          text:
            text === ""
              ? `(nothing on this page answers ${JSON.stringify(asked)})`
              : text,
          controls: shown.controls,
          ...(shown.omitted === 0 ? {} : { omitted: shown.omitted }),
          truncated: found.rows.length < found.matched,
          limit: found.rows.length < found.matched ? "passages" : undefined,
          mode: "query",
          words: page.words ?? 0,
          chars: text.length,
          matched: found.matched,
          total: found.total,
        };
      }
      const page = await this.evaluate<Snapshot>(
        snapshotExpression({ mode: "text", maxChars }),
      );
      this.touch();
      const before =
        this.last !== null && this.last.url === page.url ? this.last : null;
      this.last = { url: page.url, text: page.text, controls: page.controls };
      this.hand(page.url, page.controls);
      /* No earlier read to compare against — or the page navigated since, in
         which case everything is new: the honest answer is the whole page,
         not "nothing changed". */
      if (before === null)
        return {
          url: page.url,
          title: page.title,
          text: page.text,
          controls: page.controls,
          truncated: page.truncated === true,
          limit: capOf(page.limit),
          mode: "changed",
          words: page.words ?? 0,
          chars: page.text.length,
        };
      const delta = deltaOf(before, {
        text: page.text,
        controls: page.controls,
      });
      return {
        url: page.url,
        title: page.title,
        text:
          delta.text === "" ? "(no change since the last read)" : delta.text,
        controls: delta.controls,
        truncated: page.truncated === true,
        limit: capOf(page.limit),
        mode: "changed",
        words: page.words ?? 0,
        chars: delta.text.length,
      };
    });
  }

  /** The page's blocks, collected at six times the budget so ranking has room. */
  /** The reading column comes back as JSON text; a malformed one is empty,
   * not an exception, so a page that cannot be read does not kill the route. */
  private static parseArticle(raw: unknown): {
    text: string;
    chars: number;
    linkCount: number;
    truncated: boolean;
  } {
    try {
      const parsed = JSON.parse(String(raw ?? "")) as {
        text?: unknown;
        chars?: unknown;
        linkCount?: unknown;
        truncated?: unknown;
      };
      return {
        text: String(parsed.text ?? ""),
        chars: Number(parsed.chars ?? 0),
        linkCount: Number(parsed.linkCount ?? 0),
        truncated: parsed.truncated === true,
      };
    } catch {
      return { text: "", chars: 0, linkCount: 0, truncated: false };
    }
  }

  private async blocksFor(maxChars: number): Promise<Block[]> {
    const raw = await this.evaluate<string>(blocksExpression(maxChars * 6));
    try {
      const parsed = JSON.parse(raw) as { blocks?: Block[] };
      return Array.isArray(parsed.blocks) ? parsed.blocks : [];
    } catch {
      return [];
    }
  }

  /** Resolve a numbered control or a text match to a point that will hit it. */
  private async locate(target: {
    ref?: number;
    text?: string;
  }): Promise<{ x: number; y: number; label: string }> {
    if (target.ref !== undefined && target.text !== undefined) {
      throw new Error("give either ref or text, not both");
    }
    if (target.ref !== undefined && target.ref >= FRAME_BASE) {
      return this.locateInFrame(target.ref);
    }
    const expression = `(() => {
  /* A control in a shadow root is in the page and has a point; a lookup on the
     document alone would report it as gone. */
  const roots = [document];
  for (let at = 0; at < roots.length && roots.length < 24; at += 1)
    for (const node of roots[at].querySelectorAll("*"))
      if (node.shadowRoot !== null && roots.length < 24) roots.push(node.shadowRoot);
  const deepAll = (selector) => {
    const out = [];
    for (const root of roots) for (const node of root.querySelectorAll(selector)) out.push(node);
    return out;
  };
  const deepOne = (selector) => {
    for (const root of roots) {
      const node = root.querySelector(selector);
      if (node !== null) return node;
    }
    return null;
  };
  const el = ${
    target.ref !== undefined
      ? `deepOne('[data-oxrail-ref="${target.ref}"]')`
      : `(() => {
    const needle = ${JSON.stringify(target.text ?? "")}.replace(/\\s+/g, " ").trim().toLowerCase();
    if (needle === "") return null;
    const all = deepAll('a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"]');
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
  /* Instant, not smooth: a page with scroll-behavior:smooth animates this call,
     and the rect read one line later is the one it had before the scroll, so
     every point below would be computed against where the control used to be. */
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const box = el.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return { found: true, label, blocked: "it has no area on screen to click" };
  /* Only the part of the control the viewport shows can be pressed. Clamping a
     point that lies outside it invents a place the control is not, and the
     press then lands wherever the clamp put it. */
  const seenLeft = Math.max(box.left, 0);
  const seenTop = Math.max(box.top, 0);
  const seenRight = Math.min(box.right, innerWidth);
  const seenBottom = Math.min(box.bottom, innerHeight);
  if (seenRight - seenLeft < 2 || seenBottom - seenTop < 2)
    return { found: true, label, blocked: "it is outside the visible area even after scrolling it into view" };
  /* The point must be one where a real press would reach this control: an
     overlay, a sticky header or a modal owns that pixel otherwise, and clicking
     it anyway would report success while the page never heard the press. Five
     samples, centre first, so a control covered only in the middle still gets
     clicked where it is reachable.
     A descendant counts, because the press bubbles up to the control. An
     ancestor does not: body contains every control, and an element with
     pointer-events:none is painted under the thing that really takes the
     press, so a click there is heard by the page and by nobody the caller
     asked for. */
  const within = (value, limit) => Math.min(Math.max(value, 1), Math.max(limit - 2, 1));
  /* The tree the control is in answers for its own points: an element inside a
     shadow root is not returned by document.elementFromPoint at all, so asking
     the document would report every shadow control as covered. */
  const root = el.getRootNode();
  const own = root !== null && typeof root.elementFromPoint === "function" ? root : document;
  const spread = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]];
  for (const [fx, fy] of spread) {
    const x = within(seenLeft + (seenRight - seenLeft) * fx, innerWidth);
    const y = within(seenTop + (seenBottom - seenTop) * fy, innerHeight);
    const hit = own.elementFromPoint(x, y);
    if (hit !== null && (hit === el || el.contains(hit))) return { found: true, x, y, label };
  }
  const top = own.elementFromPoint(
    within(seenLeft + (seenRight - seenLeft) / 2, innerWidth),
    within(seenTop + (seenBottom - seenTop) / 2, innerHeight),
  );
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

  /** A ref inside a frame is found in that frame's document, and its point is
   * the frame's corner plus its own rect; the press is dispatched to the page
   * as a whole, so only the total matters. */
  private async locateInFrame(ref: number): Promise<{
    x: number;
    y: number;
    label: string;
  }> {
    /* The number was written by the snapshot as one-based in frames, one-based
       in the control: decode it the same way, or every click is one frame and
       one control off. */
    const slot = Math.floor((ref - FRAME_BASE) / FRAME_SLOT) + 1;
    const local = ref - FRAME_BASE - (slot - 1) * FRAME_SLOT;
    const found = await this.evaluate<{
      found: boolean;
      x?: number;
      y?: number;
      label?: string;
      blocked?: string;
      frames: number;
    }>(`(() => {
  /* The same walk the snapshot did, in the same order, or the frame number
     means a different document here than it meant there. */
  const holders = [];
  const walk = (doc, depth) => {
    if (depth > 2 || holders.length >= 8) return;
    for (const one of doc.querySelectorAll("iframe,frame")) {
      let inside = null;
      try { inside = one.contentDocument; } catch (error) { inside = null; }
      if (inside === null) continue;
      holders.push(one);
      walk(inside, depth + 1);
    }
  };
  walk(document, 0);
  const holder = holders[${slot} - 1];
  if (!holder) return { found: false, frames: holders.length };
  let inside = null;
  try { inside = holder.contentDocument; } catch (error) { inside = null; }
  if (inside === null) return { found: true, frames: holders.length, blocked: "the frame is cross-origin, so its contents cannot be read or clicked through this route" };
  const el = inside.querySelector('[data-oxrail-ref="${local}"]');
  if (!el) return { found: false, frames: holders.length };
  const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  /* Named for what it is, because 'own' already means the tree the control is
     in over in locate(); one name for two things is how the occlusion path
     came to reference a binding that had gone out of scope. */
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return { found: true, frames: holders.length, label, blocked: "it has no area on screen to click" };
  let x = 0, y = 0, node = holder, guard = 0, top = holder;
  while (node && guard < 8) {
    const box = node.getBoundingClientRect();
    x += box.left + (node.clientLeft || 0);
    y += box.top + (node.clientTop || 0);
    const view = node.ownerDocument === null ? null : node.ownerDocument.defaultView;
    if (view === null) break;
    x -= view.scrollX || 0;
    y -= view.scrollY || 0;
    node = view.frameElement;
    /* The hit test runs in this document, where the only frame element that
       exists is the outermost one: a nested frame's holder belongs to another
       document, and comparing a point with it can never match. */
    if (node) top = node;
    guard += 1;
  }
  const at = { x: x + rect.left + rect.width / 2, y: y + rect.top + rect.height / 2 };
  /* The point has to be inside the frame's own visible box, and the frame's
     box has to be on screen, or the press lands on whatever is above it. */
  const box = holder.getBoundingClientRect();
  if (at.x < box.left || at.x > box.right || at.y < box.top || at.y > box.bottom)
    return { found: true, frames: holders.length, label, blocked: "it is scrolled out of the part of the frame that is shown" };
  if (at.x < 0 || at.y < 0 || at.x > innerWidth - 1 || at.y > innerHeight - 1)
    return { found: true, frames: holders.length, label, blocked: "the frame is outside the visible area" };
  const hit = document.elementFromPoint(at.x, at.y);
  if (hit === null || !(hit === top || top.contains(hit)))
    return { found: true, frames: holders.length, label, blocked: "something is on top of the frame" };
  return { found: true, frames: holders.length, label, x: at.x, y: at.y };
})()`);
    if (found.found !== true) {
      if (found.frames < slot)
        throw new StaleRefError(
          `the page changed; control ${ref} was in frame ${slot}, and the page no longer has that frame — call browser_view again`,
        );
      throw new StaleRefError(
        `the page changed; control ${ref} is gone — call browser_view again`,
      );
    }
    const label = found.label ?? "";
    if (found.blocked !== undefined)
      throw new Error(
        `${label === "" ? "control" : JSON.stringify(label)} cannot be clicked: ${found.blocked}.`,
      );
    if (found.x === undefined || found.y === undefined)
      throw new Error(
        `${label === "" ? "control" : JSON.stringify(label)} has no reachable point on screen.`,
      );
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

  /** Record what a read numbered, so a later write can be held to it. */
  private hand(url: string, controls: readonly Control[]): void {
    this.handed = {
      url,
      refs: new Set(controls.map((control) => control.ref)),
      /* The names this read handed out, normalised the same way a lookup is,
         so a click by text can be held to what the read actually said. */
      names: controls.map((control) => normalizeName(control.name)),
    };
  }

  /** Refuse a write that does not come from a read.
   *
   * The two failures this names are different, and both are honest: nothing
   * has been read yet, or the last read of this page did not contain that
   * number. Neither is answered by trying harder — the answer is to read
   * again, which is also the only way to get a number that will work. */
  private addressable(ref: number): void {
    if (this.handed === null)
      throw new StaleRefError(
        `control ${ref} cannot be addressed: nothing has been read, so no read produced that number — call browser_view first`,
      );
    if (!this.handed.refs.has(ref))
      throw new StaleRefError(
        `control ${ref} cannot be addressed: the last read of ${this.handed.url} did not contain it — call browser_view again and use a number it returns`,
      );
  }

  async click(target: { ref?: number; text?: string }): Promise<ToolResult> {
    return this.serial(async () => {
      /* A number the caller made up is not an address. A text this page has is
         one only if a read said so, so a click by text still needs a read.
         Checked before the browser is opened: a write that cannot be addressed
         is answered the same way whether or not Chrome is already running. */
      if (target.ref !== undefined) this.addressable(target.ref);
      else {
        const needle = normalizeName(target.text ?? "");
        /* An empty selector is not an address: every name contains the empty
           string, so letting it through would hand back the first control on
           the page instead of the one the caller meant. */
        if (needle === "")
          throw new StaleRefError(
            `a click needs a number or some text to find the control by, and ${JSON.stringify(target.text ?? "")} has neither`,
          );
        const said = this.handed?.names.some((name) => name.includes(needle));
        if (this.handed === null)
          throw new StaleRefError(
            `nothing has been read, so ${JSON.stringify(target.text ?? "")} is not known to be on this page — call browser_view first`,
          );
        if (said !== true)
          throw new StaleRefError(
            `control ${JSON.stringify(target.text ?? "")} cannot be addressed: the last read of ${this.handed.url} did not name it — call browser_view again and use a number it returns`,
          );
      }
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
      if (target.ref !== undefined) this.addressable(target.ref);
      /* Typing without a number goes to whatever has focus, so the caller has
         to have focused it by reading and then clicking. With nothing read at
         all there is no such control, and the keystrokes would land on
         whatever the page decided to focus on its own. */ else if (
        this.handed === null
      )
        throw new StaleRefError(
          `nothing has been read, so there is no control to type into — call browser_view first`,
        );
      await this.ensure();
      if (target.ref !== undefined) {
        const ok = await this.focus(target.ref);
        if (!ok)
          throw new StaleRefError(
            `the page changed; control ${target.ref} is gone — call browser_view again`,
          );
      } else {
        /* Typing with no number lands on whatever has focus, so the focus is
           the address. It counts only when the last read numbered it: an
           element the page focused on its own, or one that was never handed
           out, is not something the caller chose. */
        const focus = await this.evaluate<{
          anywhere: boolean;
          ref: number | null;
        }>(`(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement)
    el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement)
    return { anywhere: false, ref: null };
  for (let node = el; node; node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null) {
    const own = node.getAttribute && node.getAttribute("data-oxrail-ref");
    if (own !== null && own !== undefined) return { anywhere: true, ref: Number(own) };
  }
  return { anywhere: true, ref: null };
})()`);
        if (!focus.anywhere)
          throw new StaleRefError(
            `nothing on this page has focus, so there is no control to type into — read the page, then click the control you mean`,
          );
        if (
          this.handed === null ||
          focus.ref === null ||
          !this.handed.refs.has(focus.ref)
        )
          throw new StaleRefError(
            `the focused control is not one the last read of ${this.handed?.url ?? "this page"} numbered — read the page again and click the control you mean`,
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
  const el = ${refExpression(ref)};
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
      /* Whatever the numbers meant, they meant it on the page that was here
         before: a navigation drops the page-side store, so they address
         nothing now. Saying so beats letting a fresh page answer to a stale
         number. */
      if (
        options.url !== undefined ||
        options.back === true ||
        options.reload === true
      )
        this.handed = null;
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
      profile: running ? (this.runningProfile ?? this.profile) : this.profile,
      url: null,
      title: null,
      headless: running
        ? (this.runningHeadless ?? this.headless)
        : this.headless,
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

  /* --- the display switch -------------------------------------------
   *
   * Whether the window is drawn cannot be changed on a browser that is
   * already running: the flag is read once, when it is launched. So a
   * change is carried out by putting the browser down and bringing it back
   * up in the other mode, on the page it was showing. Reporting the new
   * mode without doing that would leave the words and the screen
   * disagreeing, which is worse than the wait.
   */

  async mode(options: ModeOptions = {}): Promise<ToolResult> {
    const wanted = options.display;
    /* A one-shot `open({ headless })` can leave a window whose mode differs
       from the standing choice, so describe the window that is running. */
    const now = this.runningHeadless ?? this.headless;
    if (wanted === undefined) {
      const shown = !now;
      return {
        content: [
          {
            type: "text",
            text:
              `the window is ${shown ? "shown" : "hidden"} (${now ? "headless" : "visible"})` +
              `${this.chrome === null ? ", and no browser is running" : ""}\nchange it with display: "visible" or "headless"`,
          },
        ],
      };
    }
    const next = wanted === "headless";
    const changed = next !== now;
    this.headless = next;
    let where = "";
    /* A one-shot `open({ profile })` can leave a window on a profile that is
       not the standing one. Coming back up on the standing profile would swap
       the sign-ins under a page that has not moved, so carry the running
       profile across the restart the way the URL is carried. */
    const profile = this.runningProfile ?? this.profile;
    if (changed && this.chrome !== null) {
      try {
        where = await this.evaluate<string>("location.href");
      } catch {
        where = "";
      }
      await this.close();
      if (where !== "" && where !== "about:blank") {
        await this.open({ url: where, profile });
        where = ` on ${where}`;
      } else {
        where = "";
      }
    }
    return {
      content: [
        {
          type: "text",
          text: next
            ? `the window is hidden now${where}`
            : `the window is shown now${where}` +
              (changed ? "" : " (it already was)"),
        },
      ],
    };
  }

  /* --- the conversation tools ---------------------------------------
   *
   * A chat that is open in the page keeps the answer behind a "send" that
   * is a click and a wait, and the wait has no fixed length: the reply
   * grows while it is produced. These two do that sequence here so the
   * caller does not have to guess how long to wait between steps.
   */

  async ask(options: AskOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      if (options.text === undefined && options.ref === undefined) {
        throw new Error("browser_ask needs a ref or the name of the box");
      }
      const said = options.said ?? "";
      /* type() is what focuses the box, clears it and submits it, and it
         already knows both ways of naming a control. */
      if (options.ref === undefined) {
        await this.click({ text: options.text as string });
      } else {
        await this.focus(options.ref);
      }
      await this.type({
        text: said,
        clear: true,
        ...(options.submit === false ? {} : { submit: true }),
      });
      const limit = options.timeoutMs ?? 45_000;
      const started = Date.now();
      let previous = "";
      let steadyFor = 0;
      let answer = "";
      while (Date.now() - started < limit) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        answer = await this.evaluate<string>(
          "document.body ? document.body.innerText : ''",
        );
        if (answer === previous) {
          steadyFor += 400;
          /* A reply is finished when it stops growing, not when it stops
             changing: a blinking cursor still changes the text. */
          if (steadyFor >= 1_600 && answer.trim() !== "") break;
        } else {
          steadyFor = 0;
        }
        previous = answer;
      }
      const waited = Date.now() - started;
      const body = answer.trim();
      return {
        content: [
          {
            type: "text",
            text: `${body === "" ? "the page stayed empty" : body}\n\n(reply settled after ${waited} ms; ${limit - waited > 0 ? "it stopped growing" : "it was still growing when the wait ran out"})`,
          },
        ],
      };
    });
  }

  /* A review round is the same send-and-wait, with the shapes of a review
     on top: the message is built from the repository, and what was said is
     kept so the next round can leave settled points out. */

  async review(options: ReviewOptions = {}): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      const round = this.reviewRounds + 1;
      const open = this.settled;
      const body =
        `Review this repository. Round ${round}.` +
        (open.size === 0
          ? " Nothing has been settled yet, so raise every point you see."
          : ` Points already settled and to be left out: ${[...open.keys()].sort((a, b) => a - b).join(", ")}.`);
      const answer = await this.ask({
        ...(options.ref === undefined ? {} : { ref: options.ref }),
        ...(options.text === undefined ? {} : { text: options.text }),
        said: options.said ?? body,
        submit: true,
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      });
      this.reviewRounds = round;
      const said = saidOf(answer);
      const points = pointList(said);
      return {
        content: [
          {
            type: "text",
            text:
              `round ${round}: ${points.length === 0 ? "no numbered points came back" : points.map((point) => `${point}.`).join(" ")}` +
              `\n\n${said}`,
          },
        ],
      };
    });
  }

  reviewVerdict(options: ReviewVerdictOptions = {}): Promise<ToolResult> {
    const marks = options.marks ?? [];
    if (marks.length === 0) {
      const known = [...this.settled.entries()].sort((a, b) => a[0] - b[0]);
      return Promise.resolve({
        content: [
          {
            type: "text" as const,
            text:
              known.length === 0
                ? "no point has been settled yet"
                : known.map(([point, mark]) => `${point}: ${mark}`).join("\n"),
          },
        ],
      });
    }
    for (const mark of marks) {
      if (!MARKS.includes(mark.verdict)) {
        throw new Error(
          `mark ${mark.point}: "${mark.verdict}" is not one of ${MARKS.join(", ")}`,
        );
      }
      this.settled.set(mark.point, mark.verdict);
    }
    return Promise.resolve({
      content: [
        {
          type: "text" as const,
          text:
            marks.map((mark) => `${mark.point}: ${mark.verdict}`).join("\n") +
            `\n\n${this.settled.size} point${this.settled.size === 1 ? "" : "s"} settled, and left out of the next round`,
        },
      ],
    });
  }

  async resume(): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      /* The hold is a wait that keeps the next action back; clearing it is
         what makes the next call go out at once instead of after it. */
      const held = this.handoffAt;
      this.handoffAt = 0;
      const state = await this.state();
      return {
        content: [
          {
            type: "text",
            text: `${held === 0 ? "nothing was holding the page" : "the page is back in hand"}\n${stateText(state)}`,
          },
        ],
      };
    });
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

  /* ---------------------------------------------------------------------
   * The tools beyond the first eleven.
   *
   * Each one exists because a page cannot answer the question through the
   * numbered controls alone: a grid for what draws itself, a wait instead of a
   * read loop, the console for a click that seemed to do nothing. None of them
   * invents a coordinate — a point still has to come from a read, and the
   * screenshot tools are the only place pixels are interpreted.
   * ------------------------------------------------------------------- */

  /** Watch for the things that are not on the page any more once it redraws. */
  private async startWatching(): Promise<void> {
    if (this.watching || this.cdp === null) return;
    this.watching = true;
    const cdp = this.cdp;
    const { page } = await this.ensure();
    cdp.on("Runtime.consoleAPICalled", (params) => {
      const typed = params as {
        type?: string;
        args?: Array<{ value?: unknown; description?: string }>;
      };
      const text = (typed.args ?? [])
        .map((arg) =>
          arg.value !== undefined
            ? typeof arg.value === "string"
              ? arg.value
              : JSON.stringify(arg.value)
            : (arg.description ?? ""),
        )
        .join(" ");
      this.remember(`[${typed.type ?? "log"}] ${text}`);
    });
    cdp.on("Runtime.exceptionThrown", (params) => {
      const typed = params as {
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string };
        };
      };
      const detail = typed.exceptionDetails;
      this.remember(
        `[error] ${detail?.exception?.description ?? detail?.text ?? "exception"}`,
      );
    });
    cdp.on("Network.responseReceived", (params) => {
      const typed = params as {
        type?: string;
        response?: { url?: string; status?: number; mimeType?: string };
        requestId?: string;
      };
      const url = typed.response?.url ?? "";
      const kind = typed.type ?? "";
      const status = typed.response?.status ?? 0;
      const method = "GET";
      if (url !== "")
        this.responses.unshift({ url, method, status, type: kind });
      if (this.responses.length > 400) this.responses.length = 400;
      if (
        (kind === "Media" || kind === "XHR" || kind === "Fetch") &&
        url !== ""
      ) {
        const played = this.played.find((item) => item.url === url);
        if (played === undefined) this.played.unshift({ url, kind, bytes: 0 });
        if (this.played.length > 200) this.played.length = 200;
      }
    });
    cdp.on("Network.loadingFailed", (params) => {
      const typed = params as {
        errorText?: string;
        type?: string;
        requestId?: string;
        blockedReason?: string;
      };
      const known = this.responses.find(
        (item) => item.type === (typed.type ?? ""),
      );
      this.failedRequests.unshift({
        url: known?.url ?? "",
        method: "GET",
        status: 0,
        type: typed.type ?? "",
        error: typed.blockedReason ?? typed.errorText ?? "failed",
      });
      if (this.failedRequests.length > 200) this.failedRequests.length = 200;
    });
    cdp.on("Page.javascriptDialogOpening", (params) => {
      const typed = params as {
        type?: string;
        message?: string;
        defaultPrompt?: string;
      };
      this.dialogOpen = {
        type: typed.type ?? "alert",
        message: typed.message ?? "",
        defaultValue: typed.defaultPrompt ?? "",
      };
    });
    cdp.on("Page.javascriptDialogClosed", () => {
      this.dialogOpen = null;
    });
    cdp.on("Page.downloadWillBegin", (params) => {
      const typed = params as { suggestedFilename?: string; url?: string };
      this.remember(
        `downloaded ${typed.suggestedFilename ?? typed.url ?? "a file"}`,
      );
    });
    await cdp.send("Network.enable", {}, page.sessionId);
    await cdp.send("Page.enable", {}, page.sessionId);
  }

  private remember(line: string): void {
    this.consoleLines.push(line);
    if (this.consoleLines.length > 400)
      this.consoleLines.splice(0, this.consoleLines.length - 400);
  }

  async find(options: FindOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      await this.startWatching();
      const asked = options.query.trim();
      if (asked === "")
        throw new Error("browser_find needs a query: what should it look for?");
      const limit = Math.max(1, Math.min(options.limit ?? 40, 200));
      const raw = await this.evaluate<string>(`(() => {
  const pattern = ${options.regex === true ? "true" : "false"}
    ? new RegExp(${JSON.stringify(asked)}, "i")
    : null;
  const needle = ${JSON.stringify(asked)}.toLowerCase();
  const hits = (text) => pattern ? pattern.test(text) : text.toLowerCase().includes(needle);
  const controls = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=checkbox]")) {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\\s+/g, " ");
    if (label === "" || !hits(label)) continue;
    const ref = Number(el.getAttribute("data-oxrail-ref"));
    if (!Number.isFinite(ref)) continue;
    const onScreen = box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
    controls.push({ ref, role: el.getAttribute("role") || el.tagName.toLowerCase(), name: label.slice(0, 160), onScreen });
    if (controls.length >= ${limit}) break;
  }
  const lines = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && lines.length < ${limit}; node = walker.nextNode()) {
    const text = (node.nodeValue || "").trim().replace(/\\s+/g, " ");
    if (text.length < 3 || !hits(text)) continue;
    const holder = node.parentElement;
    if (!holder) continue;
    const box = holder.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const key = Math.round(box.left) + ":" + Math.round(box.top);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({
      text: text.slice(0, 200),
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
      onScreen: box.bottom > 0 && box.top < innerHeight,
    });
  }
  return JSON.stringify({ controls, lines });
})()`);
      const found = JSON.parse(raw) as {
        controls: Array<{
          ref: number;
          role: string;
          name: string;
          onScreen: boolean;
        }>;
        lines: Array<{
          text: string;
          x: number;
          y: number;
          onScreen: boolean;
        }>;
      };
      this.touch();
      const rows: string[] = [];
      for (const control of found.controls)
        rows.push(
          `[${control.ref}] ${control.role} ${JSON.stringify(control.name)}${control.onScreen ? "" : " (off screen)"}`,
        );
      for (const line of found.lines)
        rows.push(
          `${JSON.stringify(line.text)} at ${line.x},${line.y}${line.onScreen ? "" : " (off screen)"}`,
        );
      return {
        content: [
          {
            type: "text",
            text:
              rows.length === 0
                ? `(nothing on this page matches ${JSON.stringify(asked)})`
                : rows.join("\n"),
          },
        ],
      };
    });
  }

  async extract(options: ExtractOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      const select = options.select.trim();
      if (select === "")
        throw new Error(
          "browser_extract needs a selector: what should each row be?",
        );
      const limit = Math.max(1, Math.min(options.limit ?? 60, 400));
      const raw = await this.evaluate<string>(`(() => {
  const scope = ${options.ref === undefined ? "document" : `(${refExpression(options.ref)} || document)`};
  let nodes;
  try { nodes = Array.from(scope.querySelectorAll(${JSON.stringify(select)})); }
  catch (error) { return JSON.stringify({ error: String(error && error.message ? error.message : error) }); }
  const rows = [];
  for (const node of nodes.slice(0, ${limit})) {
    const text = (node.innerText || node.textContent || "").trim().replace(/\\s+/g, " ");
    const link = node.querySelector ? node.querySelector("a[href]") : null;
    const own = node.tagName === "A" && node.getAttribute("href") ? node.href : null;
    rows.push({ text: text.slice(0, 300), href: (link ? link.href : own) || null });
  }
  return JSON.stringify({ rows, total: nodes.length });
})()`);
      const page = JSON.parse(raw) as {
        rows?: Array<{ text: string; href: string | null }>;
        total?: number;
        error?: string;
      };
      this.touch();
      if (page.error !== undefined)
        throw new Error(`that selector is not valid: ${page.error}`);
      const rows = page.rows ?? [];
      const total = page.total ?? 0;
      const body =
        rows.length === 0
          ? `(nothing on this page matches ${JSON.stringify(select)})`
          : rows
              .map((row) =>
                row.href === null || row.href === ""
                  ? row.text
                  : `${row.text} -> ${row.href}`,
              )
              .join("\n");
      return {
        content: [
          {
            type: "text",
            text:
              rows.length < total
                ? `${body}\n… ${total - rows.length} more not shown`
                : body,
          },
        ],
      };
    });
  }

  async look(options: LookOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      const { cdp, page } = await this.ensure();
      const view = await this.evaluate<{ width: number; height: number }>(
        "({ width: innerWidth, height: innerHeight })",
      );
      let clip = { x: 0, y: 0, width: view.width, height: view.height };
      const region = (options.region ?? "").trim();
      if (region !== "") {
        const parts = region.split(",").map((part) => Number(part.trim()));
        if (
          parts.length !== 4 ||
          parts.some((value) => !Number.isFinite(value))
        )
          throw new Error(
            `region must be "x,y,width,height" in pixels; got ${JSON.stringify(region)}`,
          );
        const [x, y, width, height] = parts as [number, number, number, number];
        clip = { x, y, width, height };
      }
      const cols = Math.max(2, Math.min(options.cols ?? 12, 64));
      const rows = Math.max(2, Math.min(options.cols ?? 12, 64));
      const shot = await cdp.send<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png", clip, captureBeyondViewport: false },
        page.sessionId,
      );
      this.touch();
      const bitmap = decodePng(Buffer.from(shot.data, "base64"));
      const grid = toGrid(bitmap, cols, rows);
      /* A grid of letters is only useful in comparison: the same letter for the
         same colour proves the screen changed where the letters differ. */
      const key = `${clip.x},${clip.y},${clip.width},${clip.height}`;
      const previous = this.lastGrid?.key === key ? this.lastGrid : null;
      this.lastGrid = { key, rows: grid };
      if (options.diff === false || previous === null) {
        const glyphs = grid.map((row) => row.join("")).join("\n");
        return {
          content: [
            {
              type: "text",
              text: `grid ${cols}x${rows} of ${clip.width}x${clip.height} at ${clip.x},${clip.y}\n${glyphs}`,
            },
          ],
        };
      }
      const changed: string[] = [];
      for (let row = 0; row < grid.length; row += 1) {
        const now = grid[row] ?? [];
        const before = previous.rows[row] ?? [];
        for (let column = 0; column < now.length; column += 1)
          if (now[column] !== before[column])
            changed.push(
              `${row},${column}: ${before[column] ?? "."} -> ${now[column] ?? "."}`,
            );
      }
      return {
        content: [
          {
            type: "text",
            text:
              changed.length === 0
                ? "no change since the last look"
                : `${changed.length} cells changed\n${changed.join("\n")}`,
          },
        ],
      };
    });
  }

  async wait(options: WaitOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      const budget = Math.max(
        50,
        Math.min(options.timeoutMs ?? 8_000, 120_000),
      );
      const started = Date.now();
      const expression = `(() => {
  const text = document.body ? document.body.innerText : "";
  return { text, url: location.href };
})()`;
      const wanted = (options.text ?? "").trim();
      const gone = (options.gone ?? "").trim();
      const url = (options.url ?? "").trim();
      if (wanted === "" && gone === "" && url === "" && options.quiet !== true)
        throw new Error(
          "browser_wait needs something to wait for: text, gone, url, or quiet",
        );
      let last = "";
      while (Date.now() - started < budget) {
        const now = await this.evaluate<{ text: string; url: string }>(
          expression,
        );
        const hitText =
          wanted === ""
            ? true
            : now.text.toLowerCase().includes(wanted.toLowerCase());
        const hitGone =
          gone === ""
            ? true
            : !now.text.toLowerCase().includes(gone.toLowerCase());
        const hitUrl = url === "" ? true : now.url.includes(url);
        if (hitText && hitGone && hitUrl) {
          this.touch();
          const waited = Date.now() - started;
          return {
            content: [
              {
                type: "text",
                text:
                  options.quiet === true &&
                  wanted === "" &&
                  gone === "" &&
                  url === ""
                    ? `the page is quiet (${waited} ms)`
                    : `reached after ${waited} ms`,
              },
            ],
          };
        }
        if (
          options.quiet === true &&
          now.text === last &&
          Date.now() - started > 500
        ) {
          const still = await this.evaluate<{ text: string; url: string }>(
            expression,
          );
          if (still.text === now.text) {
            this.touch();
            return {
              content: [
                {
                  type: "text",
                  text: `the page stopped changing after ${Date.now() - started} ms`,
                },
              ],
            };
          }
        }
        last = now.text;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const current = await this.evaluate<{ text: string; url: string }>(
        expression,
      );
      const said =
        wanted !== ""
          ? `${JSON.stringify(wanted)} had not appeared`
          : gone !== ""
            ? `${JSON.stringify(gone)} was still showing`
            : url !== ""
              ? `the address did not reach ${url}`
              : "the page did not go quiet";
      throw new Error(
        `waited ${budget} ms and ${said}; the page is at ${current.url} and says ${JSON.stringify(current.text.slice(0, 200))}`,
      );
    });
  }

  async scroll(options: ScrollOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      const dy = options.dy ?? 0;
      const dx = options.dx ?? 0;
      if (dy === 0 && dx === 0)
        throw new Error("browser_scroll needs a dy (negative goes up)");
      const { cdp, page } = await this.ensure();
      const view = await this.evaluate<{ x: number; y: number }>(
        "({ x: innerWidth / 2, y: innerHeight / 2 })",
      );
      await cdp.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseWheel",
          x: Math.round(view.x),
          y: Math.round(view.y),
          deltaX: dx,
          deltaY: dy,
          button: "none",
          modifiers: 0,
        },
        page.sessionId,
      );
      this.touch();
      await this.waitIdle();
      if (options.read === false)
        return {
          content: [
            {
              type: "text",
              text: `scrolled ${dy === 0 ? "" : `${dy > 0 ? "down" : "up"} ${Math.abs(dy)}`}${dx === 0 ? "" : `${dx > 0 ? " right" : " left"} ${Math.abs(dx)}`}`.trim(),
            },
          ],
        };
      const snapshot = await this.readNow({ maxChars: 2_000 });
      return { content: [{ type: "text", text: formatSnapshot(snapshot) }] };
    });
  }

  async hover(options: HoverOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      if (options.ref !== undefined) this.addressable(options.ref);
      const point = await this.locate({
        ...(options.ref !== undefined ? { ref: options.ref } : {}),
        ...(options.text !== undefined ? { text: options.text } : {}),
      });
      const { cdp, page } = await this.ensure();
      await cdp.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x: Math.round(point.x),
          y: Math.round(point.y),
          buttons: 0,
          modifiers: 0,
        },
        page.sessionId,
      );
      this.touch();
      await this.waitIdle();
      if (options.read === false)
        return {
          content: [
            {
              type: "text",
              text: `pointed at ${point.label === "" ? `${point.x},${point.y}` : JSON.stringify(point.label)}`,
            },
          ],
        };
      const snapshot = await this.readNow({ maxChars: 2_000 });
      return { content: [{ type: "text", text: formatSnapshot(snapshot) }] };
    });
  }

  async check(options: CheckOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      this.addressable(options.ref);
      const state = await this.evaluate<{
        found: boolean;
        checked: boolean;
        kind: string;
      }>(`(() => {
  const el = ${refExpression(options.ref)};
  if (!el) return { found: false, checked: false, kind: "gone" };
  const kind = el.tagName === "INPUT" ? (el.type || "checkbox") : (el.getAttribute("role") || el.tagName.toLowerCase());
  return { found: true, checked: el.checked === true || el.getAttribute("aria-checked") === "true", kind };
})()`);
      if (!state.found)
        throw new StaleRefError(
          `the page changed; control ${options.ref} is gone — call browser_view again`,
        );
      if (options.checked === undefined) {
        this.touch();
        return {
          content: [
            {
              type: "text",
              text: `control ${options.ref} (${state.kind}) is ${state.checked ? "checked" : "not checked"}`,
            },
          ],
        };
      }
      /* Looking first is the whole point: clicking blindly flips a control that
         was already right, and the caller never learns it did. */
      if (state.checked !== options.checked) {
        const point = await this.locate({ ref: options.ref });
        await this.mouseClick(point.x, point.y);
      }
      const after = await this.evaluate<{ checked: boolean }>(`(() => {
  const el = ${refExpression(options.ref)};
  return { checked: el ? el.checked === true || el.getAttribute("aria-checked") === "true" : false };
})()`);
      this.touch();
      await this.waitIdle();
      const took = after.checked === options.checked;
      /* The result objects are handed out as frozen-by-type shapes, so the read
         is appended by building the answer once rather than by mutating it. */
      const said = took
        ? `control ${options.ref} is now ${options.checked ? "checked" : "not checked"}`
        : `control ${options.ref} did not take the change: it is ${after.checked ? "checked" : "not checked"}`;
      if (options.read === false)
        return {
          content: [{ type: "text", text: said }],
          ...(took ? {} : { isError: true }),
        };
      const snapshot = await this.readNow({ maxChars: 1_500 });
      return {
        content: [
          { type: "text", text: said },
          { type: "text", text: formatSnapshot(snapshot) },
        ],
        ...(took ? {} : { isError: true }),
      };
    });
  }

  async select(options: SelectOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      if (options.ref !== undefined) this.addressable(options.ref);
      const value = options.value;
      const outcome = await this.evaluate<string>(`(() => {
  let el = ${options.ref === undefined ? "null" : refExpression(options.ref)};
  if (!el && ${JSON.stringify(options.field ?? "")} !== "") {
    const needle = ${JSON.stringify(options.field ?? "")}.toLowerCase();
    for (const node of document.querySelectorAll("select,[role=combobox],[role=listbox]")) {
      const label = (node.getAttribute("aria-label") || node.name || node.id || "").toLowerCase();
      if (label.includes(needle)) { el = node; break; }
    }
  }
  if (!el) return JSON.stringify({ error: "no dropdown matched" });
  if (el.tagName === "SELECT") {
    const wanted = ${JSON.stringify(value)};
    const option = Array.from(el.options).find((o) => o.value === wanted || (o.textContent || "").trim() === wanted);
    if (!option) return JSON.stringify({ error: "no option matched", options: Array.from(el.options).map((o) => (o.textContent || "").trim()).slice(0, 20) });
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return JSON.stringify({ ok: true, value: option.value });
  }
  el.setAttribute("data-oxrail-select", "1");
  return JSON.stringify({ ok: true, custom: true });
})()`);
      const parsed = JSON.parse(outcome) as {
        ok?: boolean;
        custom?: boolean;
        value?: string;
        error?: string;
        options?: string[];
      };
      this.touch();
      if (parsed.error !== undefined) {
        const known =
          parsed.options === undefined || parsed.options.length === 0
            ? ""
            : `; it offers ${parsed.options.map((item) => JSON.stringify(item)).join(", ")}`;
        throw new Error(`${parsed.error}${known}`);
      }
      if (parsed.custom === true) {
        /* A listbox the page draws itself has to be opened the way a person
           would, then the option picked by its own words. */
        const point = await this.locate({
          ...(options.ref !== undefined ? { ref: options.ref } : {}),
          ...(options.field !== undefined ? { text: options.field } : {}),
        });
        await this.mouseClick(point.x, point.y);
        await this.waitIdle();
        const picked = await this.locate({ text: value });
        await this.mouseClick(picked.x, picked.y);
        this.touch();
        await this.waitIdle();
      } else await this.waitIdle();
      if (options.read === false)
        return {
          content: [
            {
              type: "text",
              text: `chose ${JSON.stringify(value)}${parsed.value === undefined ? "" : ` (value ${JSON.stringify(parsed.value)})`}`,
            },
          ],
        };
      const snapshot = await this.readNow({ maxChars: 1_500 });
      return { content: [{ type: "text", text: formatSnapshot(snapshot) }] };
    });
  }

  async drag(options: DragOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      /* Both ends are controls the last read handed out, so both are resolved
         the same way: a number becomes the middle of the control it names, and
         there is nowhere to give a coordinate instead. An end that was not
         given is named as missing rather than looked up as an empty label. */
      if (options.fromRef === undefined)
        throw new Error(
          "a drag needs somewhere to start: give fromRef, a number the last read returned",
        );
      if (options.toRef === undefined)
        throw new Error(
          "a drag needs somewhere to end: give toRef, a number the last read returned",
        );
      this.addressable(options.fromRef);
      this.addressable(options.toRef);
      const from = await this.locate({ ref: options.fromRef });
      const start = { x: from.x, y: from.y };
      const to = await this.locate({ ref: options.toRef });
      const end = { x: to.x, y: to.y };
      const { cdp, page } = await this.ensure();
      const base = { button: "left", clickCount: 1, modifiers: 0 };
      await cdp.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x: Math.round(start.x),
          y: Math.round(start.y),
          buttons: 0,
          modifiers: 0,
        },
        page.sessionId,
      );
      await cdp.send(
        "Input.dispatchMouseEvent",
        {
          type: "mousePressed",
          x: Math.round(start.x),
          y: Math.round(start.y),
          ...base,
          buttons: 1,
        },
        page.sessionId,
      );
      /* Real steps, not a jump: a slider is reading the moves between the ends,
         and a drag-and-drop list needs a hover long enough to arm itself. */
      const steps = 12;
      for (let step = 1; step <= steps; step += 1) {
        const x = start.x + ((end.x - start.x) * step) / steps;
        const y = start.y + ((end.y - start.y) * step) / steps;
        await cdp.send(
          "Input.dispatchMouseEvent",
          {
            type: "mouseMoved",
            x: Math.round(x),
            y: Math.round(y),
            ...base,
            buttons: 1,
          },
          page.sessionId,
        );
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      await cdp.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseReleased",
          x: Math.round(end.x),
          y: Math.round(end.y),
          ...base,
          buttons: 0,
        },
        page.sessionId,
      );
      this.touch();
      await this.waitIdle();
      if (options.read === false)
        return {
          content: [
            {
              type: "text",
              text: `dragged ${Math.round(start.x)},${Math.round(start.y)} to ${Math.round(end.x)},${Math.round(end.y)}`,
            },
          ],
        };
      const snapshot = await this.readNow({ maxChars: 1_500 });
      return { content: [{ type: "text", text: formatSnapshot(snapshot) }] };
    });
  }

  async upload(options: UploadOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      if (options.ref !== undefined) this.addressable(options.ref);
      /* After the provenance check, so a number nobody handed out is still
         answered as that: every write tool asks the same question first, and
         this one is not the exception. What follows is the refusal that only
         this tool can give. */
      if (options.ref !== undefined && options.ref >= FRAME_BASE)
        /* The number was written for content in a frame, and the walk below
           reads the top document. Said plainly rather than reported as a
           control that has gone, which is what a lookup in the wrong tree
           would otherwise claim. */
        throw new StaleRefError(
          `control ${options.ref} is inside a frame, so its input cannot be filled by number — pass a ref from a read that saw the top document`,
        );
      if (options.files.length === 0)
        throw new Error("browser_upload needs at least one absolute file path");
      for (const file of options.files)
        if (!file.startsWith("/"))
          throw new Error(
            `browser_upload takes absolute paths; ${JSON.stringify(file)} is not one`,
          );
      const { cdp, page } = await this.ensure();
      /* DOM.setFileInputFiles takes a front-end nodeId, a backend id, or a
         remote object, and the three are numbered separately. A ref is resolved
         to an object, so a control inside a shadow root stays reachable; the
         whole-document lookup stays on the nodeId that DOM.querySelector
         returned. On a page with a handful of nodes those two numbers happen to
         agree, which is why handing one over as the other looks correct until
         the page grows. */
      let where: { nodeId: number } | { objectId: string };
      if (options.ref !== undefined) {
        /* A ref can name anything, so the element comes back only when it
           really is a file input. Chrome's own rejection of anything else is
           "Node is not a file input element", which names neither the control
           nor the fix; asking the page puts the ref in the message. */
        const handle = await cdp.send<{
          result: { objectId?: string };
          exceptionDetails?: { exception?: { description?: string } };
        }>(
          "Runtime.evaluate",
          {
            expression: `(() => {
  /* A ref can name a control in a shadow root, which is why the lookup walks
     the trees the read walked rather than the top document alone. */
  const el = ${refExpression(options.ref)};
  if (el === null) throw new Error("gone");
  if (el.tagName !== "INPUT" || el.type !== "file") throw new Error("not-a-file-input");
  return el;
})()`,
          },
          page.sessionId,
        );
        const note = handle.exceptionDetails?.exception?.description ?? "";
        if (note.includes("not-a-file-input"))
          throw new Error(
            `browser_upload needs a file input; control ${options.ref} is not one`,
          );
        if (note !== "" || handle.result.objectId === undefined)
          throw new StaleRefError(
            `control ${options.ref} cannot be addressed: it is no longer on the page`,
          );
        where = { objectId: handle.result.objectId };
      } else {
        const doc = await cdp.send<{ root: { nodeId: number } }>(
          "DOM.getDocument",
          { depth: -1 },
          page.sessionId,
        );
        const queried = await cdp.send<{ nodeId: number }>(
          "DOM.querySelector",
          { nodeId: doc.root.nodeId, selector: 'input[type="file"]' },
          page.sessionId,
        );
        if (queried.nodeId === 0)
          throw new Error(
            "this page has no file input; pass a ref if the input is inside a frame",
          );
        where = { nodeId: queried.nodeId };
      }
      await cdp.send(
        "DOM.setFileInputFiles",
        { files: [...options.files], ...where },
        page.sessionId,
      );
      this.touch();
      await this.waitIdle();
      if (options.read === false)
        return {
          content: [
            {
              type: "text",
              text: `put ${options.files.length} file${options.files.length === 1 ? "" : "s"} into the input`,
            },
          ],
        };
      const snapshot = await this.readNow({ maxChars: 1_500 });
      return { content: [{ type: "text", text: formatSnapshot(snapshot) }] };
    });
  }

  async grab(options: GrabOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      const found = await this.evaluate<string>(`(() => {
  const scope = ${options.ref === undefined ? "document" : `(${refExpression(options.ref)} || document)`};
  const images = [];
  for (const node of scope.querySelectorAll("img,canvas,svg,video")) {
    const box = node.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) continue;
    const src = node.currentSrc || node.src || (node.tagName === "CANVAS" ? "canvas" : "");
    images.push({ tag: node.tagName.toLowerCase(), src: src || "", width: Math.round(box.width), height: Math.round(box.height), area: Math.round(box.width * box.height) });
  }
  if (images.length === 0 && scope !== document) {
    const box = scope.getBoundingClientRect();
    images.push({ tag: "element", src: "", width: Math.round(box.width), height: Math.round(box.height), area: Math.round(box.width * box.height) });
  }
  images.sort((a, b) => b.area - a.area);
  return JSON.stringify(images.slice(0, Math.max(1, ${Math.max(1, Math.min(options.count ?? 1, 20))})));
})()`);
      const candidates = JSON.parse(found) as Array<{
        tag: string;
        src: string;
        width: number;
        height: number;
        area: number;
      }>;
      this.touch();
      if (candidates.length === 0)
        throw new Error("this page is not showing a picture to save");
      const dir = join(stateDir(), "images");
      mkdirSync(dir, { recursive: true });
      const saved: string[] = [];
      let index = 0;
      for (const candidate of candidates) {
        index += 1;
        const stamp = `${options.name ?? "image"}-${Date.now()}-${index}`;
        if (candidate.src === "" || candidate.src === "canvas") {
          /* A drawing surface has no address: the pixels only exist on screen. */
          const { cdp, page } = await this.ensure();
          const shot = await cdp.send<{ data: string }>(
            "Page.captureScreenshot",
            { format: "png", captureBeyondViewport: false },
            page.sessionId,
          );
          const path = join(dir, `${stamp}.png`);
          writeFileSync(path, Buffer.from(shot.data, "base64"));
          saved.push(
            `${path} (from the screen, ${candidate.width}x${candidate.height})`,
          );
          continue;
        }
        if (candidate.src.startsWith("data:")) {
          const comma = candidate.src.indexOf(",");
          const header = candidate.src.slice(5, comma);
          const body: string = candidate.src.slice(comma + 1);
          const binary = header.includes("base64")
            ? body
            : Buffer.from(decodeURIComponent(body)).toString("base64");
          const path = join(dir, `${stamp}.png`);
          writeFileSync(path, Buffer.from(binary, "base64"));
          saved.push(
            `${path} (inline, ${candidate.width}x${candidate.height})`,
          );
          continue;
        }
        const fetched = await this.evaluate<string>(`(async () => {
  try {
    const reply = await fetch(${JSON.stringify(candidate.src)});
    const buffer = await reply.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return btoa(binary);
  } catch (error) { return "ERROR " + String(error && error.message ? error.message : error); }
})()`);
        if (fetched.startsWith("ERROR ")) {
          saved.push(
            `${candidate.src} — could not be read: ${fetched.slice(6)}`,
          );
          continue;
        }
        const path = join(dir, `${stamp}.png`);
        writeFileSync(path, Buffer.from(fetched, "base64"));
        saved.push(`${path} (${candidate.width}x${candidate.height})`);
      }
      return { content: [{ type: "text", text: saved.join("\n") }] };
    });
  }

  async evaluatePage(options: EvalOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      const code = options.code.trim();
      if (code === "") throw new Error("browser_eval needs code to run");
      const { cdp, page } = await this.ensure();
      /* Sent as an expression, not run through eval inside another expression,
         so a syntax error comes back as a page error rather than as this
         process's own mistake. */
      const reply = await cdp.send<{
        result?: { value?: unknown; description?: string; type?: string };
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string };
        };
      }>(
        "Runtime.evaluate",
        {
          expression:
            options.awaitPromise === false ? code : `(async () => (${code}))()`,
          returnByValue: true,
          awaitPromise: options.awaitPromise !== false,
          userGesture: true,
        },
        page.sessionId,
      );
      this.touch();
      if (reply.exceptionDetails !== undefined) {
        const detail = reply.exceptionDetails;
        throw new Error(
          detail.exception?.description ?? detail.text ?? "the page threw",
        );
      }
      const value = reply.result?.value;
      const text =
        value === undefined
          ? (reply.result?.description ?? "undefined")
          : typeof value === "string"
            ? value
            : JSON.stringify(value, null, 2);
      return { content: [{ type: "text", text }] };
    });
  }

  async run(steps: readonly Step[]): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      if (steps.length === 0)
        throw new Error("browser_do needs at least one step");
      const done: string[] = [];
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index] as Step;
        const at = `step ${index + 1}`;
        try {
          if (step.waitText !== undefined) {
            await this.awaitText(step.waitText, true);
            done.push(`${at}: saw ${JSON.stringify(step.waitText)}`);
            continue;
          }
          if (step.waitGone !== undefined) {
            await this.awaitText(step.waitGone, false);
            done.push(`${at}: ${JSON.stringify(step.waitGone)} went away`);
            continue;
          }
          if (step.waitUrl !== undefined) {
            await this.awaitUrl(step.waitUrl);
            done.push(`${at}: reached ${step.waitUrl}`);
            continue;
          }
          if (step.scroll !== undefined) {
            await this.scroll({ dy: step.scroll, read: false });
            done.push(`${at}: scrolled ${step.scroll}`);
            continue;
          }
          if (step.key !== undefined) {
            await this.key(step.key);
            done.push(`${at}: pressed ${step.key}`);
            continue;
          }
          if (step.field !== undefined && step.text !== undefined) {
            const point = await this.locate({ text: step.field });
            await this.mouseClick(point.x, point.y);
            /* The click put the caret in the control the name addressed, and
               `type` without a number only types into a control the last read
               numbered — which a click by name has already established. */
            await this.type({
              text: step.text,
              clear: true,
              ...(step.submit === true ? { submit: true } : {}),
            });
            done.push(`${at}: typed into ${JSON.stringify(step.field)}`);
            continue;
          }
          if (step.tap !== undefined) {
            const split = step.tap.split(",");
            if (
              split.length === 2 &&
              split.every((part) => Number.isFinite(Number(part)))
            ) {
              await this.mouseClick(Number(split[0]), Number(split[1]));
              done.push(`${at}: tapped ${step.tap}`);
            } else {
              const point = await this.locate({ text: step.tap });
              await this.mouseClick(point.x, point.y);
              done.push(`${at}: tapped ${JSON.stringify(step.tap)}`);
            }
            continue;
          }
          if (step.ref !== undefined) {
            this.addressable(step.ref);
            const point = await this.locate({ ref: step.ref });
            await this.mouseClick(point.x, point.y);
            done.push(`${at}: tapped control ${step.ref}`);
            continue;
          }
          if (step.text !== undefined) {
            await this.type({
              text: step.text,
              ...(step.submit === true ? { submit: true } : {}),
            });
            done.push(`${at}: typed ${step.text.length} characters`);
            continue;
          }
          throw new Error(
            "a step needs one of: ref, tap, field+text, text, key, scroll, wait_text, wait_gone, wait_url",
          );
        } catch (error) {
          /* Stop at the first step that cannot proceed, and say which one: a
             batch that reports "failed" without the step is unactionable. */
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `${at} could not proceed: ${reason}${done.length === 0 ? "" : ` (after ${done.join("; ")})`}`,
          );
        }
      }
      this.touch();
      return {
        content: [
          {
            type: "text",
            text: `${done.length} step${done.length === 1 ? "" : "s"} done\n${done.join("\n")}`,
          },
        ],
      };
    });
  }

  private async awaitText(needle: string, present: boolean): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 8_000) {
      const text = await this.evaluate<string>(
        "document.body ? document.body.innerText : ''",
      );
      const there = text.toLowerCase().includes(needle.toLowerCase());
      if (there === present) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(
      `${JSON.stringify(needle)} ${present ? "never appeared" : "never went away"} within 8000 ms`,
    );
  }

  private async awaitUrl(part: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 8_000) {
      const url = await this.evaluate<string>("location.href");
      if (url.includes(part)) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`the address never reached ${part} within 8000 ms`);
  }

  async dialog(options: DialogOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      await this.startWatching();
      const open = this.dialogOpen;
      if (open === null) {
        this.touch();
        return {
          content: [{ type: "text", text: "no dialog is open" }],
        };
      }
      if (options.accept === undefined && options.text === undefined) {
        this.touch();
        return {
          content: [
            {
              type: "text",
              text: `${open.type}: ${JSON.stringify(open.message)}${open.defaultValue === "" ? "" : ` (default ${JSON.stringify(open.defaultValue)})`}`,
            },
          ],
        };
      }
      const { cdp, page } = await this.ensure();
      await cdp.send(
        "Page.handleJavaScriptDialog",
        {
          accept: options.accept !== false,
          ...(options.text === undefined ? {} : { promptText: options.text }),
        },
        page.sessionId,
      );
      this.dialogOpen = null;
      this.touch();
      return {
        content: [
          {
            type: "text",
            text:
              options.accept === false
                ? "dismissed the dialog"
                : "accepted the dialog",
          },
        ],
      };
    });
  }

  async cookie(options: CookieOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      const { cdp, page } = await this.ensure();
      if (options.clear === true) {
        await cdp.send("Network.clearBrowserCookies", {}, page.sessionId);
        this.touch();
        return {
          content: [{ type: "text", text: "cleared the browser's cookies" }],
        };
      }
      if (options.set !== undefined && options.set !== "") {
        const url =
          options.url ?? (await this.evaluate<string>("location.href"));
        for (const pair of options.set.split(";")) {
          const cut = pair.indexOf("=");
          if (cut <= 0) continue;
          const name = pair.slice(0, cut).trim();
          const value = pair.slice(cut + 1).trim();
          if (name === "") continue;
          const sent = await cdp.send<{ success?: boolean }>(
            "Network.setCookie",
            {
              name,
              value,
              ...(options.domain === undefined
                ? { url }
                : { domain: options.domain }),
            },
            page.sessionId,
          );
          if (sent.success === false)
            throw new Error(`the browser refused the cookie ${name}`);
        }
        this.touch();
        return {
          content: [{ type: "text", text: `set ${options.set}` }],
        };
      }
      const url = options.url;
      const listed = await cdp.send<{
        cookies: Array<{
          name: string;
          value: string;
          domain: string;
          path: string;
          expires: number;
          httpOnly: boolean;
          secure: boolean;
        }>;
      }>(
        "Network.getCookies",
        url === undefined || url === "" ? {} : { urls: [url] },
        page.sessionId,
      );
      this.touch();
      if (listed.cookies.length === 0)
        return {
          content: {
            type: "text",
            text: "(this browser is keeping no cookies for that address)",
          } as never,
        };
      const rows = listed.cookies.map(
        (item) =>
          `${item.name}=${item.value} — ${item.domain}${item.path}${item.httpOnly ? " httpOnly" : ""}${item.secure ? " secure" : ""}${item.expires > 0 ? ` until ${new Date(item.expires * 1000).toISOString()}` : ""}`,
      );
      return { content: [{ type: "text", text: rows.join("\n") }] };
    });
  }

  async clipboard(options: ClipboardOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      if (options.set !== undefined) {
        const wrote = await this.evaluate<boolean>(`(async () => {
  try { await navigator.clipboard.writeText(${JSON.stringify(options.set)}); return true; }
  catch (error) { return false; }
})()`);
        this.touch();
        if (!wrote) throw new Error("the page refused the clipboard write");
        return {
          content: [
            {
              type: "text",
              text: `put ${options.set.length} characters on the clipboard; send a key to paste`,
            },
          ],
        };
      }
      const read = await this.evaluate<string>(`(async () => {
  try { return await navigator.clipboard.readText(); }
  catch (error) { return "ERROR " + String(error && error.message ? error.message : error); }
})()`);
      this.touch();
      if (read.startsWith("ERROR "))
        throw new Error(
          `the page would not hand over the clipboard: ${read.slice(6)}`,
        );
      return { content: [{ type: "text", text: read }] };
    });
  }

  async console(options: LogOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      await this.startWatching();
      const limit = Math.max(1, Math.min(options.limit ?? 50, 400));
      this.touch();
      const lines = this.consoleLines.slice(-limit);
      return {
        content: [
          {
            type: "text",
            text:
              lines.length === 0
                ? "(this page has produced no console output since it opened)"
                : lines.join("\n"),
          },
        ],
      };
    });
  }

  async network(options: NetworkOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      await this.startWatching();
      const limit = Math.max(1, Math.min(options.limit ?? 40, 200));
      const filter = (options.filter ?? "").toLowerCase();
      this.touch();
      const rows = this.responses
        .filter(
          (item) => filter === "" || item.url.toLowerCase().includes(filter),
        )
        .slice(0, limit);
      return {
        content: [
          {
            type: "text",
            text:
              rows.length === 0
                ? filter === ""
                  ? "(this page has received no responses since it opened)"
                  : `(no response matches ${JSON.stringify(filter)})`
                : rows
                    .map(
                      (item) =>
                        `${item.method} ${item.status === 0 ? "—" : String(item.status)} ${item.type} ${squashUrl(item.url)}`,
                    )
                    .join("\n"),
          },
        ],
      };
    });
  }

  async failed(options: LogOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      await this.startWatching();
      const limit = Math.max(1, Math.min(options.limit ?? 40, 200));
      this.touch();
      const rows = this.failedRequests.slice(0, limit);
      return {
        content: [
          {
            type: "text",
            text:
              rows.length === 0
                ? "(nothing this page asked for has failed since it opened)"
                : rows
                    .map(
                      (item) =>
                        `${item.type} ${item.error} ${item.url === "" ? "(address unknown)" : squashUrl(item.url)}`,
                    )
                    .join("\n"),
          },
        ],
      };
    });
  }

  async tabs(options: TabsOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      const { cdp, page } = await this.ensure();
      const listed = await cdp.send<{
        targetInfos: Array<{
          targetId: string;
          type: string;
          url: string;
          title: string;
        }>;
      }>("Target.getTargets");
      const pages = listed.targetInfos.filter((info) => info.type === "page");
      const action = options.action ?? "list";
      if (action === "switch" || action === "close") {
        const index = options.index ?? 0;
        const target = pages[index];
        if (target === undefined)
          throw new Error(
            `there ${pages.length === 1 ? "is" : "are"} ${pages.length} page${pages.length === 1 ? "" : "s"}; ${index} is not one of them`,
          );
        if (action === "close") {
          await cdp.send("Target.closeTarget", { targetId: target.targetId });
          this.touch();
          return {
            content: [
              { type: "text", text: `closed ${target.title || target.url}` },
            ],
          };
        }
        const attached = await cdp.send<{ sessionId: string }>(
          "Target.attachToTarget",
          { targetId: target.targetId, flatten: true },
          undefined,
        );
        this.page = {
          sessionId: attached.sessionId,
          targetId: target.targetId,
        };
        await cdp.send("Page.enable", {}, attached.sessionId);
        await cdp.send("Runtime.enable", {}, attached.sessionId);
        this.watching = false;
        await this.startWatching();
        this.touch();
        return {
          content: [
            { type: "text", text: `switched to ${target.title || target.url}` },
          ],
        };
      }
      this.touch();
      const rows = pages.map(
        (info, index) =>
          `${index === 0 ? "" : " "}[${index}] ${info.title === "" ? "(untitled)" : info.title} — ${squashUrl(info.url)}${info.targetId === page.targetId ? " (this one)" : ""}`,
      );
      return {
        content: [
          {
            type: "text",
            text: rows.length === 0 ? "(no pages are open)" : rows.join("\n"),
          },
        ],
      };
    });
  }

  async downloads(): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      const dir = profileDir(this.profile);
      const rows: string[] = [];
      const candidates = [
        join(dir, "Downloads"),
        join(stateDir(), "downloads"),
      ];
      for (const where of candidates) {
        if (!existsSync(where)) continue;
        for (const entry of readdirSync(where)) {
          const path = join(where, entry);
          const stat = statSync(path);
          if (!stat.isFile()) continue;
          rows.push(
            `${entry} — ${stat.size} bytes, ${new Date(stat.mtimeMs).toISOString()}`,
          );
        }
      }
      this.touch();
      return {
        content: [
          {
            type: "text",
            text:
              rows.length === 0
                ? "(this profile has downloaded nothing)"
                : rows.join("\n"),
          },
        ],
      };
    });
  }

  async media(options: MediaOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      await this.startWatching();
      const items = this.played.filter(
        (item) => options.all === true || item.kind === "Media",
      );
      this.touch();
      if (options.save !== undefined && options.save !== "") {
        const wanted = options.save;
        const picked =
          wanted === "main"
            ? items[0]
            : /^\d+$/.test(wanted)
              ? items[Number(wanted)]
              : items.find((item) => item.url.includes(wanted));
        if (picked === undefined)
          throw new Error(
            `nothing this page played matches ${JSON.stringify(wanted)}`,
          );
        const dir = join(stateDir(), "media");
        mkdirSync(dir, { recursive: true });
        const name = picked.url.split("/").pop() ?? "media";
        const path = join(
          dir,
          `${Date.now()}-${name.replace(/[^\w.-]/g, "_")}`,
        );
        const fetched = await this.evaluate<string>(`(async () => {
  const reply = await fetch(${JSON.stringify(picked.url)});
  const buffer = await reply.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
})()`);
        writeFileSync(path, Buffer.from(fetched, "base64"));
        return {
          content: [{ type: "text", text: `${path} (${picked.url})` }],
        };
      }
      const rows = items.map(
        (item, index) => `${index}. ${item.kind} ${squashUrl(item.url)}`,
      );
      return {
        content: [
          {
            type: "text",
            text:
              rows.length === 0
                ? "(this page has not asked for any media since it opened)"
                : rows.join("\n"),
          },
        ],
      };
    });
  }

  async pdf(): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      const { cdp, page } = await this.ensure();
      const printed = await cdp.send<{ data: string }>(
        "Page.printToPDF",
        { printBackground: true },
        page.sessionId,
      );
      const dir = join(stateDir(), "pdf");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `page-${Date.now()}.pdf`);
      writeFileSync(path, Buffer.from(printed.data, "base64"));
      this.touch();
      return { content: [{ type: "text", text: path }] };
    });
  }

  async prepare(options: PrepareOptions): Promise<ToolResult> {
    return this.serial(async () => {
      await this.ensure();
      await this.startWatching();
      const seconds = Math.max(1, Math.min(options.seconds ?? 2, 30));
      if (options.focus !== false) {
        /* A game only reads keys once its surface has focus, and the surface is
           rarely something a read numbered. */
        await this.evaluate(`(() => {
  const el = document.querySelector("canvas,video,embed,object,[tabindex]") || document.body;
  if (el && typeof el.focus === "function") el.focus();
  if (el) el.click && el.click();
  return true;
})()`);
      }
      const frames = await this.evaluate<number>(`(async () => {
  let count = 0;
  const until = performance.now() + ${seconds * 1000};
  await new Promise((resolve) => {
    const tick = () => { count += 1; if (performance.now() >= until) resolve(null); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setTimeout(resolve, ${seconds * 1000 + 500});
  });
  return count;
})()`);
      const surface = await this.evaluate<string>(`(() => {
  const found = [];
  for (const node of document.querySelectorAll("canvas,embed,object,video,[tabindex]")) {
    const box = node.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) continue;
    found.push({ tag: node.tagName.toLowerCase(), width: Math.round(box.width), height: Math.round(box.height) });
  }
  const flash = document.querySelector("object[type*='flash'],embed[type*='flash']");
  return JSON.stringify({ surfaces: found.slice(0, 6), flash: flash !== null });
})()`);
      const state = JSON.parse(surface) as {
        surfaces: Array<{ tag: string; width: number; height: number }>;
        flash: boolean;
      };
      const fps = Math.round((frames / seconds) * 10) / 10;
      this.touch();
      const lines = [
        `frame rate ${fps}/s over ${seconds}s`,
        state.surfaces.length === 0
          ? "no input surface larger than 40px was found"
          : `input surfaces: ${state.surfaces.map((item) => `${item.tag} ${item.width}x${item.height}`).join(", ")}`,
        state.flash
          ? "this page embeds a Flash player, which this browser cannot render"
          : "no Flash player is embedded",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    });
  }

  async close(): Promise<RouteState> {
    if (this.restTimer !== null) clearTimeout(this.restTimer);
    this.restTimer = null;
    const chrome = this.chrome;
    const cdp = this.cdp;
    this.chrome = null;
    this.cdp = null;
    this.page = null;
    this.runningHeadless = null;
    this.runningProfile = null;
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
