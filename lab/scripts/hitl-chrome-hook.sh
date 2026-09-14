#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "BLOCKED: this real Chrome Host trial must run on macOS." >&2
  exit 2
fi

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo "usage: $0 <run-id> [--inventory <host-inventory.json>]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$repo_root"
pnpm build:lab

marketplace_root="$repo_root/lab/dist/codex-hook-marketplace"
echo "Lab marketplace: $marketplace_root"
echo "Install explicitly with:"
echo "  codex plugin marketplace add $marketplace_root"
echo "  codex plugin add oxrail-lab-codex-hook@oxrail-lab-local"
echo "Then review/trust the current definition in /hooks and start a new Codex chat."

run_id="$1"
shift
exec node lab/dist/chrome-hook-trial.mjs --run-id "$run_id" "$@"
