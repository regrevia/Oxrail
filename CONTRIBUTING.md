# Contributing

Oxrail is spec-first. Start with `AGENTS.md` and the exact work package in `spec/OXRAIL_SPEC.md`.

## Branches

- Target `dev` for normal development and run the affected module tests with each module-sized change.
- At a milestone, run the complete regression and release gate, then merge the accepted milestone into `main`.
- `dev` tracks the latest development state; `main` tracks the latest stable state.

## Local checks

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Browser-facing changes must also run the relevant controlled fixture tests. Release changes run:

```bash
pnpm release:gate
```

## Pull requests

Keep changes tied to one or more `WP-*` and list the related `REQ/GATE/TEST/KILL` IDs. Include the command output or evidence manifest that proves the acceptance criteria. Do not mark a work package accepted without its required evidence.

If behavior or a normative contract changes, update `spec/OXRAIL_SPEC.md`, its byte-identical `SPEC.md` mirror, spec version/changelog, indexes, and checksums in the same change.

Do not add dependencies when the platform, standard library, or existing dependency already covers the need. Do not add real accounts, credentials, private screenshots, or trust-bypass instructions to tests or documentation.
