# Dependency audit — 2026-11-17

What the dependency alerts and audit commands actually say at this commit,
recorded so the next reader does not have to re-derive it from a banner.

## Measured

- **Branch / commit:** `main` @ `d52da2f` (the merge of `dev` into `main`)
- **Package manager:** pnpm `10.18.3`, lockfile `pnpm-lock.yaml` committed
- **`pnpm audit --prod`:** exit 0, `No known vulnerabilities found`
- **`pnpm audit --dev`:** exit 0, `No known vulnerabilities found`
- **Dependabot alerts for the repository:** 17, every one of them in state
  `fixed`

## The banner

Every push prints this on stderr:

```
remote: GitHub found 15 vulnerabilities on regrevia/Oxrail's default branch
remote: (4 critical, 3 high, 7 moderate, 1 low).
```

That line is not a fresh finding and it does not match the alert list: the
API reports 17 alerts, all fixed, while the banner says 15. It is a cached
summary and it is stale. A push that ends this way has not failed — the
push itself succeeds and the exit status is 0.

## Runtime and build surface

`package.json` has no `dependencies` key, so nothing in what ships installs a
package at runtime. The shipped MCP server is built to a single dependency-free
file (`dist/browser-control/mcp.mjs`); the build asserts zero `zod` markers in
that output, because `zod` is present only for the tool schemas the build
inlines away. Everything installed is a dev dependency
(`@playwright/test`, `@types/node`, `esbuild`, `prettier`, `typescript`,
`vitest`, `zod`), used to build, test, and format.

Patched transitive versions are pinned through `pnpm.overrides` rather than
held back by a range bump, currently `vite: 7.3.7` and
`source-map-js: 1.2.2`. A `pnpm.overrides` entry is the accepted mechanism in
this repository for pulling a transitive dependency to a fixed version.

## What this record does not claim

A clean `pnpm audit` and a fixed Dependabot alert say nothing about whether
the product is safe to run against real pages, and nothing in the release
gate moves because of them. Release acceptance still rests on
`evidence/WP-RLS-010/local/manifest.json`, which is `BLOCKED` on host reality
this repository cannot manufacture (see `pnpm release:gate`).

Re-run the two audit commands before quoting these numbers; they describe one
commit, not a standing property.
