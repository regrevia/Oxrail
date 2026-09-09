# Oxrail

Oxrail is a native-preserving control layer for browser work in Codex. Native
Computer Use remains the only browser writer. The installed product contains no
experiment recorder, benchmark runner, report generator, or credential demo.

After installation, review the bundled Hook definitions in the host `/hooks`
UI and trust the current hash manually. Then start a new thread and ask Oxrail
to run setup verification. Installation and a successful `doctor` process do
not by themselves prove that Guard, Handoff, Safety, or Credential protection
is active.

When Oxrail cannot verify its current Host Profile and browser route, Native
Computer Use remains available and Oxrail reports `BYPASSED`; unavailable
Safety, Handoff, and Credential capabilities report `INACTIVE`.

Project documentation and the authoritative specification are maintained at
https://github.com/regrevia/Oxrail.

## Alpha.5 trial check

This product-only tree is bound to the immutable ref
`product-v0.1.0-alpha.5`. From the installed plugin root, run:

```bash
node skills/oxrail/scripts/trial-check.mjs
```

The command first verifies the exact product file allowlist and SHA-256 hashes,
then runs the read-only doctor. `artifactIntegrity: PASS` proves only that the
installed files match this preview. The first expected readiness result is
`HOST_SETUP_REQUIRED` until the current Hook definition is reviewed and trusted
by the user in `/hooks` and a current host inventory is bootstrapped.

After trust and bootstrap, start a new session and use one naturally required,
public-page Chrome action. Rerun the command immediately afterwards. A passive
route observation may advance the lifecycle, but this preview still reports
Optimization `BYPASSED` and Safety, Handoff, and Credential protection
`INACTIVE`. It does not yet provide retrieval filtering or a secure credential
window. Do not use real secrets for this trial.

`hostDiagnostics.hookTrustQuery` and `toolInventoryExport` are
`UNAVAILABLE_PUBLIC_API` because the current public Host documentation exposes
neither interface. `/hooks` is authoritative for trust. Runtime delivery is a
separate fact and becomes `OBSERVED_CURRENT_DEFINITION` only after a recent
current-hash Hook event. Select Chrome explicitly with `@Chrome` in a new Codex
chat; a specialized Chrome path may still bypass lifecycle Hooks and must then
remain `BLOCKED`.

## License

Apache-2.0. See `LICENSE`.
