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
  Step,
  ToolResult,
  Verdict,
  VerdictMark,
} from "./types.js";
import { RouteClosedError, StaleRefError } from "./types.js";
import { formatSnapshot } from "./read.js";

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type ArgumentKind =
  | "string"
  | "boolean"
  | "integer"
  | "enum"
  | "strings"
  | "steps"
  | "marks";

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
        description:
          "Hide the window. Defaults to false: the browser is visible unless this call says otherwise.",
        extras: { default: false },
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
      'Read the current page as text. This is the cheap way to see the words and the controls: each control sits on its own line as [12] button "Sign in", and 12 is the ref that browser_click and browser_type take. A run of near-identical controls is folded onto one line as [0]-[39] button "Item 0" .. "Item 39" (40 controls, one line), and every number in that range still works. Use browser_shot only when layout or appearance matters. mode narrows the read to links or form controls; maxChars stops it early.',
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
      "Activate one control: give its ref from the last browser_view, or its visible text. Pass exactly one of the two. There is no way to click a coordinate: the ref a read returned is the whole address, so a number no read produced is refused. A click usually changes the page, so read again before the next ref-based call.",
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
      "Type text into a control: give the text and, when known, the ref of the field from the last browser_view. A ref comes from a read; a number no read produced is refused. clear empties the field first; submit presses Enter afterwards. For a bare key press use browser_key.",
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
    name: "browser_find",
    title: "Search the page",
    description:
      'Search the controls and the words on the page and get back only the hits, each with the number a click takes. Use it when the page is too long to read: browser_view answers "what is here", this answers "where is this". Matches a lowercased substring unless regex is true; limit caps the rows.',
    properties: {
      query: {
        kind: "string",
        description: "What to look for, in a control name or in the page text.",
      },
      regex: {
        kind: "boolean",
        description: "Treat query as a regular expression.",
        extras: { default: false },
      },
      limit: {
        kind: "integer",
        description: "Stop after this many hits. Defaults to 40.",
        extras: { minimum: 1, maximum: 200 },
      },
    },
    required: ["query"],
    async run(route, args) {
      const query = stringValue(args, "query");
      if (query === undefined)
        throw new ArgumentError('browser_find: "query" is required.');
      const regex = booleanValue(args, "regex");
      const limit = integerValue(args, "limit");
      return route.find({
        query,
        ...(regex === undefined ? {} : { regex }),
        ...(limit === undefined ? {} : { limit }),
      });
    },
  },
  {
    name: "browser_extract",
    title: "Extract by selector",
    description:
      "Pull the rows that one CSS selector describes — every link in a list, every price in a grid — without reading the rest of the page. Scope it to one control with ref, which is the number browser_view printed; any element on the page is only reachable that way.",
    properties: {
      select: { kind: "string", description: "CSS selector to read." },
      ref: {
        kind: "integer",
        description:
          "Read only inside this control, by the number browser_view printed.",
      },
      limit: {
        kind: "integer",
        description: "Stop after this many rows. Defaults to 50.",
        extras: { minimum: 1, maximum: 500 },
      },
    },
    required: ["select"],
    async run(route, args) {
      const select = stringValue(args, "select");
      if (select === undefined)
        throw new ArgumentError('browser_extract: "select" is required.');
      const ref = integerValue(args, "ref");
      const limit = integerValue(args, "limit");
      return route.extract({
        select,
        ...(ref === undefined ? {} : { ref }),
        ...(limit === undefined ? {} : { limit }),
      });
    },
  },
  {
    name: "browser_look",
    title: "Look at the page as a grid",
    description:
      'See the page without image tokens: it comes back as a grid of letters, one letter per cell, so a colour or a layout can be read as text. Use it for a canvas, a chart, a game or a page that draws itself, where there are no words to read. region crops to "x,y,width,height"; items adds more cells; diff reports only the cells that changed since the last look.',
    properties: {
      cols: {
        kind: "integer",
        description: "Cells across. Defaults to 12.",
        extras: { minimum: 2, maximum: 64 },
      },
      region: {
        kind: "string",
        description: 'Crop to this box in pixels: "x,y,width,height".',
      },
      items: {
        kind: "integer",
        description: "Cells down. Defaults to the height the grid implies.",
        extras: { minimum: 2, maximum: 96 },
      },
      diff: {
        kind: "boolean",
        description: "Report only the cells that changed since the last look.",
        extras: { default: true },
      },
    },
    async run(route, args) {
      const cols = integerValue(args, "cols");
      const region = stringValue(args, "region");
      const items = integerValue(args, "items");
      const diff = booleanValue(args, "diff");
      return route.look({
        ...(cols === undefined ? {} : { cols }),
        ...(region === undefined ? {} : { region }),
        ...(items === undefined ? {} : { items }),
        ...(diff === undefined ? {} : { diff }),
      });
    },
  },
  {
    name: "browser_wait",
    title: "Wait for the page",
    description:
      "Block until the page settles instead of reading it over and over: wait for text to appear, for text to go away, for the address to reach something, or for the page to stop changing. Returns as soon as the condition holds, and says what the page looks like when it does not. Every wait is bounded, so a page that never gets there reports that rather than hanging.",
    properties: {
      text: {
        kind: "string",
        description: "Wait until this text is on the page.",
      },
      gone: {
        kind: "string",
        description: "Wait until this text is off the page.",
      },
      url: {
        kind: "string",
        description: "Wait until the address contains this.",
      },
      quiet: {
        kind: "boolean",
        description: "Wait until the page stops changing.",
        extras: { default: false },
      },
      timeoutMs: {
        kind: "integer",
        description: "Give up after this many milliseconds. Defaults to 8000.",
        extras: { minimum: 50, maximum: 120000 },
      },
    },
    async run(route, args) {
      const timeoutMs = integerValue(args, "timeoutMs");
      const text = stringValue(args, "text");
      const gone = stringValue(args, "gone");
      const url = stringValue(args, "url");
      const quiet = booleanValue(args, "quiet");
      return route.wait({
        ...(text === undefined ? {} : { text }),
        ...(gone === undefined ? {} : { gone }),
        ...(url === undefined ? {} : { url }),
        ...(quiet === undefined ? {} : { quiet }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    },
  },
  {
    name: "browser_scroll",
    title: "Scroll",
    description:
      "Scroll the page by a number of pixels. Negative goes up. This is what brings a lazy-loaded list into being; read after scrolling rather than reading the whole page first.",
    properties: {
      dy: {
        kind: "integer",
        description: "Pixels down. Negative goes up.",
      },
      dx: {
        kind: "integer",
        description: "Pixels right. Negative goes left.",
      },
      read: {
        kind: "boolean",
        description: "Read the page after scrolling. Defaults to true.",
        extras: { default: true },
      },
    },
    async run(route, args) {
      const dy = integerValue(args, "dy");
      const dx = integerValue(args, "dx");
      const read = booleanValue(args, "read");
      return route.scroll({
        ...(dy === undefined ? {} : { dy }),
        ...(dx === undefined ? {} : { dx }),
        ...(read === undefined ? {} : { read }),
      });
    },
  },
  {
    name: "browser_hover",
    title: "Hover",
    description:
      "Move the mouse onto a control and hold it there, which is how a menu that only opens on hover opens. Address it by ref, or by its name. Read after hovering when the menu is what you came for.",
    properties: {
      ref: {
        kind: "integer",
        description: "Control to hover, by the number browser_view printed.",
      },
      text: { kind: "string", description: "Control to hover, by its name." },
      read: {
        kind: "boolean",
        description: "Read the page after hovering. Defaults to true.",
        extras: { default: true },
      },
    },
    async run(route, args) {
      const ref = integerValue(args, "ref");
      const text = stringValue(args, "text");
      const read = booleanValue(args, "read");
      return route.hover({
        ...(ref === undefined ? {} : { ref }),
        ...(text === undefined ? {} : { text }),
        ...(read === undefined ? {} : { read }),
      });
    },
  },
  {
    name: "browser_check",
    title: "Check or uncheck",
    description:
      "Clicking blindly flips a control that is already right. This one reads the control first: checked true asks for checked and false asks for unchecked, and a call with neither only reports what it is. It says so when the box did not take the change.",
    properties: {
      ref: {
        kind: "integer",
        description: "The box or switch, by the number browser_view printed.",
      },
      checked: {
        kind: "boolean",
        description: "The state wanted. Leave it out to only report.",
      },
      read: {
        kind: "boolean",
        description: "Read the page afterwards. Defaults to true.",
        extras: { default: true },
      },
    },
    required: ["ref"],
    async run(route, args) {
      const ref = integerValue(args, "ref");
      if (ref === undefined)
        throw new ArgumentError('browser_check: "ref" is required.');
      const checked = booleanValue(args, "checked");
      const read = booleanValue(args, "read");
      return route.check({
        ref,
        ...(checked === undefined ? {} : { checked }),
        ...(read === undefined ? {} : { read }),
      });
    },
  },
  {
    name: "browser_select",
    title: "Pick from a dropdown",
    description:
      "Choose an option in a dropdown by its value or by the words it shows. A native select is set directly; a custom listbox is opened and the option picked, which is why a plain click on the closed control was not enough.",
    properties: {
      ref: {
        kind: "integer",
        description: "The dropdown, by the number browser_view printed.",
      },
      field: {
        kind: "string",
        description: "The dropdown, by the label or name next to it.",
      },
      value: {
        kind: "string",
        description: "Option to choose, by value or by its visible text.",
      },
      read: {
        kind: "boolean",
        description: "Read the page afterwards. Defaults to true.",
        extras: { default: true },
      },
    },
    required: ["value"],
    async run(route, args) {
      const value = stringValue(args, "value");
      if (value === undefined)
        throw new ArgumentError('browser_select: "value" is required.');
      const ref = integerValue(args, "ref");
      const field = stringValue(args, "field");
      const read = booleanValue(args, "read");
      return route.select({
        value,
        ...(ref === undefined ? {} : { ref }),
        ...(field === undefined ? {} : { field }),
        ...(read === undefined ? {} : { read }),
      });
    },
  },
  {
    name: "browser_drag",
    title: "Drag",
    description:
      "Drag one thing onto another: a slider handle, a card into a column, a file onto a drop zone. Give each end by number, from the last read, and the move is sent as a real press, a series of moves and a release, which is what the page listens for.",
    properties: {
      fromRef: {
        kind: "integer",
        description: "Where the drag starts, by number.",
      },
      toRef: {
        kind: "integer",
        description: "Where the drag ends, by number.",
      },
      read: {
        kind: "boolean",
        description: "Read the page afterwards. Defaults to true.",
        extras: { default: true },
      },
    },
    required: ["fromRef", "toRef"],
    async run(route, args) {
      const fromRef = integerValue(args, "fromRef");
      const toRef = integerValue(args, "toRef");
      const read = booleanValue(args, "read");
      return route.drag({
        ...(fromRef === undefined ? {} : { fromRef }),
        ...(toRef === undefined ? {} : { toRef }),
        ...(read === undefined ? {} : { read }),
      });
    },
  },
  {
    name: "browser_upload",
    title: "Upload files",
    description:
      "Give files to a file input. The file chooser never opens: the files are handed to the input directly, so this is the only way an upload can be driven from here. Paths must be absolute.",
    properties: {
      ref: {
        kind: "integer",
        description: "The file input, by the number browser_view printed.",
      },
      files: { kind: "strings", description: "Absolute paths to upload." },
      read: {
        kind: "boolean",
        description: "Read the page afterwards. Defaults to true.",
        extras: { default: true },
      },
    },
    required: ["files"],
    async run(route, args) {
      const files = coerce(
        "browser_upload",
        "files",
        { kind: "strings", description: "" },
        args.files,
      );
      const ref = integerValue(args, "ref");
      const read = booleanValue(args, "read");
      return route.upload({
        files: files as string[],
        ...(ref === undefined ? {} : { ref }),
        ...(read === undefined ? {} : { read }),
      });
    },
  },
  {
    name: "browser_grab",
    title: "Save an image",
    description:
      "Save the picture on the page — the largest image, a canvas, or the one a ref names — as a file, so it can be opened rather than described. Reach for it when the thing you want is pixels.",
    properties: {
      ref: { kind: "integer", description: "The image or canvas, by number." },
      name: { kind: "string", description: "File name to save it under." },
      count: {
        kind: "integer",
        description: "Save this many of the largest pictures. Defaults to 1.",
        extras: { minimum: 1, maximum: 20 },
      },
    },
    async run(route, args) {
      const ref = integerValue(args, "ref");
      const name = stringValue(args, "name");
      const count = integerValue(args, "count");
      return route.grab({
        ...(ref === undefined ? {} : { ref }),
        ...(name === undefined ? {} : { name }),
        ...(count === undefined ? {} : { count }),
      });
    },
  },
  {
    name: "browser_eval",
    title: "Run JavaScript in the page",
    description:
      "Run an expression in the page and get its value back, for a fact no reading exposes: a computed style, a scroll height, a property on a global. Nothing is clicked and nothing is typed, and the page is not navigated. Prefer a reading when a reading answers it.",
    properties: {
      code: {
        kind: "string",
        description: "The expression to run. Its value is returned.",
      },
      awaitPromise: {
        kind: "boolean",
        description:
          "Wait for a promise the expression returns. Defaults to true.",
        extras: { default: true },
      },
    },
    required: ["code"],
    async run(route, args) {
      const code = stringValue(args, "code");
      if (code === undefined)
        throw new ArgumentError('browser_eval: "code" is required.');
      const awaitPromise = booleanValue(args, "awaitPromise");
      return route.evaluatePage({
        code,
        ...(awaitPromise === undefined ? {} : { awaitPromise }),
      });
    },
  },
  {
    name: "browser_do",
    title: "Run a batch of steps",
    description:
      "Do a whole sequence in one call — open a menu, type into a field, press Enter, wait for the result — instead of one round trip per action. Each step names one thing: ref, tap, field with text, text, key, scroll, wait_text, wait_gone, wait_url. The batch stops at the first step that cannot proceed and says which one, so a half-done sequence is never reported as done.",
    properties: {
      steps: { kind: "steps", description: "The steps, in order." },
    },
    required: ["steps"],
    async run(route, args) {
      const steps = coerce(
        "browser_do",
        "steps",
        { kind: "steps", description: "" },
        args.steps,
      );
      return route.run(steps as Step[]);
    },
  },
  {
    name: "browser_dialog",
    title: "Answer a dialog",
    description:
      "A confirm, an alert or a prompt stops the page until it is answered. With accept it is accepted and with text a prompt is filled in; with neither it only reports what is open. Use it when a click seemed to do nothing — an unhandled dialog is the usual reason.",
    properties: {
      accept: {
        kind: "boolean",
        description: "Accept the dialog. Leave it out to only report.",
      },
      text: { kind: "string", description: "Text for a prompt." },
    },
    async run(route, args) {
      const accept = booleanValue(args, "accept");
      const text = stringValue(args, "text");
      return route.dialog({
        ...(accept === undefined ? {} : { accept }),
        ...(text === undefined ? {} : { text }),
      });
    },
  },
  {
    name: "browser_cookie",
    title: "Cookies",
    description:
      "Read the cookies for the page, set one, or clear them all. Use it to keep a sign-in that a page stores in a cookie, or to see what the page was told to remember.",
    properties: {
      url: {
        kind: "string",
        description: "Read only the cookies this address sends.",
      },
      set: {
        kind: "string",
        description: 'Set one cookie as "name=value; path=/".',
      },
      domain: {
        kind: "string",
        description: "Domain for the cookie being set.",
      },
      clear: {
        kind: "boolean",
        description: "Clear every cookie first.",
        extras: { default: false },
      },
    },
    async run(route, args) {
      const url = stringValue(args, "url");
      const set = stringValue(args, "set");
      const domain = stringValue(args, "domain");
      const clear = booleanValue(args, "clear");
      return route.cookie({
        ...(url === undefined ? {} : { url }),
        ...(set === undefined ? {} : { set }),
        ...(domain === undefined ? {} : { domain }),
        ...(clear === undefined ? {} : { clear }),
      });
    },
  },
  {
    name: "browser_clipboard",
    title: "Clipboard",
    description:
      "Read what the page put on the clipboard, or put text there for a page that pastes. With set it writes; with nothing it reads.",
    properties: {
      set: { kind: "string", description: "Text to put on the clipboard." },
    },
    async run(route, args) {
      const set = stringValue(args, "set");
      return route.clipboard({ ...(set === undefined ? {} : { set }) });
    },
  },
  {
    name: "browser_console",
    title: "Console",
    description:
      "What the page logged, newest last. A click that seemed to do nothing usually left a reason here, and so does a page that half-loaded.",
    properties: {
      limit: {
        kind: "integer",
        description: "Return this many of the newest lines. Defaults to 50.",
        extras: { minimum: 1, maximum: 400 },
      },
    },
    async run(route, args) {
      const limit = integerValue(args, "limit");
      return route.console({ ...(limit === undefined ? {} : { limit }) });
    },
  },
  {
    name: "browser_network",
    title: "Network",
    description:
      "The requests the page made, with their status. Use it when a page is empty or a submission seemed to vanish: a failed request and a request that was never made look the same on the page and different here.",
    properties: {
      filter: {
        kind: "string",
        description: "Only rows whose address contains this.",
      },
      limit: {
        kind: "integer",
        description: "Return this many of the newest rows. Defaults to 50.",
        extras: { minimum: 1, maximum: 400 },
      },
    },
    async run(route, args) {
      const filter = stringValue(args, "filter");
      const limit = integerValue(args, "limit");
      return route.network({
        ...(filter === undefined ? {} : { filter }),
        ...(limit === undefined ? {} : { limit }),
      });
    },
  },
  {
    name: "browser_failed",
    title: "Failed requests",
    description:
      "Only the requests that never finished, with the reason. This is the short list behind a page that looks broken.",
    properties: {
      limit: {
        kind: "integer",
        description: "Return this many of the newest. Defaults to 50.",
        extras: { minimum: 1, maximum: 200 },
      },
    },
    async run(route, args) {
      const limit = integerValue(args, "limit");
      return route.failed({ ...(limit === undefined ? {} : { limit }) });
    },
  },
  {
    name: "browser_tabs",
    title: "Tabs",
    description:
      "List the open tabs, switch to one by index, or close one. A page that opened a second window to sign in or to show a document is reachable only through here.",
    properties: {
      action: {
        kind: "enum",
        values: ["list", "switch", "close"],
        description: "What to do. Defaults to list.",
      },
      index: {
        kind: "integer",
        description:
          "Which tab, as the list printed it. Needed by switch and close.",
        extras: { minimum: 0 },
      },
    },
    async run(route, args) {
      const action = stringValue(args, "action");
      const index = integerValue(args, "index");
      return route.tabs({
        ...(action === undefined
          ? {}
          : { action: action as "list" | "switch" | "close" }),
        ...(index === undefined ? {} : { index }),
      });
    },
  },
  {
    name: "browser_downloads",
    title: "Downloads",
    description:
      "The files this profile has downloaded, newest last, with their size and where they landed. A download that never appeared is a click that never started one.",
    properties: {},
    async run(route) {
      return route.downloads();
    },
  },
  {
    name: "browser_media",
    title: "Media",
    description:
      'The streams the page played, and a way to save one: save "main" takes the one the page was really playing, an index takes that row, and a piece of its address matches. Use it for a video or audio file the page will not hand over as a link.',
    properties: {
      all: {
        kind: "boolean",
        description:
          "Include request streams, not only media. Defaults to false.",
        extras: { default: false },
      },
      save: {
        kind: "string",
        description:
          'Save this stream: "main", an index, or part of its address.',
      },
      watch: {
        kind: "boolean",
        description: "Only report, without saving.",
        extras: { default: false },
      },
    },
    async run(route, args) {
      const all = booleanValue(args, "all");
      const save = stringValue(args, "save");
      const watch = booleanValue(args, "watch");
      return route.media({
        ...(all === undefined ? {} : { all }),
        ...(save === undefined ? {} : { save }),
        ...(watch === undefined ? {} : { watch }),
      });
    },
  },
  {
    name: "browser_pdf",
    title: "Print to PDF",
    description:
      "Print the page to a PDF file and say where it landed. Use it for a receipt, an invoice or a document the page renders but does not offer to download.",
    properties: {},
    async run(route) {
      return route.pdf();
    },
  },
  {
    name: "browser_prepare",
    title: "Prepare for animation",
    description:
      "Get a canvas, a game or a video ready and measure it: it takes the focus, counts the frames the page actually draws over a few seconds, and reports the input surfaces it found. Use it before reading a page that draws itself, so a still frame is not mistaken for a page that is running.",
    properties: {
      seconds: {
        kind: "integer",
        description: "How long to count frames. Defaults to 2.",
        extras: { minimum: 1, maximum: 30 },
      },
      focus: {
        kind: "boolean",
        description: "Take the focus first. Defaults to true.",
        extras: { default: true },
      },
    },
    async run(route, args) {
      const seconds = integerValue(args, "seconds");
      const focus = booleanValue(args, "focus");
      return route.prepare({
        ...(seconds === undefined ? {} : { seconds }),
        ...(focus === undefined ? {} : { focus }),
      });
    },
  },
  {
    name: "browser_mode",
    title: "Show or hide the window",
    description:
      "Say whether the browser draws a window you can watch, and get the mode it is in now. Visible is the default: a page nobody can see makes a wrong reading look like a right one. Changing it means the browser is put down and brought back up in the other mode on the same page, so it takes a moment. This does not change how clicks are delivered; leave the display out to ask.",
    properties: {
      display: {
        kind: "enum",
        description:
          "visible to show the window, headless to hide it. Leave it out to ask which is in force.",
        values: ["visible", "headless"],
      },
    },
    async run(route, args) {
      const display = args.display;
      if (
        display !== undefined &&
        display !== "visible" &&
        display !== "headless"
      )
        throw new ArgumentError(
          'browser_mode: display has to be "visible" or "headless"',
        );
      return route.mode(display === undefined ? {} : { display });
    },
  },
  {
    name: "browser_ask",
    title: "Ask the chat in the page",
    description:
      "Say something to a chat that is open in the page — a model, a support window, a search box — and read its answer back in the same call. Types into the box, presses Enter, then waits until the answer stops growing. Use it to get an answer without a read between every step.",
    properties: {
      text: {
        kind: "string",
        description: "The name of the box, when no ref names it.",
      },
      ref: {
        kind: "integer",
        description: "The number of the box, from browser_view.",
        extras: { minimum: 0 },
      },
      said: {
        kind: "string",
        description: "What to say. Defaults to nothing sent.",
      },
      submit: {
        kind: "boolean",
        description: "Press Enter after typing. Defaults to true.",
        extras: { default: true },
      },
      timeoutMs: {
        kind: "integer",
        description:
          "How long to wait for the reply to settle. Defaults to 45000.",
        extras: { minimum: 1, maximum: 600000 },
      },
    },
    async run(route, args) {
      const text = stringValue(args, "text");
      const ref = integerValue(args, "ref");
      const said = stringValue(args, "said");
      const submit = booleanValue(args, "submit");
      const timeoutMs = integerValue(args, "timeoutMs");
      return route.ask({
        ...(text === undefined ? {} : { text }),
        ...(ref === undefined ? {} : { ref }),
        ...(said === undefined ? {} : { said }),
        ...(submit === undefined ? {} : { submit }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    },
  },
  {
    name: "browser_review",
    title: "Ask for a review round",
    description:
      "Ask the chat in the page to review a repository and take its review back as a list: builds the message, sends it, waits for the answer, and writes the round down so the next round knows what was already said. Use it for a review round, not for a one-off question (that is browser_ask).",
    properties: {
      text: {
        kind: "string",
        description: "The name of the box, when no ref names it.",
      },
      ref: {
        kind: "integer",
        description: "The number of the box, from browser_view.",
        extras: { minimum: 0 },
      },
      said: {
        kind: "string",
        description: "What to send instead of the built message.",
      },
      timeoutMs: {
        kind: "integer",
        description:
          "How long to wait for the reply to settle. Defaults to 45000.",
        extras: { minimum: 1, maximum: 600000 },
      },
    },
    async run(route, args) {
      const text = stringValue(args, "text");
      const ref = integerValue(args, "ref");
      const said = stringValue(args, "said");
      const timeoutMs = integerValue(args, "timeoutMs");
      return route.review({
        ...(text === undefined ? {} : { text }),
        ...(ref === undefined ? {} : { ref }),
        ...(said === undefined ? {} : { said }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    },
  },
  {
    name: "browser_review_verdict",
    title: "Record a review verdict",
    description:
      "Record what happened to each point of the last review round, so the next round leaves settled points out: point numbers are the ones browser_review printed, and each mark is fixed, verified (checked in the code and the point does not apply), invalid, or open. With no marks, lists what is settled.",
    properties: {
      marks: {
        kind: "marks",
        description:
          "One {point, verdict} per point. verdict is fixed, verified, invalid or open.",
      },
    },
    async run(route, args) {
      const raw = args.marks;
      const marks =
        raw === undefined
          ? []
          : (raw as readonly VerdictMark[]).map((mark) => {
              if (typeof mark !== "object" || mark === null)
                throw new ArgumentError(
                  "browser_review_verdict: each mark is {point, verdict}",
                );
              const point = (mark as { point?: unknown }).point;
              const verdict = (mark as { verdict?: unknown }).verdict;
              if (typeof point !== "number" || !Number.isInteger(point))
                throw new ArgumentError(
                  "browser_review_verdict: point has to be a whole number",
                );
              /* The message below names four verdicts, so the check has to be
                 the same four: accepting any string would record a settlement
                 nobody can read back. */
              if (!VERDICTS.includes(verdict as Verdict))
                throw new ArgumentError(
                  "browser_review_verdict: verdict has to be fixed, verified, invalid or open",
                );
              return { point, verdict: verdict as Verdict };
            });
      return route.reviewVerdict({ marks });
    },
  },
  {
    name: "browser_resume",
    title: "Take the page back",
    description:
      "Take the page back: clears the hold so the next action is sent at once instead of waiting it out, and ends a takeover. Reports the page it is now holding.",
    properties: {},
    async run(route) {
      return route.resume();
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

/** The verdicts a mark may carry, in the order the message names them. */
const VERDICTS: readonly Verdict[] = ["fixed", "verified", "invalid", "open"];

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
    case "strings": {
      if (!Array.isArray(value)) {
        throw new ArgumentError(`${tool}: "${key}" must be a list of strings.`);
      }
      const out: string[] = [];
      for (const item of value) {
        if (typeof item !== "string") {
          throw new ArgumentError(
            `${tool}: "${key}" must be a list of strings.`,
          );
        }
        out.push(item);
      }
      return out;
    }
    case "marks": {
      if (!Array.isArray(value)) {
        throw new ArgumentError(`${tool}: "${key}" must be a list of marks.`);
      }
      return value;
    }
    case "steps": {
      if (!Array.isArray(value)) {
        throw new ArgumentError(`${tool}: "${key}" must be a list of steps.`);
      }
      return value.map((item) => stepOf(tool, key, item));
    }
  }
}

/** One step, with the caller's snake_case keys turned into the route's names.
 *
 * A step is refused before anything is clicked, so a typo in step 4 cannot
 * leave the browser four actions into a batch that never had a chance.
 */
function stepOf(tool: string, key: string, value: unknown): Step {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArgumentError(`${tool}: every "${key}" entry must be an object.`);
  }
  const from = value as Record<string, unknown>;
  const take = <T>(
    name: string,
    check: (input: unknown) => T | undefined,
  ): T | undefined => {
    const raw = from[name];
    if (raw === undefined) return undefined;
    const done = check(raw);
    if (done === undefined) {
      throw new ArgumentError(`${tool}: step "${name}" has the wrong type.`);
    }
    return done;
  };
  const asText = (input: unknown): string | undefined =>
    typeof input === "string" ? input : undefined;
  const asInt = (input: unknown): number | undefined =>
    typeof input === "number" && Number.isSafeInteger(input)
      ? input
      : undefined;
  const asBool = (input: unknown): boolean | undefined =>
    typeof input === "boolean" ? input : undefined;
  const step: Step = {
    ...(take("ref", asInt) === undefined
      ? {}
      : { ref: take("ref", asInt) as number }),
    ...(take("tap", asText) === undefined
      ? {}
      : { tap: take("tap", asText) as string }),
    ...(take("text", asText) === undefined
      ? {}
      : { text: take("text", asText) as string }),
    ...(take("field", asText) === undefined
      ? {}
      : { field: take("field", asText) as string }),
    ...(take("key", asText) === undefined
      ? {}
      : { key: take("key", asText) as string }),
    ...(take("scroll", asInt) === undefined
      ? {}
      : { scroll: take("scroll", asInt) as number }),
    ...(take("submit", asBool) === undefined
      ? {}
      : { submit: take("submit", asBool) as boolean }),
    ...(take("wait_text", asText) === undefined
      ? {}
      : { waitText: take("wait_text", asText) as string }),
    ...(take("wait_gone", asText) === undefined
      ? {}
      : { waitGone: take("wait_gone", asText) as string }),
    ...(take("wait_url", asText) === undefined
      ? {}
      : { waitUrl: take("wait_url", asText) as string }),
  };
  return step;
}

function describeError(error: unknown): string {
  if (error instanceof RouteClosedError) {
    return "no browser is running. Call browser_open first.";
  }
  if (error instanceof StaleRefError) {
    /* Every refusal of this kind is written where it is thrown, and each one
       names the number or the name that failed and what to do instead. One
       sentence for all of them would throw that away: "a frame ref cannot be
       filled by number" and "the last read did not contain 12" are different
       problems with different next steps. The blanket line stays for an error
       that arrives without a message of its own. */
    return error.message === ""
      ? "the page changed since the last read. Call browser_view and use the new refs."
      : error.message;
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
  /* Two kinds are not a JSON scalar: a list of paths, and a list of steps.
     Both are still described exactly, because a caller that cannot see the
     shape of a step writes one the page will not accept. */
  const type =
    property.kind === "enum"
      ? "string"
      : property.kind === "strings" ||
          property.kind === "steps" ||
          property.kind === "marks"
        ? "array"
        : property.kind;
  const schema: Record<string, unknown> = {
    type,
    description: property.description,
  };
  if (property.kind === "strings") {
    schema.items = { type: "string" };
  }
  if (property.kind === "steps") {
    schema.items = {
      type: "object",
      properties: {
        ref: { type: "integer" },
        tap: { type: "string" },
        text: { type: "string" },
        field: { type: "string" },
        key: { type: "string" },
        scroll: { type: "integer" },
        submit: { type: "boolean" },
        wait_text: { type: "string" },
        wait_gone: { type: "string" },
        wait_url: { type: "string" },
      },
      additionalProperties: false,
    };
  }
  if (property.kind === "marks") {
    schema.items = {
      type: "object",
      properties: {
        point: { type: "integer" },
        verdict: {
          type: "string",
          enum: ["fixed", "verified", "invalid", "open"],
        },
      },
      required: ["point", "verdict"],
      additionalProperties: false,
    };
  }
  if (property.values !== undefined) schema.enum = [...property.values];
  if (property.extras !== undefined) Object.assign(schema, property.extras);
  return schema;
}
