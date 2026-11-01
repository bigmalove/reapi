#!/usr/bin/env bash
# Deployment build for the autoscale deployment (see .replit [deployment].build).
#
# Replit's deploy builder starts from a clean checkout with no node_modules, so
# it must install before it builds; and it sets no PORT/BASE_PATH/PORT-like
# variables, which is why the vite configs no longer require them. Only the two
# artifacts that are actually served are built — artifacts/mockup-sandbox is dev
# tooling and has no business failing a deployment.
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

bash scripts/bootstrap.sh

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

step "Build api-server (esbuild bundle)"
pnpm --filter @workspace/api-server run build

step "Build api-portal (vite static bundle)"
pnpm --filter @workspace/api-portal run build

step "Deployment build complete"
ls -la artifacts/api-server/dist/index.mjs artifacts/api-portal/dist/public/index.html
