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
| `browser_mode`  | Switch a running browser between shown and headless, keeping its page                         |
| `browser_close` | Stop the route's Chrome and return the final state                                            |

### Finding one thing without reading the page

| Tool              | Purpose                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `browser_find`    | Search the controls and the words on the page; each hit comes back with the ref a click takes |
| `browser_extract` | Pull the rows one CSS selector describes, without reading the rest of the page                |
| `browser_wait`    | Block until text appears or goes, the address matches, or the page stops changing             |
| `browser_scroll`  | Scroll by a number of pixels; read after scrolling rather than reading everything first       |

### Not part of the reading contract

`browser_eval` runs an expression in the page and returns its value. It ships with
the tool face, but it is outside what the specification accepts: it is named in
neither §52 nor any `REQ-BCTL-*`, and whether it widens the write path in §42.1 is
an open decision rather than something the spec grants. It exists because a caller
sometimes needs one fact no reading exposes — a computed style, a scroll height.
Nothing else in this route evaluates page code.

### Acting on a control

| Tool             | Purpose                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `browser_hover`  | Move the mouse onto a control and hold it, so a menu that only opens on hover opens      |
| `browser_check`  | Read a checkbox or switch, then set it only if it is not already the state you asked for |
| `browser_select` | Choose a dropdown option by value or by the words it shows                               |
| `browser_drag`   | Drag a slider handle, a card, or a file onto a drop zone                                 |
| `browser_upload` | Hand files to a file input; the chooser never opens                                      |
| `browser_do`     | Run a sequence of steps in one call, stopping at the first one that cannot proceed       |

### What the page is doing

| Tool              | Purpose                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `browser_console` | The page's own log lines, newest last                                  |
| `browser_network` | The requests the page made, with their status                          |
| `browser_failed`  | Only the requests that never finished, with the reason                 |
| `browser_dialog`  | Answer a confirm, alert or prompt that is stopping the page            |
| `browser_look`    | See the page as a color grid, for a canvas or a page that draws itself |
| `browser_prepare` | Focus a canvas, game or video and count the frames it actually draws   |

### Files and session

| Tool                | Purpose                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| `browser_grab`      | Save an image or canvas as a file, so it can be opened rather than described |
| `browser_pdf`       | Print the page to a PDF and say where it landed                              |
| `browser_tabs`      | List the open tabs, switch to one, or close one                              |
| `browser_downloads` | The files this profile downloaded, with size and where they landed           |
| `browser_media`     | The streams the page played, and a way to save one                           |
| `browser_cookie`    | Read, set or clear the page's cookies                                        |
| `browser_clipboard` | Read what the page put on the clipboard, or put text there                   |
| `browser_resume`    | Clear the hold so the next action is sent at once, ending a takeover         |

### Chats in the page

| Tool                     | Purpose                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `browser_ask`            | Say something to a chat open in the page and read its answer back in the same call  |
| `browser_review`         | Ask that chat to review a repository and take the review back as a list             |
| `browser_review_verdict` | Record what happened to each review point so the next round leaves settled ones out |

### A shown window by default, and what a report describes

The window is shown unless the caller asks otherwise: a browser nobody can see makes a wrong page look like a wrong reading. `OXRAIL_BROWSER_HEADLESS=1` hides it for a whole process — the comparison is strict, so a typo in that value shows a window rather than silently hiding one. `browser_open` also takes `headless` and `profile`, and both are **one-shot**: they decide this launch only and do not write the route's standing choice, so a caller that opened a hidden window has not made hidden the default. `browser_mode` switches a running browser without losing the page it was on, and costs a restart: it closes the window and opens the same URL again in the other mode. The restart carries the running profile too, so a window opened one-shot on another profile comes back up on that profile rather than the standing one — the sign-ins still match the page.

`browser_state` (and every tool that returns a state) describes **the window that exists**, not the settings that produced it. When nothing is running it reports the standing choice, because there is no window to describe.

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

`query` ranks body blocks, and a heading is not one. That was a defect, and measuring found it: on the `wide-page` fixture, `query:"when should i water"` returned `(nothing on this page answers …)` with `matched: 0` over 173 blocks, although the page's own `h1` says `Watering schedule` — no paragraph repeats the word, so no sentence scored, and a reader that only looked at sentences concluded the page was silent about the one thing it names. It now answers `Watering schedule › Beds` with `matched: 1`. The prose is 24 characters; the reading is 3340, because `query` hands the page's 160 controls back with it, and that control cost is the one this mode cannot avoid on a page like this. The labels are read only when no sentence answered, so a real passage is never displaced by a heading that happens to share a word; `map` is still the mode for _what is this page_, because it says what the page is about and what can be done on it in one call.

Those totals mean nothing without a scale, and the page supplies two that involve no budget at all. The same long page is served as 14766 characters of HTML, and its prose — every visible word with the markup gone — is 8159 characters. `browser_view` returns 7402, so it sends one character for every two the page has. That ratio is not an achievement and the harness prints it anyway: on a page that is mostly prose, a whole-page read costs about what the prose costs.

Where the ratio does move is a page whose length is not prose. A single button whose `aria-label` holds 60000 characters is served as 60744 characters and reads whole as 77 characters of prose; `browser_view` returns 255, one character for every 238 the page has. Both numbers come from the same command, which is the point — `node benchmarks/harness/measure-reading.mjs --fixture huge-label` prints the page as served, the prose it holds, and the ratio above the table, so a rise in the ratio is visible as a page that grew somewhere other than its words.

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

Ranking happens in this process with no model, no network and no third-party library. A question is folded to terms (plurals and participles collapse: `refunds` and `refund` are the same, `shipping` and `shipped` both become `ship`), scored against the page's blocks with saturation and length normalization, and the best passages are emitted with the heading they sit under. A heading is a place a term matches, both as a boost on the passages under it and, when no sentence answers at all, as the answer itself. `query` also reports what it did not show: `passages: 2 of 40 blocks`.

`changed` compares against the last `text`-shaped read of the same address. A first read is the whole page, not "nothing changed"; after that a re-read costs only the difference. Reads of a different shape — an `article` column, a `map` — do not become the baseline, because diffing two projections would report a change that never happened.

A control keeps its number for as long as it is on the page: the page-side store maps the element itself to a ref, so re-reading a page whose first control disappeared does not renumber everything below it and report the whole page as changed. The numbering starts over when the document does, which is why a navigation invalidates every old ref — `browser_click` says the ref is stale instead of guessing.

`maxChars` bounds each mode, and it is a character budget, not a token one: the same characters cost more in Chinese than in English. `browser_read` defaults to 2000 and accepts a minimum of 200; `browser_view` keeps the larger 6000, because naming controls costs characters that reading prose does not.

When a read hits one of its own limits it says so, and says which: `truncated: true` is paired with a `limit:` line naming the cap that fired. `controls` means the page had more controls than one reading numbers, and the next read should be `map`, which returns the outline and the controls without the prose; `chars` means the text budget ran out after the controls were already collected, so `article` with a larger `maxChars`, or `query`, is what recovers the rest. `nodes` is the DOM walk limit, `headings` the outline's, `frames` an unreadable frame, and `passages` the number of blocks a `query` ranked but did not return. One `truncated` alone cannot tell a control budget from a character one, and the two ask for different next calls.

## What a cap tells you to do next

The cap a page hits depends on the page, and two more fixtures show the other two common ones. A short page with many controls — 173 buttons, 1.7k characters of prose — is stopped by its control budget before its text budget:

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

## Against two other browser MCPs, measured the same way

The numbers above say what this product costs. They do not say whether that is good, because a cost means nothing without something to compare it to. `pnpm compare:competitors` serves the same fixtures over loopback and drives `@playwright/mcp@0.0.86` and `chrome-devtools-mcp@1.13.0` at them, counting characters received and whether the answer is in what came back. The second half is the one that matters: a cheap call that does not answer is worth nothing.

Each product is given its own best case, not a strawman. Every mode this product has is measured (`view`, `article`, `map`, `query`), and the table reports whichever answered for the fewest characters. Playwright gets `browser_find` swept over three plausible keywords and five `maxResults` values. Chrome DevTools reads with `take_snapshot` and nothing else: it has no keyword search, and its `wait_for` re-sends the whole snapshot rather than a matching snippet.

A call counts as answering only if the answer appears, and for a question about a control, only if it appears on a line that carries a handle — `[12]` here, `[ref=e12]` in Playwright, `uid=1_4` in Chrome DevTools. Naming a control without letting anyone click it is not an answer to "which control shows the delivery status".

There is one asymmetry a comparison of this kind cannot design away, so it is labelled instead: a keyword search needs a keyword, and the best keyword is sometimes a word from the answer. `browser_find("business days", 1)` returns the `long-page` answer in 764 characters — but a caller who does not already know the answer would search the question's words, and `refund` needs three results and 1219 characters. The table below is what a caller who has only the question can achieve. This product's `query` takes the question itself, and `map`, `article` and `view` need no words at all, so nothing on its side depends on that knowledge.

Cheapest call that actually answered, in characters received, given only the question:

| Fixture                                | This product | Playwright | Chrome DevTools |
| -------------------------------------- | ------------ | ---------- | --------------- |
| `long-page` (prose, 14766)             | 1827         | **1219**   | 13087           |
| `wide-page` (160 controls, 10360)      | 2030         | **450**    | 5427            |
| `huge-dom` (9000 fields, 65022)        | **112**      | 422        | 432             |
| `huge-label` (60000-char label, 60744) | **213**      | 219        | 60217           |

These totals count the whole tool result, so they run exactly one character above the text-plus-controls tables earlier in this section: the formatted result separates the prose block from what follows with a blank line.

A whole-page read of the same four pages:

| Fixture      | `browser_view` | `browser_snapshot` | `take_snapshot` |
| ------------ | -------------- | ------------------ | --------------- |
| `long-page`  | 7403           | 17391              | 13087           |
| `wide-page`  | 4995           | 11392              | 5427            |
| `huge-dom`   | 254            | 533                | 432             |
| `huge-label` | 256            | 308                | 60217           |

Playwright wins two of four on targeted lookup, by 1.5× and 4.5×. Its `browser_find` is a good tool: it searches the accessibility tree and returns snippets with refs, so when the caller can name the word, it is cheaper than ranking a question. This product wins the other two — `huge-dom` by 3.8×, and `huge-label` by 3%, which is a tie and should be read as one.

The two losses and the two wins have one cause between them, and it is not speed.

On `wide-page` the answer is one sentence — "Each row has a button that opens that bed for editing" — and 2030 characters is what carrying it costs here: `query` returns that sentence as 75 characters of text and then hands all 160 controls — a read is what makes a page writable — and the control lines are the rest of the 3391. `article` returns the same sentence plus the 76 row names as list items, none of them addressable, for 2030. `browser_find("row", 1)` returns the matched neighbourhood and its refs for 450. That gap is the price of the addressing guarantee described above, not a defect, and it is the one number in this table that a narrower hand-back would move — the spec allows a read to carry fewer controls, and it currently does not.

On `huge-dom` the same cause runs the other way. The page serves 65022 characters of DOM and holds one useful sentence. `query` returns that sentence without the 9000 fields, because they are not prose and it does not rank them, for 112. `browser_find` returns the matched accessibility subtree, which on this page is larger. The lesson is the shape of the cost, not who is faster: this product pays for the controls it hands back and for the prose it returns, and pays nothing for DOM it did not index.

That is also why the whole-page column barely moves: `browser_view` is 2.1×–2.3× below Playwright's snapshot on the first three pages and 1.1×–1.8× below Chrome DevTools', and only `huge-label` breaks the pattern, where the gap to Playwright narrows to 1.2× because both bound the name and differ only in how much they send around it. Those ratios follow from what each product sends, not from a page's shape.

The `huge-label` column is a different kind of fact. One button has a 60000-character accessible name. Chrome DevTools prints it in full: 60217 characters, of which a single line is 60019. This product sends 256 for the same page and Playwright 308, both because a name has a ceiling. That is `KILL-K18` — one unbounded field taking the context with it — reproduced by one command instead of argued from a design document. `huge-label` is a synthetic page built to be pathological; its value is that it separates a bound from a tendency. On the other three pages all three products are within one order of magnitude, and the differences are matters of degree.

Chrome DevTools is not reducible to that number either. Its `evaluate_script` returns the answer in a handful of characters — but only after the caller writes page-specific JavaScript, which is the thing all three products exist to avoid, and it is unbounded by construction, so the harness counts it for nobody.

### The first version of this comparison was wrong

The section above replaced one that had been measured badly, and the error is worth keeping because it was not a rounding difference.

That version used four pages and reported this product losing three. Three of its four "answers" were not answers: on `wide-page` and `huge-dom` the answer string was the page's own heading ("Watering schedule", "Warehouse list"), and on `huge-label` the question ("confirm the order") had nothing to do with the answer ("Show delivery status"). A question of the form _how many warehouses are listed_ was scored as answered by a reading that merely contained the heading `Warehouse list` — and the page lists no count at all. The result was a table that understated this product and, worse, a claim built on it: that `browser_find` wins wherever the answer is a keyword. With real answers and a keyword sweep, it wins two of four, not three.

Three further changes came out of redoing it. A control question now requires an addressable mention, which correctly disqualifies `article` — it names a button in prose but hands out no ref, so it cannot be clicked. Chrome DevTools was added as a second competitor, because a single competitor's design choices are a weak basis for any conclusion. And the keyword a competitor is given is now labelled by whether it is derivable from the question, because the first corrected table credited Playwright with 764 characters on `long-page` using a term that only appears in the answer — a favourable-to-them number that no caller could reach, which is the same error in the opposite direction. The blind comparison is 1219 against 1827, not 764 against 1827.

### What this measurement does not establish

Not a ranking. Four fixtures chosen by the author of one of the three products, on a local server, with each competitor given its best case, is not a corpus. The README still says there is no performance claim, and this does not create one. What it establishes is narrower: where the advantage is (whole-page cost, a bound on every field, a question that can be asked in words) and where it is not (looking something up once you know the word).

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

## A shorter reading, not a smaller page

Long pages fail in a way a character budget cannot fix. A listing page whose buttons differ only by a number spends 3601 characters saying the same sentence 159 times; an article page with 61 links spends 1525 on navigation nobody asked about. Neither is over its cap — the reading is simply made of repetition and scaffolding. Two rules shorten it without removing anything.

A run of controls that differ only by a trailing number is folded onto one line. This is the wide page as it is actually printed:

```
[1] button "Show delivery status"
[2]-[160] button "Item 1" .. "Item 159" (159 controls, one line)
```

The folded line is 64 characters; the same run written one control per line is 3601. What is left of that page is the control ceiling, not the folding: 173 buttons are on it and the reading numbers 160, so the run is only the numbered ones. Folding needs a run of eight or more identical roles with consecutive refs and a counter that never skips; a shorter run, or one whose numbers jump, is printed as it always was, because folding is worth doing only when the controls really are one list.

A question narrows the reading rather than the page. `browser_read` with `mode:"query"` ranks the passages that answer it, and prints only the controls whose own name was touched by one of the question's words:

```
node benchmarks/harness/measure-reading.mjs --fixture wide-page --query status
question "status": 1 control kept, 159 left out
```

A question that matches nothing on the page keeps every control — nothing matched, so nothing was filtered.

The count is always stated when it is not zero, on its own line after the passages:

```
controls not shown: 159 (left out of this reading; their numbers still work)
```

That last clause is the part worth being exact about, because it is the difference between a shorter reading and a broken one. The refs are handed out from the whole page before anything is filtered, so a control left out of the printed list is still a valid address: `browser_click` with `[100]` works whether or not line 100 was printed. Filtering chooses which names are worth the characters; it never removes a landing place.

Measured on the fixtures here, same reading before and after, each at the default budget:

| fixture     | controls printed | after a question | characters before | after |
| ----------- | ---------------- | ---------------- | ----------------- | ----- |
| `wide-page` | 160              | 1 (`status`)     | 1777              | 72    |
| `wide-page` | 160              | 95 (`item`)      | 1777              | 95    |
| `long-page` | 61               | 2 (`status`)     | 7524              | 91    |
| `long-page` | 61               | 5 (`refund`)     | 7524              | 367   |

The budget still applies on top of the filter: the same `status` question on the wide page at `maxChars: 400` prints 19 controls in 34 characters. A question chooses which names are worth printing; `maxChars` decides when to stop.

The 60000-character button name is unchanged by both rules — folding needs a run, and no question makes one control's name shorter — which is why the name ceiling and this filtering are separate mechanisms that both have to exist.

## Writes are addressed by a read

There is no way to hand this route a coordinate. `browser_click` takes a `ref` or some visible text, `browser_type` takes a `ref` and the text, and `browser_drag` takes two numbers — one for each end — and none of them accepts a point on screen — so a write that acts on a control has to name it with something a read returned, and that number or name is the whole address. Both kinds are held to the read: a number must be one the last read produced, and a text must appear in a name the last read said out loud, so neither can reach a control the caller has not seen. A click by text that the last read did not name is refused the same way an invented number is:

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
