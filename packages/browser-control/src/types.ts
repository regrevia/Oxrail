/* The opt-in Browser Control route, as the rest of the package sees it.
 *
 * This route is deliberately outside the Native Computer Use contract: it owns
 * a Chromium process of its own instead of interposing on the person's browser.
 * Everything here exists so the MCP surface and the engine can be tested apart.
 */

/** One content block in an MCP tool result. */
export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    };

/** What a tool call returns to the host. */
export interface ToolResult {
  readonly content: readonly ContentBlock[];
  readonly isError?: boolean;
}

/** A control the last read numbered, so a later call can address it by number. */
export interface Control {
  readonly ref: number;
  readonly role: string;
  readonly name: string;
  readonly tag?: string;
  /** Which frame the control lives in: 0 is the page, 1 is the first frame.
   * Its ref already encodes this, so a click needs the number; this is for a
   * reader who wants to know the page is composed. */
  readonly frame?: number;
}

/** One page reading: what it says, where it is, and the controls on it. */
export interface Snapshot {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly controls: readonly Control[];
  readonly truncated: boolean;
  /** Which ceiling the reading stopped at, when it stopped at one: `controls`,
   * `chars`, `nodes`, `headings` or `frames`. A caller that knows which one was
   * hit knows what to do next — read `map` when controls ran out, `article` when
   * characters did — where a bare `truncated` only says "there is more". */
  readonly limit?: string | undefined;
  /** Frames whose contents could not be read, so a short reading of a page
   * that visibly has more is explained instead of looking complete. */
  readonly blindFrames?: number;
  /** Which reading produced this, when it was one of the cheap ones. */
  readonly mode?: ReadMode | "text" | "links" | "forms";
  /** Words in the page, so a caller can see how much it did not read. */
  readonly words?: number;
  /** Characters in `text`, which is what a context budget actually spends. */
  readonly chars?: number;
  /** Passages shown, against the blocks they were chosen from. */
  readonly matched?: number;
  readonly total?: number;
  /** Named controls the page has but this reading did not print, because the
   * question did not touch them or the ceiling ran out first. They are still
   * addressable — `hand` takes the whole list — so this is a count of what is
   * not on screen, not of what is gone. */
  readonly omitted?: number;
}

/** A cheap reading of the page: what to take, and what to look for. */
export interface DigestOptions {
  readonly mode: ReadMode;
  /** The question, for `query`. */
  readonly query?: string;
  /** Character ceiling for the returned text. */
  readonly maxChars?: number;
}

/** Where the browser is right now, and how long it will stay. */
export interface RouteState {
  readonly running: boolean;
  readonly pid: number | null;
  readonly profile: string;
  readonly url: string | null;
  readonly title: string | null;
  readonly headless: boolean;
  /** Milliseconds since the last call that used the browser. */
  readonly idleMs: number;
  /** Milliseconds until the idle browser is closed, or `null` when it is in use. */
  readonly closesInMs: number | null;
}

/** Options a host may pass when first opening the route. */
export interface OpenOptions {
  readonly url?: string;
  readonly headless?: boolean;
  readonly profile?: string;
}

/** How much of a page to read. */
export interface ReadOptions {
  readonly mode?: "text" | "links" | "forms";
  readonly maxChars?: number;
}

/**
 * The reading modes that cost a few hundred words instead of a page.
 *
 * `article` renders the reading column as Markdown. `map` lists the controls and
 * the headings and counts the words, without carrying the words. `query` picks
 * the passages that answer a question, ranked locally. `changed` re-reads and
 * returns only what the last read did not already say.
 */
export type ReadMode = "article" | "map" | "query" | "changed";

/** A screenshot, base64 for the host plus the file it was also written to. */
export interface ShotOptions {
  readonly fullPage?: boolean;
}

export interface Shot {
  readonly png: string;
  readonly path: string;
}

/** What the person's saved sign-in is doing right now. */
export interface LoginState {
  readonly profile: string;
  readonly saved: boolean;
  readonly text: string;
}

/** The engine the MCP tools call. Implemented by `route.ts`. */
export interface BrowserRoute {
  open(options?: OpenOptions): Promise<RouteState>;
  read(options?: ReadOptions): Promise<Snapshot>;
  /** Read the page cheaply: the reading column, a map, an answer, or a delta. */
  digest(options: DigestOptions): Promise<Snapshot>;
  click(target: { ref?: number; text?: string }): Promise<ToolResult>;
  type(target: {
    ref?: number;
    text: string;
    submit?: boolean;
    clear?: boolean;
  }): Promise<ToolResult>;
  key(key: string): Promise<ToolResult>;
  nav(options: {
    url?: string;
    back?: boolean;
    reload?: boolean;
  }): Promise<RouteState>;
  shot(options?: ShotOptions): Promise<Shot>;
  state(): Promise<RouteState>;
  login(): Promise<LoginState>;
  close(): Promise<RouteState>;

  /** Locate what the page says without reading all of it. */
  find(options: FindOptions): Promise<ToolResult>;
  /** Read the rows a selector matches, one line each. */
  extract(options: ExtractOptions): Promise<ToolResult>;
  /** Look at a self-drawn page as a grid of letters. */
  look(options: LookOptions): Promise<ToolResult>;
  /** Wait for one page condition instead of reading in a loop. */
  wait(options: WaitOptions): Promise<ToolResult>;
  /** Wheel-scroll from the middle of the viewport. */
  scroll(options: ScrollOptions): Promise<ToolResult>;
  /** Move the pointer onto a control so hover-only menus open. */
  hover(options: HoverOptions): Promise<ToolResult>;
  /** Put a checkable control into a known state. */
  check(options: CheckOptions): Promise<ToolResult>;
  /** Choose an option in a dropdown. */
  select(options: SelectOptions): Promise<ToolResult>;
  /** Drag with real pointer steps. */
  drag(options: DragOptions): Promise<ToolResult>;
  /** Put files into a file input without opening a chooser. */
  upload(options: UploadOptions): Promise<ToolResult>;
  /** Save the picture the page is showing. */
  grab(options: GrabOptions): Promise<ToolResult>;
  /** Run JavaScript in the page. */
  evaluatePage(options: EvalOptions): Promise<ToolResult>;
  /** Run several steps in one call. */
  run(steps: readonly Step[]): Promise<ToolResult>;
  /** Answer the dialog the page is showing. */
  dialog(options: DialogOptions): Promise<ToolResult>;
  /** Read or change the browser's cookies. */
  cookie(options: CookieOptions): Promise<ToolResult>;
  /** Read or write the browser's clipboard. */
  clipboard(options: ClipboardOptions): Promise<ToolResult>;
  /** Console lines and errors the page produced. */
  console(options: LogOptions): Promise<ToolResult>;
  /** Responses the page received. */
  network(options: NetworkOptions): Promise<ToolResult>;
  /** Requests the page tried and that failed. */
  failed(options: LogOptions): Promise<ToolResult>;
  /** Pages open in the browser. */
  tabs(options: TabsOptions): Promise<ToolResult>;
  /** Files this browser downloaded. */
  downloads(): Promise<ToolResult>;
  /** What this page played. */
  media(options: MediaOptions): Promise<ToolResult>;
  /** Print the page to a PDF. */
  pdf(): Promise<ToolResult>;
  /** Get a self-drawn page ready in one call. */
  prepare(options: PrepareOptions): Promise<ToolResult>;
  mode(options?: ModeOptions): Promise<ToolResult>;
  ask(options: AskOptions): Promise<ToolResult>;
  review(options?: ReviewOptions): Promise<ToolResult>;
  reviewVerdict(options?: ReviewVerdictOptions): Promise<ToolResult>;
  resume(): Promise<ToolResult>;
}

/** Raised when the route is asked to do something before it was opened. */
export class RouteClosedError extends Error {
  override readonly name = "RouteClosedError";
}

/** Raised when a call names a control the last read did not number. */
export class StaleRefError extends Error {
  override readonly name = "StaleRefError";
}

/** Options for the tools added alongside the first eleven. */
export interface FindOptions {
  readonly query: string;
  readonly regex?: boolean;
  readonly limit?: number;
}

export interface ExtractOptions {
  readonly select: string;
  readonly ref?: number;
  readonly limit?: number;
}

export interface LookOptions {
  readonly cols?: number;
  readonly region?: string;
  readonly items?: number;
  readonly diff?: boolean;
}

export interface WaitOptions {
  readonly text?: string;
  readonly gone?: string;
  readonly url?: string;
  readonly quiet?: boolean;
  readonly timeoutMs?: number;
}

export interface ScrollOptions {
  readonly dy?: number;
  readonly dx?: number;
  readonly read?: boolean;
}

export interface HoverOptions {
  readonly ref?: number;
  readonly text?: string;
  readonly read?: boolean;
}

export interface CheckOptions {
  readonly ref: number;
  readonly checked?: boolean;
  readonly read?: boolean;
}

export interface SelectOptions {
  readonly ref?: number;
  readonly field?: string;
  readonly value: string;
  readonly read?: boolean;
}

export interface DragOptions {
  readonly fromRef?: number;
  readonly fromPoint?: string;
  readonly toRef?: number;
  readonly toPoint?: string;
  readonly read?: boolean;
}

export interface UploadOptions {
  readonly ref?: number;
  readonly files: readonly string[];
  readonly read?: boolean;
}

export interface GrabOptions {
  readonly ref?: number;
  readonly name?: string;
  readonly count?: number;
}

export interface EvalOptions {
  readonly code: string;
  readonly awaitPromise?: boolean;
}

export interface DialogOptions {
  readonly accept?: boolean;
  readonly text?: string;
}

export interface CookieOptions {
  readonly url?: string;
  readonly set?: string;
  readonly domain?: string;
  readonly clear?: boolean;
}

export interface ClipboardOptions {
  readonly set?: string;
}

export interface LogOptions {
  readonly limit?: number;
}

export interface NetworkOptions {
  readonly filter?: string;
  readonly limit?: number;
}

export interface TabsOptions {
  readonly action?: "list" | "switch" | "close";
  readonly index?: number;
}

export interface MediaOptions {
  readonly all?: boolean;
  readonly save?: string;
  readonly watch?: boolean;
}

export interface PrepareOptions {
  readonly seconds?: number;
  readonly focus?: boolean;
}

/** One step of a batched call. */
/** Whether the browser draws a window the person can see. */
export type Display = "visible" | "headless";

export interface ModeOptions {
  /** Leave it out to ask which mode is in force right now. */
  readonly display?: Display;
}

export interface AskOptions {
  /** The name of the box to type into, when a ref does not name it. */
  readonly text?: string;
  readonly ref?: number;
  /** What to say. Separate from `text` so a named box can hold a long message. */
  readonly said?: string;
  readonly submit?: boolean;
  readonly timeoutMs?: number;
}

export interface ReviewOptions {
  readonly text?: string;
  readonly ref?: number;
  readonly said?: string;
  readonly timeoutMs?: number;
}

export type Verdict = "fixed" | "verified" | "invalid" | "open";

export interface VerdictMark {
  readonly point: number;
  readonly verdict: Verdict;
}

export interface ReviewVerdictOptions {
  readonly marks?: readonly VerdictMark[];
}

export interface Step {
  readonly ref?: number;
  readonly tap?: string;
  readonly text?: string;
  readonly field?: string;
  readonly key?: string;
  readonly scroll?: number;
  readonly submit?: boolean;
  readonly waitText?: string;
  readonly waitGone?: string;
  readonly waitUrl?: string;
}
