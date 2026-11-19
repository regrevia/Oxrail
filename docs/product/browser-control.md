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

`browser_view` renders each control as a line such as `[12] button "Sign in"`. The `12` is the `ref` that `browser_click` and `browser_type` accept. It stays valid while the control is still on the page, including across a re-read that returns it again; a number that no read produced, or one whose control the last read did not return, fails with a message telling the model to read the page again.

## Reading without pasting the page

`browser_view` returns the page. On a large page that is the expensive part of a turn, and most of what comes back does not answer anything. `browser_read` reads the same page in one of four modes:

| Mode      | Returns                                                                      | For                                        |
| --------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| `article` | The page as a Markdown column: headings, prose, lists, links                 | Reading it, or quoting it                  |
| `map`     | The heading outline and the page's controls — no body text                   | Deciding whether the page is the right one |
| `query`   | Only the passages that answer `query`, ranked in this process, plus controls | A question with an answer on the page      |
| `changed` | Only what the previous `text` read did not already say                       | Watching a page after an action            |

A read is also what makes its page writable: the controls it returns are the refs `browser_click` and `browser_type` will accept, and a number from no read is refused. `map` and `query` return them, so a question can be followed by a click on the answer's page. `changed` returns only the controls that are new since the last read, but it hands the page's whole set, so a write can follow it too. `article` returns and hands no controls — it is for reading and quoting, not for acting — and it leaves the refs from the last read that had them still valid, because the page has not gone anywhere.

That is why `map` and `query` are not free on a page with many links, and why `query` on such a page still costs its 61 `[n]` lines.

`query` is the mode worth reaching for first. Measured on one long page — 40 near-identical sections, three headings, a list of 60 links, one answer, one button — the same browser session gave, in characters received by the caller:

| Call                                                            | Text | Controls | Total |
| --------------------------------------------------------------- | ---- | -------- | ----- |
| `browser_view`                                                  | 5999 | 1403     | 7402  |
| `browser_read {mode:"article", maxChars:24000}`                 | 8126 | 0        | 8126  |
| `browser_read {mode:"map"}`                                     | 1281 | 1403     | 2684  |
| `browser_read {mode:"query", query:"how long do refunds take"}` | 423  | 1403     | 1826  |
| `browser_read {mode:"changed"}` after a click                   | 23   | 0        | 23    |

Both columns are the call's cost: the text it returns, and the numbered controls that let a following write name what to act on. `article` and `changed` return no controls, so for them one column is the whole call. `map` and `query` do return the page's controls, and on a link-heavy page that is most of what they cost — the answer to the question is 423 characters and the 61 controls that came with it are the other 1403.

Reproduce this rather than trusting it: `node benchmarks/harness/measure-reading.mjs` measures `packages/browser-control/src/route.ts` against `benchmarks/fixtures/long-page/index.html` in a headless Chrome on this machine.

The same five calls on the opposite page shape — 758 words of prose, three links, no long control list — is `node benchmarks/harness/measure-reading.mjs --fixture article-page`:

| Call                                                            | Text | Controls | Total | Share of `browser_view` |
| --------------------------------------------------------------- | ---- | -------- | ----- | ----------------------- |
| `browser_view`                                                  | 4269 | 94       | 4363  | 1                       |
| `browser_read {mode:"article", maxChars:24000}`                 | 4279 | 0        | 4279  | 0.98                    |
| `browser_read {mode:"map"}`                                     | 251  | 94       | 345   | 0.08                    |
| `browser_read {mode:"query", query:"how long do refunds take"}` | 364  | 94       | 458   | 0.11                    |
| `browser_read {mode:"changed"}` after a click                   | 17   | 0        | 17    | 0.004                   |

Two pages is not a corpus, but it is enough to separate what repeats from what does not, and the first version of this section got that wrong: it called the ratios the portable part. They are not. `query` costs 25% of `browser_view` on the link-heavy page and 11% here, because on that page the 61 control lines are most of what a readable mode has to carry, and here there are three. The ratios follow the page's control density, not the mode.

What repeats on both is the ordering and the reason for it: `map` and `query` receive a fraction of the page, `changed` after an action receives the change and nothing else, and each mode's cost is the text it returns plus the addresses a following write needs. On a page with almost no controls the saving is larger, not smaller.

`article` is the mode that does not save: it came back at 98% of `browser_view` here and 110% on the long page. That is expected, and it is not what the mode is for — it trades numbered control lines for heading and list markers, and it exists to read or quote a page, not to save on a page you were going to read anyway.

Those are two fixtures on one machine, not a benchmark; nothing here is a claim about other pages. Each call above took single-digit to low-tens of milliseconds in the page.

Ranking happens in this process with no model, no network and no third-party library. A question is folded to terms (plurals and participles collapse: `refunds` and `refund` are the same, `shipping` and `shipped` both become `ship`), scored against the page's blocks with saturation and length normalization, and the best passages are emitted with the heading they sit under. `query` also reports what it did not show: `passages: 2 of 40 blocks`.

`changed` compares against the last `text`-shaped read of the same address. A first read is the whole page, not "nothing changed"; after that a re-read costs only the difference. Reads of a different shape — an `article` column, a `map` — do not become the baseline, because diffing two projections would report a change that never happened.

A control keeps its number for as long as it is on the page: the page-side store maps the element itself to a ref, so re-reading a page whose first control disappeared does not renumber everything below it and report the whole page as changed. The numbering starts over when the document does, which is why a navigation invalidates every old ref — `browser_click` says the ref is stale instead of guessing.

`maxChars` bounds each mode, and it is a character budget, not a token one: the same characters cost more in Chinese than in English. `browser_read` defaults to 2000 and accepts a minimum of 200; `browser_view` keeps the larger 6000, because naming controls costs characters that reading prose does not.

When a read hits one of its own limits it says so, and says which: `truncated: true` is paired with a `limit:` line naming the cap that fired. `controls` means the page had more controls than one reading numbers, and the next read should be `map`, which returns the outline and the controls without the prose; `chars` means the text budget ran out after the controls were already collected, so `article` with a larger `maxChars`, or `query`, is what recovers the rest. `nodes` is the DOM walk limit, `headings` the outline's, `frames` an unreadable frame, and `passages` the number of blocks a `query` ranked but did not return. One `truncated` alone cannot tell a control budget from a character one, and the two ask for different next calls.

## What a cap tells you to do next

The cap a page hits depends on the page, and four more fixtures show the four less obvious ones. A short page with many controls — 173 buttons, 1.7k characters of prose — is stopped by its control budget before its text budget:

```
node benchmarks/harness/measure-reading.mjs --fixture wide-page
browser_view            4994 chars (100.0%)  capped: controls
browser_read {mode:"map"}  3354 chars (67.2%)  capped: controls
```

The figures above are the columns that do not move between runs; the elapsed time in the harness output does, so it is left out here. That is the case a single `truncated` flag cannot describe: 4994 characters is under the 6000-character budget, so raising `maxChars` would recover nothing. The ceiling was reached on controls, and `map` is the call that makes progress. Reversing the shape — 85 headings, one button — reaches the outline limit instead, and says so:

```
node benchmarks/harness/measure-reading.mjs --fixture deep-outline
browser_read {mode:"map"}  1059 chars (21.9%)  capped: headings
```

Neither of the remaining caps is about length. A page that ships nine thousand edit fields in its markup, hidden until a row is opened, is stopped by the walk before any of them is numbered:

```
node benchmarks/harness/measure-reading.mjs --fixture huge-dom
browser_view            253 chars (100.0%)  capped: nodes
browser_read {mode:"map"}  59 chars (23.3%)  capped: nodes
```

Nothing was cut from that reading: the page is shorter than the article fixture and has fewer visible controls. The read stopped looking, and says so, which is the whole difference between a short answer and a partial one.

The last cap is not a budget at all. A checkout page with its card fields in a frame from another origin cannot be read through, and no larger budget changes that:

```
node benchmarks/harness/measure-reading.mjs --fixture blocked-frame
browser_view            264 chars (100.0%)  capped: frames
```

The reading around the frame is complete, and the frame is named separately as unread — one frame, cross-origin — rather than left out without comment.

All six of the caps this document names fire on a page you can run here — `chars` on the long and article pages, `controls` on the wide one, `headings` on the deep one, `nodes` on the warehouse page, `frames` on the checkout page. `passages` is the one that needs a question rather than a page shape: a query that ranks more blocks than the passage limit returns sets it, and the live regression asserts exactly that (`matched` counts the blocks that answered, so the two diverge as soon as a query answers more than it is handed). Every cap a reader can be handed is reachable here by a command, not only by reading the source.

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

## Writes are addressed by a read

There is no way to hand this route a coordinate. `browser_click` takes a `ref` or some visible text, `browser_type` takes a `ref` and the text, and neither accepts a point on screen — so a write that acts on a control has to name it with something a read returned, and that number or name is the whole address. Both kinds are held to the read: a number must be one the last read produced, and a text must appear in a name the last read said out loud, so neither can reach a control the caller has not seen. A click by text that the last read did not name is refused the same way an invented number is:

```
control "Delete account" cannot be addressed: the last read of https://example.com/ did not name it — call browser_view again and use a number it returns
```

A selector that is empty or only whitespace is refused before that comparison, because every name contains the empty string and a containment check would pass against any read at all:

```
a click needs a number or some text to find the control by, and "   " has neither
```

Typing with no `ref` goes to whatever has focus, so the focus itself has to be an address the read produced: the control that holds it must be one the last read numbered. A control the page focused on its own, or one whose number is older than the read in hand, is refused rather than typed into, because neither is something the caller chose:

```
the focused control is not one the last read of https://example.com/ numbered — read the page again and click the control you mean
```

That refusal happens after the page is open and before a single key is sent, so nothing lands. It is covered live: one case reveals and focuses a field that no read ever numbered, another focuses a field whose number was dropped from the read in hand, and both show the page unchanged afterwards. Two calls act on the page with no address at all, and both say so: `browser_key` presses a named key, and that key goes wherever the page already put its focus, which is nothing a read can number; `browser_nav` changes the page rather than touching a control in it. A number that no read produced, or one from before the page navigated, is refused rather than tried:

```
control 12 cannot be addressed: the last read of https://example.com/ did not contain it — call browser_view again and use a number it returns
```

This is the difference in kind from a Computer Use loop, which looks at pixels and then decides where to press. Nothing here looks at a picture to choose a target: a screenshot is for a person to see, never an input source. Two consequences are worth stating plainly. A write costs whatever the read before it cost, so a page that is expensive to read is expensive to act on. And a page that changes under the read cannot be acted on by a stale number — that is a refusal, not a near miss.

`browser_nav` is a write of the same kind and stays an explicit call of its own: no read navigates, and a navigation clears the numbers, because they described the page that was there.

## Pixels and hit testing

`browser_shot` captures in CSS pixels at any device pixel ratio, so a picture, a person's annotation and the hit test below all describe the same space. A viewport capture is exactly `window.innerWidth` by `window.innerHeight`, and `fullPage` is the viewport width by the full document height; both account for how far the page is scrolled. The picture is for reading and for showing to a person; it is not a way to address a control.

`browser_click` resolves a control, scrolls it into view, and hit-tests up to five points inside it with `elementFromPoint`, centre first. The hit test asks the tree the control is actually in — an element inside an open shadow root is not returned by `document.elementFromPoint` at all, so asking the document would report every such control as covered. The scroll is instant even on a page that sets `scroll-behavior:smooth`: an animated scroll reports the rectangle the control had before it moved, and a point taken from that rectangle is somewhere else by the time the press is sent. Only the part of the control the viewport actually shows is sampled, so a point is never clamped into a place the control does not occupy. A point counts when it belongs to the control or to one of its descendants — the press bubbles back up — but not to an ancestor, because `body` contains every control and an element painted under its parent is not the element the caller asked for. A control covered only in its middle still clicks at a reachable point. When every sample is covered the call refuses before any input is dispatched and names what is in the way:

```
"Continue" cannot be clicked because it is behind div#sheet "Close Sign up to continue". Close or dismiss what covers it, then call browser_view and retry.
```

A control with no area on screen is reported separately: `"…" cannot be clicked: it has no area on screen to click.` So is a control that stays out of the viewport after scrolling: `"…" cannot be clicked because it is outside the visible area even after scrolling it into view.` These messages are a fact about the page, not a retry suggestion; the fix is to dismiss the layer or scroll the thing into view, then read the page again.

Both halves of that refusal are covered by live tests against a real Chrome: a control inside an open shadow root is numbered and clicked rather than reported as covered, and a control under a layering element is refused with the covering element's own tag, id and words, with the page checked afterwards to confirm the press never reached the control underneath. Those cases need a browser, so they run only when `OXRAIL_BROWSER_LIVE=1` is set — and CI sets it on every push to `dev` and `main`, then fails the run if the cases skipped rather than ran, so a machine without Chrome cannot report them green.

## Not claimed

- The route is not visible to Hook. Hook does not see the browser it starts, and no Hook rule is evaluated against it.
- It inherits nothing from the native route: no session suspension, no credential admission, no safety prompt before a page is driven.
- It does not read or scrape sign-in screens on the person's behalf. `browser_login` reports what the route's own profile holds; credentials are typed only when the person asked for that.
- It does not use the person's browser, its cookies, or its extensions. A sign-in made in the route's profile is not a sign-in in the person's browser.
