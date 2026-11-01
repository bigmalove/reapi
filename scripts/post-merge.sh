#!/usr/bin/env bash
# Runs after a merge/rebase lands in the Replit workspace (.replit [postMerge]).
#
# Two things were wrong with the previous version:
#   1. `pnpm install --frozen-lockfile` under `set -e`: any stale lockfile aborted
#      the whole hook, leaving the workspace with no node_modules — every artifact
#      workflow then failed with `sh: 1: vite: not found` and
#      `Cannot find package 'esbuild'`.
#   2. `pnpm --filter db push` never matched a package: it is named
#      `@workspace/db`, so the drizzle push silently never ran.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

# Tolerant install: bootstrap falls back to a lockfile refresh and says why.
bash scripts/bootstrap.sh \
  || echo "!! dependency bootstrap failed; workflows keep failing until it succeeds" >&2

# Schema push needs a live database (autoscale provisions one lazily).
if [ -n "${DATABASE_URL:-}" ]; then
  pnpm --filter @workspace/db run push || echo "!! drizzle push failed (schema may be stale)" >&2
else
  echo "DATABASE_URL not set — skipping drizzle push"
fi

exit 0
