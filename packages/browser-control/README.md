# @oxrail/browser-control — opt-in browser route

An **optional** MCP server that gives an agent a browser it drives itself: its own
Chrome process, its own profile, numbered controls, and no involvement of the
person's windows, cursor or clipboard.

It is not part of Oxrail's default posture. The default browser writer stays the
native Computer Use route that the Hook can see and attribute. This package is a
second route that a person has to wire into their host on purpose — nothing here
installs itself, and no manifest enables it.

- Why it exists, what it may and may not do: `docs/adr/ADR-BROWSERCTL-001.md`
  and the `SEC-52` / `REQ-BCTL-*` / `GATE-G16` entries in `spec/OXRAIL_SPEC.md`.
- What the tools do, in prose: `docs/product/browser-control.md`.

## Build

The repository ships the bundle in `dist/` (committed, like every other product
binary):

```sh
pnpm build:product   # writes dist/browser-control/mcp.mjs
node dist/browser-control/mcp.mjs --version
```

`dist/browser-control/mcp.mjs` is the only file a host needs. It has no runtime
dependencies: the CDP client, the WebSocket client and the Chrome launcher are
all in the bundle.

## Wire it in (Claude Code)

Project- or user-level `.mcp.json`:

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/absolute/path/to/oxrail/dist/browser-control/mcp.mjs"]
    }
  }
}
```

## Wire it in (Codex)

`~/.codex/config.toml`:

```toml
[mcp_servers.browser]
command = "node"
args = ["/absolute/path/to/oxrail/dist/browser-control/mcp.mjs"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

Codex asks for approval per tool by default; the route is only ever reached
after a person approves a call, which is the intended gate.

## Wire it in (anything else that speaks MCP over stdio)

Newline-delimited JSON-RPC on stdin/stdout, logs on stderr. Both protocol eras
are served: `server/discover` (MCP `2026-07-28`) and the older
`initialize` + `notifications/initialized` handshake. No other bytes are written
to stdout, including at startup.

## Tools

| Tool            | What it does                                                    |
| --------------- | --------------------------------------------------------------- |
| `browser_open`  | Start (or reuse) this route's Chrome and return its state.      |
| `browser_view`  | Read the page: text plus `[12] button "Sign in"` control lines. |
| `browser_click` | Click a `ref` or some text; refuses when a layer covers it.     |
| `browser_type`  | Type into a field by `ref`; optionally clear or press Enter.    |
| `browser_key`   | Press one named key (Enter, Tab, Escape, arrows, …).            |
| `browser_nav`   | Open a URL, go back, or reload.                                 |
| `browser_shot`  | Screenshot the viewport or the whole page, in CSS pixels.       |
| `browser_state` | Is it running, on what page, and when will it be reclaimed.     |
| `browser_login` | Report the profile and whether it holds a saved sign-in.        |
| `browser_close` | Close the browser now instead of waiting for reclaim.           |

Refs are only valid until the page changes. A stale ref fails with a message
that says to call `browser_view` again — it is never silently re-targeted.

## Configuration

| Variable                  | Default    | Meaning                                                 |
| ------------------------- | ---------- | ------------------------------------------------------- |
| `OXRAIL_BROWSER_HEADLESS` | `1`        | `0` shows a real window (useful once, while debugging). |
| `OXRAIL_BROWSER_PROFILE`  | `default`  | Named profile directory; sign-ins are per profile.      |
| `OXRAIL_BROWSER_IDLE_MS`  | `300000`   | Idle time before the browser closes, clamped 60 s–15 m. |
| `OXRAIL_BROWSER_VIEW`     | `1280x900` | Viewport size as `WxH`.                                 |

State lives under `~/.oxrail/browser-control/`: one directory per profile,
screenshots in `shots/`, Chrome's own stderr in `chrome.err.log`.

Chrome always starts with `--use-mock-keychain`, so macOS never shows a
keychain prompt on the person's screen.

## Reclaim

An idle browser closes itself. The window is 5 minutes after the last tool call
(60 s–15 m via `OXRAIL_BROWSER_IDLE_MS`); `browser_state` reports `closesInMs`,
and the timer does not keep the process alive. `browser_close` closes at once.
A host that ends the session also ends the browser: stdin EOF triggers the same
staged close, so no Chrome survives the server.

## Tests

```sh
npx vitest run tests/browser-control-chrome.test.ts tests/browser-control-mcp.test.ts tests/browser-control-route.test.ts
OXRAIL_BROWSER_LIVE=1 npx vitest run tests/browser-control-live.test.ts
```

The first line is hermetic: fake sockets, fake Chrome, temp directories. The
second line is opt-in and is the only place a real Chrome is launched, so a CI
machine without a browser still passes.
