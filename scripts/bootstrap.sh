#!/usr/bin/env bash
# Workspace dependency bootstrap.
#
# Why this file exists: every artifact workflow in the Replit workspace runs
# `pnpm --filter <pkg> run dev` from the repo root. When the install step that
# precedes it fails, times out, or is skipped, pnpm emits
#   WARN  Local package.json exists, but node_modules missing, did you mean to install?
# and the workflow dies with `sh: 1: vite: not found` or
# `Cannot find package 'esbuild'`. Those two errors are install failures wearing
# a build costume, so install has to be a single, repeatable, self-diagnosing
# entry point that deployments, post-merge and humans all call.
#
# Usage: bash scripts/bootstrap.sh [--no-install]
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

SKIP_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --no-install) SKIP_INSTALL=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
fail() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# Replit's workflows, post-merge hook and deploy builder all run without a TTY.
# In that mode pnpm refuses to purge an out-of-date node_modules and exits 1 with
#   ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
# instead of healing the tree — install dies, then every artifact workflow reports
# "node_modules missing".
export CI="${CI:-true}"
export npm_config_confirm_modules_purge="${npm_config_confirm_modules_purge:-false}"

step "Toolchain"
info "node $(node -v 2>/dev/null || echo 'missing')"
info "pnpm $(pnpm -v 2>/dev/null || echo 'missing')"
command -v pnpm >/dev/null 2>&1 || fail "pnpm not on PATH — enable the nodejs module / corepack"

PNPM_MAJOR="$(pnpm -v | cut -d. -f1)"
case "$PNPM_MAJOR" in
  9|10|11)	info "pnpm major $PNPM_MAJOR accepted (lockfileVersion 9.0)" ;;
  *) info "WARN pnpm $PNPM_MAJOR is outside the tested range 9–11; lockfile features (catalogs, minimumReleaseAge) may be ignored" ;;
esac

# Serialise with scripts/ensure-deps.mjs: Replit starts the artifact workflows and
# the deploy build in parallel, and two concurrent `pnpm install` runs on one
# node_modules fail with
#   ERR_PNPM_ENOTEMPTY: directory not empty, rename '...yaml_tmp_447' -> '...yaml'
# `.cache/` is git-ignored and lives outside node_modules, which a purging install
# would delete.
LOCK_DIR="$PWD/.cache/install.lock"
acquire_lock() {
  mkdir -p "$PWD/.cache"
  local waited=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [ -d "$LOCK_DIR" ] && [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then
      info "removing stale install lock"
      rm -rf "$LOCK_DIR"
      continue
    fi
    if [ "$waited" -ge 1200 ]; then
      fail "timed out waiting for another install to finish"
    fi
    info "another install is running — waiting"
    sleep 2
    waited=$((waited + 2))
  done
  echo "$$ $(date -Is)" > "$LOCK_DIR/owner"
}
release_lock() { rm -rf "$LOCK_DIR"; }

if [ "$SKIP_INSTALL" -eq 0 ]; then
  acquire_lock
  trap release_lock EXIT

  step "Install dependencies (frozen lockfile)"
  if pnpm install --frozen-lockfile --prefer-offline; then
    info "frozen install OK"
  else
    status=$?
    info "frozen install failed (exit $status)."
    info "Most common causes: a package.json changed without regenerating pnpm-lock.yaml,"
    info "or the registry blocked a pinned version. Retrying with a lockfile refresh."
    step "Install dependencies (lockfile refresh)"
    pnpm install --no-frozen-lockfile --prefer-offline \
      || fail "install failed even without --frozen-lockfile — see the registry error above"
    info "lockfile was rewritten; commit pnpm-lock.yaml so the next frozen install stays green"
  fi
  release_lock
  trap - EXIT
fi

step "Verify every workspace package can resolve its own tools"
missing=0
check_bin() { # <label> <path-to-node_modules/.bin/<tool>>
  if [ -x "$2" ]; then
    info "ok   $1"
  else
    info "MISS $1 -> $2"
    missing=1
  fi
}
check_bin "api-portal: vite"    "artifacts/api-portal/node_modules/.bin/vite"
check_bin "mockup-sandbox: vite" "artifacts/mockup-sandbox/node_modules/.bin/vite"
check_bin "api-server: esbuild" "artifacts/api-server/node_modules/.bin/esbuild"

if [ "$missing" -ne 0 ]; then
  fail "node_modules is incomplete after install — re-run 'pnpm install' and read its output, do not just retry the workflow"
fi

step "Bootstrap complete"
info "workflows can now run: pnpm --filter @workspace/api-server run dev"
info "                        pnpm --filter @workspace/api-portal run dev"
