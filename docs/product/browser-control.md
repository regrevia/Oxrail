# Browser Control

Browser Control is an opt-in browser route. A host that enables it gets ten tools for reading and driving a Chrome window that the route starts for itself. It is not the person's browser, it is not a second view of what the person has open, and it is not the default route: Native Computer Use still drives the desktop unless a host is configured to launch this one.

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

| Tool            | Purpose                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------- |
| `browser_open`  | Start the route's Chrome, optionally at a URL, and return its state                       |
| `browser_view`  | Read the page as text with numbered controls; each number is a `ref`                      |
| `browser_click` | Click a `ref` from the last read, or the first control matching some text                 |
| `browser_type`  | Type into a field, optionally clearing it first or pressing Enter                         |
| `browser_key`   | Press one named key; `browser_type` is the normal way to enter text                       |
| `browser_nav`   | Open a URL, go back, or reload, and return the new state                                  |
| `browser_shot`  | Take a PNG of the viewport or the full page, and return it with its path                  |
| `browser_state` | Report whether a browser is running, how long it has been idle, and what it will close in |
| `browser_login` | Report whether the route's own profile holds saved sign-ins                               |
| `browser_close` | Stop the route's Chrome and return the final state                                        |

`browser_view` renders each control as a line such as `[12] button "Sign in"`. The `12` is the `ref` that `browser_click` and `browser_type` accept until the page changes or is read again; using an old `ref` fails with a message telling the model to read the page again.

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
