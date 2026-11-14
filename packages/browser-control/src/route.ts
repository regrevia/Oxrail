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
  type DigestOptions,
  type LoginState,
  type OpenOptions,
  type ReadOptions,
  type RouteState,
  type Shot,
  type ShotOptions,
  type Snapshot,
  type ToolResult,
} from "./types.js";
import {
  articleExpression,
  blocksExpression,
  deltaOf,
  evidence,
  passagesToText,
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

/** Where refs of controls inside frames start, so one number says which
 * document to look in. Main-frame refs stay small and unchanged. */
export const FRAME_BASE = 900_000;
/** Room for one frame's own refs between FRAME_BASE steps. */
export const FRAME_SLOT = 100_000;

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
  if (unseen.length > 0) truncated = true;

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
      if (controls.length >= MAX_CONTROLS) { truncated = true; return; }
      nodes += 1;
      if (nodes > MAX_NODES) { truncated = true; return; }
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
    if (controls.length >= MAX_CONTROLS) { truncated = true; break; }
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
  if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); truncated = true; }
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
      if (outline.length >= 80) { truncated = true; break; }
    }
    text = outline.length > 0 ? outline.join("\\n") : "(no headings)";
  }

  return {
    url: location.href,
    title: document.title || "",
    text,
    controls,
    truncated,
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
  return { url: location.href, title: document.title || "", words: runs === null ? 0 : runs.length };
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
  private handed: { url: string; refs: ReadonlySet<number> } | null = null;

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
        /* Carried out of the page expression, or a caller counting only what it
           received would call a page with an unreadable frame complete. */
        blindFrames: snapshot.blindFrames ?? 0,
        words: snapshot.words ?? 0,
        chars: snapshot.text.length,
      };
    });
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
        const text = passagesToText(found);
        return {
          url: page.url,
          title: page.title,
          text:
            text === ""
              ? `(nothing on this page answers ${JSON.stringify(asked)})`
              : text,
          controls: page.controls,
          truncated: found.rows.length < found.matched,
          mode: "query",
          words: page.words ?? 0,
          chars: text.length,
          matched: found.rows.length,
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
  const own = el.getBoundingClientRect();
  if (own.width < 2 || own.height < 2) return { found: true, frames: holders.length, label, blocked: "it has no area on screen to click" };
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
  const at = { x: x + own.left + own.width / 2, y: y + own.top + own.height / 2 };
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
      else if (this.handed === null)
        throw new StaleRefError(
          `nothing has been read, so ${JSON.stringify(target.text ?? "")} is not known to be on this page — call browser_view first`,
        );
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
