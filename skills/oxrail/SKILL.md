---
name: oxrail
description: Preserve native Chrome Computer Use while applying only verified Oxrail guard and Handoff capabilities. Use for browser tasks when the Oxrail plugin is installed, or when asked to verify Oxrail setup, report its mode, diagnose its hooks, or perform an Oxrail-protected browser task.
---

# Oxrail

Keep native Computer Use in control. Oxrail is a gate, not a second browser executor.

## Before browser work

1. Resolve paths relative to this Skill directory and run the bundled setup verification:

   ```bash
   node scripts/doctor.mjs
   ```

   In a source checkout, run `pnpm run doctor` after `pnpm build`.

   Doctor's plugin, Skill, and Hook-definition checks are package file checks, not host registry queries. When this command is invoked through the Oxrail Skill, that invocation is the evidence of current-thread Skill availability; a source-checkout doctor run proves only that the definition is present.

2. Read the reported setup state, Oxrail mode, Optimization, Safety, and Handoff fields independently.
3. If Hook trust is pending, ask the user to open `/hooks`, review the current commands, and trust them through the normal host UI. Never alter or bypass host trust for the user.
4. If the Skill was just installed, tell the user that a new thread/session is required before relying on Skill availability.

If doctor reports `host profile not found`, use an exact inventory exported by the current host:

```bash
node scripts/bootstrap.mjs <host-inventory.json>
```

Then rerun setup verification with the same freshly exported inventory:

```bash
node scripts/doctor.mjs --host-inventory <host-inventory.json>
```

Resolve the scripts relative to this Skill directory. Accept only `source: "host-tool-inventory"` with exact browser tool names. Never guess a private tool name, use a wildcard, or claim that bootstrap proves Hook trust. Regenerate the inventory after a host/Codex/Computer Use/browser/OS change. If no reliable current inventory is available, remain `INSTALLED`/`BYPASSED` and keep enforcement capabilities inactive.

Do not issue a real browser action merely to validate installation. The alpha library reserves a harmless synthetic-probe interface, but the installed alpha CLI has no public host probe adapter and must not claim it ran one. Accept `READY — awaiting first native browser call` and use only passive verification on the first naturally occurring browser call.

## Interpret status honestly

- `INSTALLED`: files are present; Hooks and protection are not implied.
- `CONFIGURED`: required artifacts/capabilities are present; the real browser route may still await observation.
- `VERIFIED`: a harmless probe or passive natural browser call proved the expected Hook path.
- `BYPASSED`: Oxrail optimization is unavailable. Native Computer Use remains available.

Treat Safety and Handoff as active only when doctor explicitly reports `ACTIVE`. When either is `INACTIVE`, state that clearly before any step that would otherwise rely on that protection.

The current `0.1.0-alpha.0` runtime is passive-only. A `VERIFIED` route therefore remains `ADVISORY_ONLY` / `BYPASSED`; do not infer Guard, Safety, or Handoff enforcement from verification alone.

## During native browser work

- Use the host's native Chrome Computer Use tools and preserve their action/result envelopes.
- On the first naturally occurring browser call, allow passive route verification: record detection and pass the original action through unchanged.
- Do not block, rewrite, replay, or duplicate an action for installation verification.
- Pass ordinary actions through. Apply an Oxrail denial only when the active, verified profile supports that gate and the Hook returns a documented reason code.
- Respect host-native approvals and safety decisions as authoritative.
- Never claim per-click visibility, secret protection, Handoff exclusivity, or performance gains that the current profile does not prove.

## Failure behavior

If a Hook is absent, untrusted, unsupported, times out, returns malformed output, or cannot identify the browser route:

1. Do not disable native Chrome Computer Use.
2. Report `Oxrail optimization unavailable / BYPASSED`.
3. Report `Safety protection: INACTIVE` and `Handoff protection: INACTIVE` unless separately verified capabilities remain active.
4. Continue the user's native action unchanged when the host permits it.

Do not present fail-open behavior as active Oxrail protection.

## Handoff

Use Handoff only when the current report says it is `ACTIVE`. While a verified human lease is active, do not take browser actions or consume protected observations. After resume, invalidate stale targets and obtain a fresh native observation before acting.

If Handoff is inactive, use ordinary host-native user interaction/approval and say that Oxrail's Handoff protection is unavailable.

## Setup help

For installation, trust review, state definitions, and source-checkout commands, follow the repository `README.md`. The canonical behavior and claim limits are in `spec/OXRAIL_SPEC.md`.
