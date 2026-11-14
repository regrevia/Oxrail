/* The MCP tool surface for the opt-in Browser Control route.
 *
 * One entry per tool. The JSON Schema shown to a model and the argument
 * validator are both generated from the same property table, so they cannot
 * drift apart. The route is the only thing that touches a browser.
 */

import type {
  BrowserRoute,
  DigestOptions,
  LoginState,
  OpenOptions,
  ReadOptions,
  RouteState,
  ShotOptions,
  Snapshot,
  ToolResult,
} from "./types.js";
import { RouteClosedError, StaleRefError } from "./types.js";

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type ArgumentKind = "string" | "boolean" | "integer" | "enum";

interface PropertyDefinition {
  readonly kind: ArgumentKind;
  readonly description: string;
  readonly values?: readonly string[];
  readonly extras?: Readonly<Record<string, unknown>>;
}

type Arguments = Readonly<Record<string, unknown>>;

interface ToolSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, PropertyDefinition>>;
  readonly required?: readonly string[];
  readonly run: (route: BrowserRoute, args: Arguments) => Promise<ToolResult>;
}

/** Raised while validating a tool call, before the route is touched. */
class ArgumentError extends Error {
  override readonly name = "ArgumentError";
}

const TOOLS: readonly ToolSpec[] = [
  {
    name: "browser_open",
    title: "Open the browser",
    description:
      "Start this route's own Chrome, or reuse the one already running, and return its state. Call it before any other browser tool and after browser_close. This browser is not the person's browser: it has its own profile, windows and sign-ins. The first open of a profile pays a cold start.",
    properties: {
      url: {
        kind: "string",
        description: "Page to open. Defaults to a blank page.",
      },
      headless: {
        kind: "boolean",
        description: "Run without a visible window. Defaults to true.",
        extras: { default: true },
      },
      profile: {
        kind: "string",
        description:
          'Named profile to use. Defaults to "default"; sign-ins are kept per profile directory.',
        extras: { default: "default" },
      },
    },
    async run(route, args) {
      const url = stringValue(args, "url");
      const headless = booleanValue(args, "headless");
      const profile = stringValue(args, "profile");
      const options: OpenOptions = {
        ...(url === undefined ? {} : { url }),
        ...(headless === undefined ? {} : { headless }),
        ...(profile === undefined ? {} : { profile }),
      };
      return textResult(formatState(await route.open(options)));
    },
  },
  {
    name: "browser_view",
    title: "Read the page",
    description:
      'Read the current page as text. This is the cheap way to see the words and the controls: each control sits on its own line as [12] button "Sign in", and 12 is the ref that browser_click and browser_type take. Use browser_shot only when layout or appearance matters. mode narrows the read to links or form controls; maxChars stops it early.',
    properties: {
      mode: {
        kind: "enum",
        values: ["text", "links", "forms"],
        description:
          "What to read: page text (default), links only, or form controls only.",
      },
      maxChars: {
        kind: "integer",
        description: "Stop reading after this many characters.",
        extras: { minimum: 1 },
      },
    },
    async run(route, args) {
      const mode = stringValue(args, "mode");
      const maxChars = integerValue(args, "maxChars");
      const options: ReadOptions = {
        ...(mode === undefined
          ? {}
          : { mode: mode as "text" | "links" | "forms" }),
        ...(maxChars === undefined ? {} : { maxChars }),
      };
      return textResult(formatSnapshot(await route.read(options)));
    },
  },
  {
    name: "browser_read",
    title: "Read only what you need",
    description:
      'Read the page without taking the whole DOM. mode:"article" gives the reading column as Markdown; mode:"map" gives the headings and the numbered controls with no body text, to decide what to read next; mode:"query" plus a query gives only the passages that answer it, ranked locally, so a long page costs a few hundred words; mode:"changed" gives only what appeared since the last read. Prefer this over browser_view on any page longer than a few screens.',
    properties: {
      mode: {
        kind: "enum",
        values: ["article", "map", "query", "changed"],
        description:
          "article: the text. map: the shape. query: the passages that answer a query. changed: only what is new.",
      },
      query: {
        kind: "string",
        description: "What you are looking for, for mode query.",
      },
      maxChars: {
        kind: "integer",
        description: "Stop after this many characters. Default 2000.",
        extras: { minimum: 200 },
      },
    },
    async run(route, args) {
      const mode = stringValue(args, "mode") ?? "article";
      if (
        mode !== "article" &&
        mode !== "map" &&
        mode !== "query" &&
        mode !== "changed"
      )
        return failure(
          `unknown mode ${JSON.stringify(mode)}: use article, map, query or changed`,
        );
      const query = stringValue(args, "query");
      if (mode === "query" && (query ?? "").trim() === "")
        return failure("mode query needs a query: what are you looking for?");
      const maxChars = integerValue(args, "maxChars");
      const options: DigestOptions = {
        mode,
        ...(query === undefined ? {} : { query }),
        ...(maxChars === undefined ? {} : { maxChars }),
      };
      return textResult(formatSnapshot(await route.digest(options)));
    },
  },
  {
    name: "browser_click",
    title: "Click a control",
    description:
      "Activate one control: give its ref from the last browser_view, or its visible text. Pass exactly one of the two. A click usually changes the page, so read again before the next ref-based call.",
    properties: {
      ref: {
        kind: "integer",
        description: "Number of a control from the last browser_view.",
      },
      text: {
        kind: "string",
        description: "Visible text of the control to click.",
      },
    },
    async run(route, args) {
      const ref = integerValue(args, "ref");
      const text = stringValue(args, "text");
      if (ref !== undefined && text !== undefined) {
        return failure('pass either "ref" or "text", not both.');
      }
      if (ref !== undefined) return route.click({ ref });
      if (text !== undefined) return route.click({ text });
      return failure('pass "ref" from the last browser_view, or "text".');
    },
  },
  {
    name: "browser_type",
    title: "Type into a control",
    description:
      "Type text into a control: give the text and, when known, the ref of the field from the last browser_view. clear empties the field first; submit presses Enter afterwards. For a bare key press use browser_key.",
    properties: {
      ref: {
        kind: "integer",
        description: "Number of the field from the last browser_view.",
      },
      text: {
        kind: "string",
        description: "Text to type.",
      },
      clear: {
        kind: "boolean",
        description: "Empty the field before typing.",
        extras: { default: false },
      },
      submit: {
        kind: "boolean",
        description: "Press Enter after typing.",
        extras: { default: false },
      },
    },
    required: ["text"],
    async run(route, args) {
      const text = stringValue(args, "text");
      if (text === undefined) return failure('"text" is required.');
      const ref = integerValue(args, "ref");
      const clear = booleanValue(args, "clear");
      const submit = booleanValue(args, "submit");
      return route.type({
        text,
        ...(ref === undefined ? {} : { ref }),
        ...(clear === undefined ? {} : { clear }),
        ...(submit === undefined ? {} : { submit }),
      });
    },
  },
  {
    name: "browser_key",
    title: "Press a key",
    description:
      "Press a single key on the page, such as Enter, Tab, Escape or ArrowDown. Use it when the key matters and no control needs a ref; type text with browser_type instead.",
    properties: {
      key: {
        kind: "string",
        description: "Key name, for example Enter or Tab.",
      },
    },
    required: ["key"],
    async run(route, args) {
      const key = stringValue(args, "key");
      if (key === undefined) return failure('"key" is required.');
      return route.key(key);
    },
  },
  {
    name: "browser_nav",
    title: "Navigate",
    description:
      "Move the browser to a url, back one page, or reload. Use browser_click for a link already on the page; use this when the destination is known.",
    properties: {
      url: {
        kind: "string",
        description: "Page to open.",
      },
      back: {
        kind: "boolean",
        description: "Go back one history entry.",
        extras: { default: false },
      },
      reload: {
        kind: "boolean",
        description: "Reload the current page.",
        extras: { default: false },
      },
    },
    async run(route, args) {
      const url = stringValue(args, "url");
      const back = booleanValue(args, "back");
      const reload = booleanValue(args, "reload");
      if (url === undefined && back !== true && reload !== true) {
        return failure("pass url, back or reload.");
      }
      return textResult(
        formatState(
          await route.nav({
            ...(url === undefined ? {} : { url }),
            ...(back === undefined ? {} : { back }),
            ...(reload === undefined ? {} : { reload }),
          }),
        ),
      );
    },
  },
  {
    name: "browser_shot",
    title: "Take a screenshot",
    description:
      "Capture the page as a PNG: the viewport by default, or the full page with fullPage. Use it when layout, color or an image matters; browser_view is cheaper for text. Returns the image plus the saved file path.",
    properties: {
      fullPage: {
        kind: "boolean",
        description: "Capture the whole page instead of the viewport.",
        extras: { default: false },
      },
    },
    async run(route, args) {
      const fullPage = booleanValue(args, "fullPage");
      const options: ShotOptions = fullPage === undefined ? {} : { fullPage };
      const shot = await route.shot(options);
      return {
        content: [
          {
            type: "image",
            data: shot.png,
            mimeType: "image/png",
          },
          { type: "text", text: `saved ${shot.path}` },
        ],
      };
    },
  },
  {
    name: "browser_state",
    title: "Browser state",
    description:
      "Report the browser: running or closed, profile, current url and title, headless, and the idle clock (idleMs, closesInMs). Cheap; use it to decide whether browser_open is needed and how long the browser will stay.",
    properties: {},
    async run(route) {
      return textResult(formatState(await route.state()));
    },
  },
  {
    name: "browser_login",
    title: "Saved sign-in",
    description:
      "Report the saved sign-in for the current profile. Sign-ins persist per profile directory, so this says whether a sign-in already exists; it does not read, fill or submit login forms.",
    properties: {},
    async run(route) {
      return textResult(formatLogin(await route.login()));
    },
  },
  {
    name: "browser_close",
    title: "Close the browser",
    description:
      "Close the browser now and release its process. Do it when the work is done; the next browser_open cold-starts Chrome again. The browser also closes by itself after the idle window.",
    properties: {},
    async run(route) {
      return textResult(formatState(await route.close()));
    },
  },
];

/** The tools as the host sees them, in the order the model should see them. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] =
  TOOLS.map(toDefinition);

const TOOL_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(
  TOOLS.map((tool) => [tool.name, tool]),
);

/**
 * Answer a tool call with an `isError` result instead of a stack trace.
 *
 * Every thrown error is turned into text a caller can act on: no browser means
 * open one, a stale ref means read the page again, anything else is its own
 * message.
 */
export async function dispatch(
  route: BrowserRoute,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = TOOL_BY_NAME.get(name);
  if (tool === undefined) return unknownTool(name);
  try {
    const validated = validate(tool, args);
    return await tool.run(route, validated);
  } catch (error) {
    return failure(describeError(error));
  }
}

/** The result for a tool name this server does not have. */
export function unknownTool(name: string): ToolResult {
  return failure(`unknown tool: ${name}`);
}

function validate(tool: ToolSpec, raw: unknown): Arguments {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ArgumentError(`${tool.name}: arguments must be an object.`);
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(tool.properties, key)) {
      throw new ArgumentError(`${tool.name}: unexpected argument "${key}".`);
    }
  }
  const output: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(tool.properties)) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    output[key] = coerce(tool.name, key, property, value);
  }
  for (const key of tool.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(output, key)) {
      throw new ArgumentError(`${tool.name}: "${key}" is required.`);
    }
  }
  return output;
}

function coerce(
  tool: string,
  key: string,
  property: PropertyDefinition,
  value: unknown,
): unknown {
  switch (property.kind) {
    case "string":
      if (typeof value !== "string") {
        throw new ArgumentError(`${tool}: "${key}" must be a string.`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new ArgumentError(`${tool}: "${key}" must be a boolean.`);
      }
      return value;
    case "integer": {
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        return value;
      }
      if (typeof value === "string" && /^-?\d+$/.test(value)) {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed)) return parsed;
      }
      throw new ArgumentError(`${tool}: "${key}" must be an integer.`);
    }
    case "enum": {
      const values = property.values ?? [];
      if (typeof value !== "string" || !values.includes(value)) {
        throw new ArgumentError(
          `${tool}: "${key}" must be one of ${values.join(", ")}.`,
        );
      }
      return value;
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof RouteClosedError) {
    return "no browser is running. Call browser_open first.";
  }
  if (error instanceof StaleRefError) {
    return "the page changed since the last read. Call browser_view and use the new refs.";
  }
  if (error instanceof Error) {
    return error.message === "" ? "browser tool failed." : error.message;
  }
  return "browser tool failed.";
}

function stringValue(args: Arguments, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function integerValue(args: Arguments, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

function booleanValue(args: Arguments, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function failure(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function formatSnapshot(snapshot: Snapshot): string {
  const lines: string[] = [];
  if (snapshot.text !== "") lines.push(snapshot.text);
  for (const control of snapshot.controls) {
    if (control.name === "") continue;
    lines.push(`[${control.ref}] ${control.role} "${control.name}"`);
  }
  if (lines.length === 0) lines.push("(blank page)");
  if (snapshot.url !== "") lines.push(`url: ${snapshot.url}`);
  if (snapshot.title !== "") lines.push(`title: ${snapshot.title}`);
  /* What the read cost and what it left behind, so a caller can tell a short
     page from a page it is only seeing part of. */
  if (snapshot.chars !== undefined) lines.push(`chars: ${snapshot.chars}`);
  if (snapshot.words !== undefined) lines.push(`words: ${snapshot.words}`);
  if (snapshot.matched !== undefined && snapshot.total !== undefined)
    lines.push(`passages: ${snapshot.matched} of ${snapshot.total} blocks`);
  if ((snapshot.blindFrames ?? 0) > 0) {
    lines.push(
      `frames not read: ${snapshot.blindFrames} (cross-origin, so the page cannot be read through here)`,
    );
  }
  if (snapshot.truncated) {
    lines.push(`controls: ${snapshot.controls.length}`, "truncated: true");
  }
  return lines.join("\n");
}

function formatState(state: RouteState): string {
  if (!state.running) {
    return [`running: false`, `profile: ${state.profile}`].join("\n");
  }
  return [
    `running: ${state.running}`,
    `pid: ${state.pid === null ? "null" : state.pid}`,
    `profile: ${state.profile}`,
    `url: ${state.url === null ? "null" : state.url}`,
    `title: ${state.title === null ? "null" : state.title}`,
    `headless: ${state.headless}`,
    `idleMs: ${state.idleMs}`,
    `closesInMs: ${state.closesInMs === null ? "null" : state.closesInMs}`,
  ].join("\n");
}

function formatLogin(state: LoginState): string {
  const lines = [`profile: ${state.profile}`, `saved: ${state.saved}`];
  if (state.text !== "") lines.push(state.text);
  return lines.join("\n");
}

function toDefinition(tool: ToolSpec): ToolDefinition {
  const properties: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(tool.properties)) {
    properties[key] = toPropertySchema(property);
  }
  const inputSchema: Record<string, unknown> = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (tool.required !== undefined && tool.required.length > 0) {
    inputSchema.required = [...tool.required];
  }
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema,
  };
}

function toPropertySchema(
  property: PropertyDefinition,
): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: property.kind === "enum" ? "string" : property.kind,
    description: property.description,
  };
  if (property.values !== undefined) schema.enum = [...property.values];
  if (property.extras !== undefined) Object.assign(schema, property.extras);
  return schema;
}
