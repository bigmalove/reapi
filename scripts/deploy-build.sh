#!/usr/bin/env bash
# Deployment build (see .replit [deployment].build).
#
# Policy: the deployment must come up even when `pnpm install` cannot run. The
# Replit package firewall 403s every tarball it has not cached ("No authorization
# header was set for the request"), which no repo change can fix, so:
#
#   1. tools already installed → rebuild the bundle + portal
#   2. tools missing           → try to install (best effort, never fatal)
#   3. still missing           → ship the committed dist/ as-is
#   4. dist missing too        → fail loudly
#
# Never call the esbuild/vite build when the tools are missing: build.mjs wipes
# dist/ first, so a failed rebuild would destroy the committed bundle we depend on.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }

have_tools() {
  [ -x artifacts/api-server/node_modules/.bin/esbuild ] &&
    [ -x artifacts/api-portal/node_modules/.bin/vite ]
}

step "1/3 dependency check"
if have_tools; then
  echo "    build tools present — nothing to install"
else
  echo "    build tools missing — attempting install (best effort)"
  bash scripts/bootstrap.sh || warn "install failed; falling back to committed dist/"
fi

step "2/3 build"
if have_tools; then
  pnpm --filter @workspace/api-server run build || warn "api-server build failed"
  pnpm --filter @workspace/api-portal run build || warn "api-portal build failed"
else
  warn "build tools unavailable — keeping the committed artifacts"
fi

step "3/3 verify deployable artifacts"
ok=1
if [ -f artifacts/api-server/dist/index.mjs ]; then
  echo "    ok  artifacts/api-server/dist/index.mjs ($(du -h artifacts/api-server/dist/index.mjs | cut -f1))"
else
  echo "    MISSING artifacts/api-server/dist/index.mjs"
  ok=0
fi

if [ -f artifacts/api-portal/dist/public/index.html ]; then
  echo "    ok  artifacts/api-portal/dist/public/index.html ($(du -h artifacts/api-portal/dist/public/index.html | cut -f1))"
else
  echo "    MISSING artifacts/api-portal/dist/public/index.html"
  ok=0
fi

if [ "$ok" -ne 1 ]; then
  echo "!! no deployable bundle: rebuild locally and commit artifacts/*/dist" >&2
  exit 1
fi

step "deployment build complete"
