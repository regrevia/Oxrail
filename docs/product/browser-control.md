# Browser Control

Browser Control is an opt-in browser route. A host that enables it gets eleven tools for reading and driving a Chrome window that the route starts for itself. It is not the person's browser, it is not a second view of what the person has open, and it is not the default route: Native Computer Use still drives the desktop unless a host is configured to launch this one.

The route speaks MCP over stdio. It starts no server, opens no port, and needs only Node 20 or newer and a Chrome or Chromium binary on the machine.

## Enabling the route

Build the bundle once, then point the host at the absolute path of `dist/browser-control/mcp.mjs`. The host launches one process per session and talks newline-delimited JSON-RPC to it on stdin and stdout. Answers are written one at a time and never split; tool calls may be in flight together.

### Codex CLI

```toml
# ~/.codex/config.toml
[mcp_servers.oxrail_browser]
command = "node"
args = ["/absolute/path/to/dist/browser-control/mcp.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

Chrome may come from the host environment instead of the route's own discovery:

```toml
[mcp_servers.oxrail_browser.env]
OXRAIL_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

### Claude Code

```json
{
  "mcpServers": {
    "oxrail_browser": {
      "command": "node",
      "args": ["/absolute/path/to/dist/browser-control/mcp.mjs"]
    }
  }
}
```

Put that object in the project's `.mcp.json`.

### Other hosts

Any host that launches a stdio MCP server works. A host that knows the newer protocol calls `server/discover` first and reads the versions it may use from `supportedVersions`; a host that does not calls `initialize` and then `notifications/initialized`, and both are answered by the same process. `--version` and `--help` print one line to stdout and exit, so they can be checked by hand before a host is wired up.

## Configuration

| Variable                   | Default                     | Meaning                                                                      |
| -------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| `OXRAIL_CHROME`            | discovered                  | Chrome or Chromium binary to launch                                          |
| `OXRAIL_BROWSER_STATE_DIR` | `~/.oxrail/browser-control` | Where profiles and screenshots are written                                   |
| `OXRAIL_BROWSER_HEADLESS`  | `1`                         | `0` shows a window; anything else runs headless                              |
| `OXRAIL_BROWSER_PROFILE`   | `default`                   | Profile name under the state directory, so sign-ins outlive one process      |
| `OXRAIL_BROWSER_IDLE_MS`   | `300000`                    | How long an idle browser is kept, bounded to between one and fifteen minutes |
| `OXRAIL_BROWSER_VIEW`      | `1280x900`                  | Window size while headless, written as `<width>x<height>`                    |

## Tools

| Tool            | Purpose                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| `browser_open`  | Start the route's Chrome, optionally at a URL, and return its state                           |
| `browser_view`  | Read the page as text with numbered controls; each number is a `ref`                          |
| `browser_read`  | Answer a question from the page, or read it as prose or an outline, in a fraction of the text |
| `browser_click` | Click a `ref` from the last read, or the first control matching some text                     |
| `browser_type`  | Type into a field, optionally clearing it first or pressing Enter                             |
| `browser_key`   | Press one named key; `browser_type` is the normal way to enter text                           |
| `browser_nav`   | Open a URL, go back, or reload, and return the new state                                      |
| `browser_shot`  | Take a PNG of the viewport or the full page, and return it with its path                      |
| `browser_state` | Report whether a browser is running, how long it has been idle, and what it will close in     |
| `browser_login` | Report whether the route's own profile holds saved sign-ins                                   |
| `browser_close` | Stop the route's Chrome and return the final state                                            |

`browser_view` renders each control as a line such as `[12] button "Sign in"`. The `12` is the `ref` that `browser_click` and `browser_type` accept until the page changes or is read again; using an old `ref` fails with a message telling the model to read the page again.

## Reading without pasting the page

`browser_view` returns the page. On a large page that is the expensive part of a turn, and most of what comes back does not answer anything. `browser_read` reads the same page in one of four modes:

| Mode      | Returns                                                              | For                                        |
| --------- | -------------------------------------------------------------------- | ------------------------------------------ |
| `article` | The page as a Markdown column: headings, prose, lists, links         | Reading it, or quoting it                  |
| `map`     | Headings, how many controls there are, how many words — no body text | Deciding whether the page is the right one |
| `query`   | Only the passages that answer `query`, ranked in this process        | A question with an answer on the page      |
| `changed` | Only what the previous `text` read did not already say               | Watching a page after an action            |

`query` is the mode worth reaching for first. Measured on one long page — 40 near-identical sections, three headings, a list of 60 links, one answer — the same browser session gave:

| Call                                                            | Characters |
| --------------------------------------------------------------- | ---------- |
| `browser_view`                                                  | 5974       |
| `browser_read {mode:"article", maxChars:24000}`                 | 6061       |
| `browser_read {mode:"map"}`                                     | 45         |
| `browser_read {mode:"query", query:"how long do refunds take"}` | 89         |
| `browser_read {mode:"changed"}` after a click                   | 31         |

Each of those was one call, and each took single-digit milliseconds in the page. The number that matters is not that `article` is smaller — on a prose page it is not, because it trades numbered control lines for heading and list markers — but that a question gets answered in 89 characters instead of 5974, and that an outline costs 45.

Those are one fixture on one machine, not a benchmark; nothing here is a claim about other pages. What repeats on any page is the shape: a question costs the answer, not the page.

Ranking happens in this process with no model, no network and no third-party library. A question is folded to terms (plurals and participles collapse: `refunds` and `refund` are the same, `shipping` and `shipped` both become `ship`), scored against the page's blocks with saturation and length normalization, and the best passages are emitted with the heading they sit under. `query` also reports what it did not show: `passages: 2 of 40 blocks`.

`changed` compares against the last `text`-shaped read of the same address. A first read is the whole page, not "nothing changed"; after that a re-read costs only the difference. Reads of a different shape — an `article` column, a `map` — do not become the baseline, because diffing two projections would report a change that never happened.

A control keeps its number for as long as it is on the page: the page-side store maps the element itself to a ref, so re-reading a page whose first control disappeared does not renumber everything below it and report the whole page as changed. The numbering starts over when the document does, which is why a navigation invalidates every old ref — `browser_click` says the ref is stale instead of guessing.

`maxChars` bounds each mode (default 2000, minimum 200). It is a character budget, not a token one: the same characters cost more in Chinese than in English.

## Composed pages: shadow roots and frames

A flat document query is correct on a plain page and wrong on a modern one. Controls increasingly live in an open shadow root or inside an iframe, where `document.querySelectorAll` cannot see them; the page then reads as if the button does not exist, and a click has nothing to land on. `browser_view` reaches both:

- **Open shadow roots** are traversed, up to 24 roots per reading. A closed shadow root has no readable contents and is not claimed as readable.
- **Same-origin frames** are read as part of the page. Their text is appended with a marker (`[frame 1]`), and their controls are numbered in the same sequence with the frame in the number: refs below `900000` are in the page, refs at or above it encode a frame number and a position inside that frame. A click on such a ref is resolved inside the frame and offset by the frame's own corner, so the press lands on the control rather than on the frame's rectangle.

Measured on one composed fixture — a button in the document, a button in an open shadow root, and a button in a same-origin frame — `browser_view` numbered all three (`1`, `2`, `900003`) and reported the frames as `frame: 0`, `0`, `1`. Clicking `900003` fired the framed button's own handler.

Frames nest, so a control two frames down is numbered by the whole chain rather than by the innermost number: on a fixture whose inner frame holds `Save`, the control came back as ref `1000001` in `frame: 2`.

A frame the route cannot read — a cross-origin frame — is reported as `frames not read: N` rather than dropped: a short reading of a page that visibly has more should say so. Reading those needs a per-frame session, which is a larger permission surface than this route takes today. Crossing a frame border is the only place the route needs two origins to prove anything — before a foreign `src` commits, its iframe holds an initial `about:blank` that belongs to the parent's origin and reads as empty rather than as hidden — so that one is measured against two local ports instead of `data:` markup.

## Turns and reclaim

The route holds one browser for the life of the host session. When the session ends the host closes stdin, and the process closes Chrome before it exits. If the browser is unused for the idle window it is stopped too, so a forgotten window does not stay on the machine; the next tool call starts it again. `browser_state` reports `idleMs` and `closesInMs` so a host can decide to keep working or to call `browser_close` itself.

Screenshots are written under `<state dir>/shots` and returned both as an image and as a path, so a host that cannot show images can still open the file.

## Pixels and hit testing

`browser_shot` captures in CSS pixels at any device pixel ratio, so a coordinate read off the picture can be handed straight back to `browser_click`. A viewport capture is exactly `window.innerWidth` by `window.innerHeight`, and `fullPage` is the viewport width by the full document height; both account for how far the page is scrolled.

`browser_click` resolves a control, scrolls it into view, and hit-tests up to five points inside it with `document.elementFromPoint`, centre first. The scroll is instant even on a page that sets `scroll-behavior:smooth`: an animated scroll reports the rectangle the control had before it moved, and a point taken from that rectangle is somewhere else by the time the press is sent. Only the part of the control the viewport actually shows is sampled, so a point is never clamped into a place the control does not occupy. A point counts when it belongs to the control or to one of its descendants — the press bubbles back up — but not to an ancestor, because `body` contains every control and an element painted under its parent is not the element the caller asked for. A control covered only in its middle still clicks at a reachable point. When every sample is covered the call refuses before any input is dispatched and names what is in the way:

```
"Continue" cannot be clicked because it is behind div#sheet "Close Sign up to continue". Close or dismiss what covers it, then call browser_view and retry.
```

A control with no area on screen is reported separately: `"…" cannot be clicked: it has no area on screen to click.` So is a control that stays out of the viewport after scrolling: `"…" cannot be clicked because it is outside the visible area even after scrolling it into view.` These messages are a fact about the page, not a retry suggestion; the fix is to dismiss the layer or scroll the thing into view, then read the page again.

## Not claimed

- The route is not visible to Hook. Hook does not see the browser it starts, and no Hook rule is evaluated against it.
- It inherits nothing from the native route: no session suspension, no credential admission, no safety prompt before a page is driven.
- It does not read or scrape sign-in screens on the person's behalf. `browser_login` reports what the route's own profile holds; credentials are typed only when the person asked for that.
- It does not use the person's browser, its cookies, or its extensions. A sign-in made in the route's profile is not a sign-in in the person's browser.
