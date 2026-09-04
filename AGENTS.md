# Oxrail agent instructions

`spec/OXRAIL_SPEC.md` is the only product specification. `SPEC.md` must remain byte-identical as a convenience mirror; generated indexes and README are not normative.

Before changing behavior:

1. Read `SEC-00`, the target `SEC-*`, the target `WP-*`, and its direct dependencies.
2. Search exact `REQ-*`, `GATE-*`, `TEST-*`, and `KILL-*` IDs.
3. Implement the smallest change that satisfies the cited contract.
4. Run the narrow test, then `pnpm check`; release work also runs `pnpm release:gate`.

Non-negotiable boundaries:

- Native Computer Use remains the browser writer. Oxrail never replays or substitutes native pointer/keyboard actions.
- Plugin install, setup, and doctor never modify host Hook trust. The human reviews and trusts the current hash in `/hooks`.
- Default setup verification creates no real Browser action. A natural first Browser call is passive verification only.
- Hook unavailability is fail-open for Native Computer Use and must report Oxrail `BYPASSED`; inactive Safety/Handoff must be explicit.
- Do not claim ChatGPT Web lifecycle-hook support from Codex evidence.
- Never put credentials, page secrets, real login screenshots, or raw private page content in fixtures, traces, or evidence.

Spec changes require a version/changelog update, byte-identical mirror, regenerated indexes, and both checksum files.

Branch flow: normal development targets `dev` and runs the affected module tests. At a milestone, run the complete regression/release gate and merge the accepted result into `main`. `dev` is the latest development line; `main` is the latest stable line. Do not put routine unfinished work directly on `main`.
