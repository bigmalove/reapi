#!/usr/bin/env bash
# Deployment run command (see .replit [deployment].run).
#
# The deployment container gets the source tree plus whatever deploy-build.sh
# produced; PORT is injected by the platform. This script fails loudly instead of
# silently starting nothing when dist is missing.
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

if [ ! -f artifacts/api-server/dist/index.mjs ]; then
  echo "!! artifacts/api-server/dist/index.mjs missing — deploy-build.sh did not run" >&2
  exit 1
fi

export NODE_ENV="${NODE_ENV:-production}"

exec pnpm --filter @workspace/api-server run start
