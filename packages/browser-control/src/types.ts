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
}

/** One page reading: what it says, where it is, and the controls on it. */
export interface Snapshot {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly controls: readonly Control[];
  readonly truncated: boolean;
  /** Which reading produced this, when it was one of the cheap ones. */
  readonly mode?: ReadMode | "text" | "links" | "forms";
  /** Words in the page, so a caller can see how much it did not read. */
  readonly words?: number;
  /** Characters in `text`, which is what a context budget actually spends. */
  readonly chars?: number;
  /** Passages shown, against the blocks they were chosen from. */
  readonly matched?: number;
  readonly total?: number;
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
}

/** Raised when the route is asked to do something before it was opened. */
export class RouteClosedError extends Error {
  override readonly name = "RouteClosedError";
}

/** Raised when a call names a control the last read did not number. */
export class StaleRefError extends Error {
  override readonly name = "StaleRefError";
}
