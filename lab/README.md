# Oxrail Lab

Oxrail Lab contains internal experiments, evidence tooling, controlled probes,
and fixture-only credential demonstrations. It is a separate, explicitly
started development deliverable and is not part of the Oxrail product plugin.

Lab data and build caches use `~/.oxrail-lab`. Lab must not read or mutate the
product `~/.oxrail` state root, grant browser permissions, trust product Hooks,
or release product Handoff and credential locks.

Current probes and credential demonstrations are fixture-only and do not prove
real ChatGPT Desktop, Chrome, Handoff, or Credential protection support.

`WP-LAB-004` adds an internal, independent Codex Hook visibility probe. Build it
with `pnpm build:lab`, then follow
[`docs/trial/macos-chrome-hook.md`](../docs/trial/macos-chrome-hook.md). The real
Chrome verdict remains blocked until that procedure runs on the macOS host; the
Linux fixture tests prove only projection, IPC, packaging, and neutral failure
behavior.

The synthetic credential UI is launched explicitly with
`pnpm --dir lab credential:demo -- prompt`. It accepts only the fixed test
value format and keeps its Swift build cache under `~/.oxrail-lab`.

To inspect or remove only the old pre-separation fixture build cache, use
`pnpm --dir lab legacy-demo -- status` or
`pnpm --dir lab legacy-demo -- purge-build-cache`. This command never scans or
deletes Keychain items or other product state.
