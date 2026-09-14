# macOS Chrome Hook visibility smoke

This is an internal `WP-LAB-004` diagnostic. It does not activate the Oxrail
product, Guard, Handoff, credential protection, or performance claims.

## Preconditions

- Run on the macOS machine that has the current ChatGPT desktop app, Codex, and
  the ChatGPT Chrome extension.
- Use a dedicated Chrome profile and the repository's loopback fixture only.
- Keep the real Chrome window and current tab visible. Do not clone, hide, or
  close the tab.
- Disable the product Oxrail plugin for the baseline diagnostic. The separate
  Lab plugin must be the only experimental Hook source.
- Review and trust the exact Lab Hook definition in `/hooks`; installation never
  grants trust.

## Start the controlled page

In terminal 1:

```bash
cd /absolute/path/to/Oxrail
pnpm fixture:serve
```

Open `http://127.0.0.1:4173` in the dedicated Chrome profile and confirm the
visible click count is `0`.

## Start the Lab feedback loop

In terminal 2:

```bash
cd /absolute/path/to/Oxrail
./lab/scripts/hitl-chrome-hook.sh chrome-hook-smoke-001
```

The script prints the generated local marketplace path. In terminal 3, run the
two printed `codex plugin` commands. Restart the ChatGPT desktop app, enable only
`oxrail-lab-codex-hook`, review/trust its current definition in `/hooks`, and
start a new Codex chat. Return to terminal 2 and follow its prompts.

For the control phase, ask Codex to run one harmless command:

```text
Run pwd once and report only whether it succeeded.
```

For the Chrome phase, explicitly select `@Chrome` and use:

```text
In the current visible Chrome tab at the local Oxrail fixture, click the button
labelled Click exactly once, verify that its visible count is 1, then stop. Do
not open, duplicate, hide, or close any tab. Use only native Chrome Computer Use.
```

Report `pass` to the terminal only when the same visible Chrome tab shows count
`1`. After the run, disable or remove the Lab plugin so monitoring OFF means the
Lab Hook is not registered or executed.

## Interpret the result

- `CONTROL_HOOK_NOT_OBSERVED`: plugin/session/trust failure; no Chrome conclusion.
- `CHROME_ACTION_NOT_CONFIRMED`: the browser route did not complete; no Hook
  coverage conclusion.
- `CHROME_ROUTE_NOT_OBSERVED`: the local Hook control passed and the Chrome
  action completed, but the Chrome phase produced no paired Hook event. This is
  a real KILL-K1 candidate, not yet the 100-call acceptance result.
- `CHROME_ROUTE_UNCLASSIFIED`: Hook events occurred in the Chrome window, but no
  exact host inventory bound them to Chrome. Preserve the exact tool names and
  keep support `PARTIAL/BLOCKED`.
- `CHROME_ROUTE_OBSERVED`: an operator-supplied inventory binding and a paired
  Pre/Post were observed. This remains a smoke result until provenance, build
  tuple, isolation, repetition, and independent review are complete.

The summary is written under
`~/.oxrail-lab/runs/<run-id>/chrome-hook-summary.json`. The event log contains
only bounded tool identifiers and HMAC correlation references; it excludes tool
input/output, cwd, transcript, page content, screenshots, and credentials.
