# WP-LAB-004 delivery

WP: `WP-LAB-004`

Status: `IN_REVIEW / REAL_HOST_BLOCKED`

This change adds an independent `codex-local-hook-v1` Lab adapter, a local Lab
plugin marketplace, and a structured macOS HITL feedback loop. The adapter does
not import or call product Hook, profile, Core, Guard, Handoff, or credential
code. It accepts only real `PreToolUse`/`PostToolUse` input delivered by the
host, projects bounded metadata, HMACs session/call identifiers, and submits a
strict `SafeEvent` over the authenticated local collector IPC.

The Lab Hook always exits neutrally. It does not emit `permissionDecision`,
`systemMessage`, `additionalContext`, rewritten input, or result replacement.
Missing configuration, malformed input, collector failure, and timeout all
remain fail-open for the native tool call.

The trial separates a paired `Bash` control phase from an explicit `@Chrome`
phase and requires a visible controlled postcondition. Its verdicts distinguish
Hook/session failure, failed Chrome execution, no Chrome-window Hook event,
unclassified event visibility, and an inventory-bound candidate route.

What this does not prove:

- This Linux development host cannot run ChatGPT macOS or Chrome Computer Use.
- The official Host documentation does not expose a machine-readable Computer
  Use tool inventory export; an operator-provided file remains unverified
  provenance.
- A single smoke does not meet the 100-invocation `WP-HOST-003` acceptance bar.
- No result activates product Guard, Safety, Handoff, Credential, retrieval, or
  filtering capabilities.

Real-host acceptance stays `BLOCKED` until the macOS procedure in
`docs/trial/macos-chrome-hook.md` is executed and reviewed. If the local control
passes, the visible Chrome postcondition passes, and no Chrome-phase Hook event
appears, record a KILL-K1 candidate and repeat only under the pre-registered
route matrix; do not invent tool names or continue transparent-middleware
claims.

## Verification on the development host

Baseline: `dev` at `8736252c69134813382a4845aaaec4a38519eec4`.

- `pnpm check`: exit `0`; product `448` tests and Lab `44` tests passed.
- Plugin contract validator against the built Lab plugin: exit `0`.
- `./lab/scripts/hitl-chrome-hook.sh smoke-linux`: exit `2`, expected
  `BLOCKED` because this host is Linux and cannot supply real macOS Chrome
  evidence.
- `pnpm release:gate`: exit `1`, expected while the real Desktop Chrome route,
  HostReality, paired experiment, and release evidence remain absent.

These results verify packaging, isolation, safe projection, authenticated IPC,
neutral failure behavior, and verdict calculation. They are not real Host
evidence and must not be promoted to `PASS`.
