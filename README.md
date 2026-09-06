<p align="center">
  <img src="icon/oxrail.png" alt="Oxrail logo" width="160">
</p>

# Oxrail

> **Strong agent. Short leash.**
>
> **牛可以干活，但不能让它乱跑。**

Oxrail is an experimental, native-preserving control layer for agent browser work. It does not replace Chrome or Computer Use, and it never owns the pointer or keyboard. Its job is to add only the browser guard behavior proven for the current host profile.

> **Benchmark in progress. No performance claim yet.**

The authoritative product contract is [spec/OXRAIL_SPEC.md](spec/OXRAIL_SPEC.md). Any shorter description here yields to that specification.

## Current support

| Surface                          | Plugin / Skill                                           | Oxrail lifecycle hooks                                               | Native Chrome route                              | Current public claim                                          |
| -------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| Codex CLI                        | GitHub marketplace install; Skill loads in a new session | Public Codex hook framework                                          | Must be verified for the installed build/profile | `ADVISORY_ONLY` until doctor and route evidence say otherwise |
| Codex in the ChatGPT desktop app | Plugin surface supported                                 | Codex hooks require manual trust                                     | Must be verified independently                   | No enforcement claim without a `VERIFIED` profile             |
| ChatGPT Work / ChatGPT web       | Public plugins/skills depend on the available directory  | No public Codex lifecycle-hook contract established for this surface | Unproven                                         | No Oxrail hook enforcement claim                              |
| Codex IDE extension              | Plugins are not supported by the current public docs     | Not applicable                                                       | Not applicable                                   | Unsupported install surface                                   |

Native Interaction Fidelity and real-host benchmark evidence are still in progress. Secure Handoff is not active merely because the plugin is installed.

## Install from GitHub

Requires a current Codex CLI with plugin marketplace support and Node.js 20 or newer.
`main` is the latest accepted stable line; ongoing development happens on `dev` and reaches `main` only after a milestone gate passes.
The default `main` marketplace continues to install `v0.1.0-alpha.0`. The `dev` marketplace installs the immutable `v0.1.0-alpha.2` development preview; it is not an accepted stable release.

```bash
codex plugin marketplace add regrevia/Oxrail
codex plugin add oxrail@oxrail
```

For the current development preview on a clean test profile, pin the marketplace checkout to `dev`:

```bash
codex plugin marketplace add regrevia/Oxrail@dev
codex plugin add oxrail@oxrail
```

Then:

1. For native Chrome work, install/enable **Computer Use** in the ChatGPT desktop app, then connect the ChatGPT Chrome extension under **Settings > Computer Use**. Review the host and browser permission prompts.
2. Start Codex and open `/hooks`.
3. Review the Oxrail hook source and commands, then manually trust the current definition.
4. Start a new thread/session so the installed Skill is available.
5. Ask: `Use Oxrail to run setup verification (oxrail doctor).`

Invoking doctor through that Skill is the evidence that the Skill is available in the current thread. The alpha CLI does not query the host plugin/Skill registry. Oxrail never auto-trusts its hooks. A changed hook definition/hash returns to the host's normal review flow; each Hook command carries the manifest version as a build stamp so a version update changes that definition. Do not bypass the review.

For an agent given only this repository URL: run the two marketplace commands above, report any missing Computer Use/Chrome prerequisite, stop for the human `/hooks` review, then start a new thread and run setup verification. Installation is not authorization to alter host trust state or browser permissions.

### Host profile bootstrap

Oxrail does not guess private Computer Use tool names. If doctor reports `host profile not found`, provide an exact, host-exported tool inventory and ask the Oxrail Skill to bootstrap it. Example inventory shape:

```json
{
  "schemaVersion": 1,
  "source": "host-tool-inventory",
  "capturedAt": "2026-09-04T00:00:00.000Z",
  "surface": "codex-desktop",
  "hostBuild": "<exact host build>",
  "codexVersion": "<exact Codex version>",
  "computerUsePluginVersion": "<exact Computer Use version>",
  "browserPath": "chrome-extension",
  "os": "macos",
  "toolRoute": "direct-mcp",
  "browserToolNames": ["<exact host-exported browser tool name>"]
}
```

The installed Skill runs `node scripts/bootstrap.mjs <host-inventory.json>`. A source checkout uses:

```bash
pnpm run bootstrap host-inventory.json
pnpm run doctor -- --host-inventory host-inventory.json
```

Bootstrap records a candidate matcher and current Hook definition hash, but it leaves lifecycle `INSTALLED`, Optimization `BYPASSED`, and trust/Safety/Handoff unclaimed. Doctor promotes the profile only after current-hash Hook execution proves the remaining setup checks. If the host cannot export a reliable exact inventory, do not invent one; remain fail-open in `INSTALLED`/`BYPASSED`.

Reuse a freshly exported inventory with doctor so any enforcement capability is bound to the exact host/Codex/Computer Use/browser/OS tuple. Without that current tuple, doctor may report passive route evidence but keeps Optimization, Safety, and Handoff bypassed/inactive. Regenerate the inventory after any bound version or route changes.

Installed Skill commands and Hooks share the permission-restricted `~/.oxrail` state directory. This avoids relying on Hook-only environment variables when an agent invokes doctor from the Skill.

### Try the macOS private-input loop

The `dev` preview includes a deliberately fixture-only credential-input demonstration for macOS 13 or newer. Xcode Command Line Tools (including Swift) must be installed; the first run builds a small native helper in `~/.oxrail/credential-demo/`.

After installing the `dev` plugin and starting a new session, ask:

```text
Use Oxrail's macOS credential-input trial. Open the native prompt, then verify, consume, and revoke the returned opaque reference.
```

In the native window, enter only a synthetic value such as `oxrail_test_0123456789abcdef`. Do not paste a real API key into chat, a terminal, or this preview. The model receives only a validated `ocref1_…` reference; the native process stores the synthetic value in a device-only macOS Keychain item, clears an exactly matching system pasteboard value after a successful save, verifies local retrieval without returning the value, and then revokes it.

This is a UX and isolation trial, not production Credential protection: it accepts no real credentials, performs no network request, is not connected to the Chrome/Handoff route, and must display `Credential protection: INACTIVE (fixture-only trial)`. Third-party clipboard managers remain outside its boundary.

## Setup verification

`oxrail doctor` reports each item independently. Its first three checks are deliberately package-level file checks, not claims about a private host registry:

- plugin package manifest present;
- Oxrail Skill definition present (current-thread availability is proven only by invoking the Skill);
- required Hook definitions present;
- hooks trusted for the current hash, inferred only from recent execution;
- `PreToolUse` and `PostToolUse` availability;
- Chrome Computer Use detectability;
- matcher/profile validity;
- Handoff capabilities;
- resulting Oxrail mode.

Because the alpha CLI is not connected to host plugin/Skill/trust registry APIs, doctor treats only recent execution of the current Hook hash as Hook trust/availability evidence. Those current-availability markers expire after 30 seconds; completed route evidence remains bound to its profile ID, Hook definition hash, and host tuple. The host `/hooks` UI remains authoritative.

The lifecycle states mean:

| State        | Meaning                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `INSTALLED`  | The plugin files are present. Hooks and protection are not implied.                           |
| `CONFIGURED` | Skill, trusted hooks, host detection, and profile configuration are present.                  |
| `VERIFIED`   | A harmless synthetic probe or a passive real-route observation proved the expected hook path. |

When only the final route observation is missing, doctor prints:

```text
READY — awaiting first native browser call
```

The alpha library reserves an interface for a harmless host-provided synthetic probe, but the installed alpha CLI has no public host probe adapter yet and does not claim to run one. It therefore waits for the first browser call that occurs naturally in the user's work. That call is passive verification only: Oxrail records `first_browser_hook_seen=true` and passes the native action/result through unchanged. It does not block, rewrite, replay, or create a browser action just to test installation.

For a source checkout, the package-level local check is:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm run doctor
```

## Failure and protection status

If an Oxrail hook is missing, untrusted, disabled, unavailable, or fails, Native Chrome Computer Use continues normally:

```text
Oxrail optimization unavailable / BYPASSED
Safety protection: INACTIVE
Handoff protection: INACTIVE
```

`BYPASSED` is fail-open for the native browser capability, not proof of Oxrail protection. Safety and Handoff are shown as `ACTIVE` only when their required capabilities are verified and currently effective. Host-native approvals and safety controls remain authoritative.

The current `0.1.0-alpha.2` public runtime adapter is passive-only, so even a verified route remains `ADVISORY_ONLY`, with Optimization `BYPASSED` and Safety/Handoff/Credential protection `INACTIVE`. The macOS synthetic credential-input trial does not change that status. Internal fixture foundations cannot become active until a real adapter and its version-bound evidence are accepted.

## What v0.1 is testing

- ordinary native browser input remains unchanged;
- the actual host route and granularity can be measured honestly;
- repeat/no-progress and stale-target decisions can be tested without becoming a second browser executor;
- hook failure cannot disable native Computer Use;
- status copy never presents inactive secret/Handoff protection as active.

No token reduction, cross-surface coverage, per-click interception, or end-to-end secret guarantee is claimed without reproducible evidence.

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm release:gate
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), the [v0.1 status](docs/status/v0.1.md), the [macOS real-host validation handoff](docs/handoff/macos-v0.1-validation.md), and the [compatibility policy](docs/compatibility/README.md).

## Official host documentation

- [Plugins: install, supported surfaces, and new-session loading](https://learn.chatgpt.com/docs/plugins)
- [Package plugins and bundle lifecycle hooks](https://developers.openai.com/plugins/build/plugins)
- [Codex hooks, trust review, events, and tool coverage](https://learn.chatgpt.com/docs/hooks)
- [Codex plugin and marketplace commands](https://learn.chatgpt.com/docs/developer-commands)
- [Computer Use](https://learn.chatgpt.com/docs/computer-use)

## License

Apache-2.0. See [LICENSE](LICENSE).
