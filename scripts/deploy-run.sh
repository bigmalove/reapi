#!/usr/bin/env bash
# Deployment run command (see .replit [deployment].run).
#
# Deliberately does NOT use pnpm or node_modules. The Replit package firewall
# answers 403 ("No authorization header was set") for any tarball it has not
# cached, so `pnpm install` in this container cannot be relied on. dist/index.mjs
# is a complete esbuild bundle (express/pg/pino included) committed to the repo,
# so the deployment only needs `node`.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$ROOT/artifacts/api-server/dist/index.mjs"

if [ ! -f "$BUNDLE" ]; then
  echo "!! $BUNDLE missing — dist is committed; did a build wipe it?" >&2
  exit 1
fi

if [ -z "${PORT:-}" ]; then
  echo "!! PORT is not set; the platform injects it for the deployment" >&2
  exit 1
fi

export NODE_ENV="${NODE_ENV:-production}"

echo "==> starting api-server bundle ($(du -h "$BUNDLE" | cut -f1)) on :$PORT"
echo "==> portal: $ROOT/artifacts/api-portal/dist/public"

exec node "$BUNDLE"
