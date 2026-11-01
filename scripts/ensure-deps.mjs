#!/usr/bin/env node
// Pre-flight for artifact dev/build commands.
//
// Two failure modes are handled here, both observed in the Replit workspace:
//
// 1. node_modules is empty (the platform's install step failed) →
//    `sh: 1: vite: not found` / `Cannot find package 'esbuild'`, with nobody
//    around to run `pnpm install` because the workspace has no terminal.
//    So the artifact command installs what it needs before it starts.
//
// 2. Replit launches the artifacts' workflows at the same time. Three parallel
//    `pnpm install` on one node_modules is never safe — pnpm renames packages
//    into place and dies with
//      ERR_PNPM_ENOTEMPTY: directory not empty, rename '...yaml_tmp_447' -> '...yaml'
//    leaving a half-built tree behind. So installs are serialised with a lock
//    directory; whoever loses the race waits and then re-checks instead of
//    installing again.
//
// Usage: node ../../scripts/ensure-deps.mjs <bin> [<bin> ...]

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cwd = process.cwd();

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const binDirs = [
  path.join(cwd, "node_modules", ".bin"),
  path.join(repoRoot, "node_modules", ".bin"),
];

const log = (msg) => console.error(`[ensure-deps] ${msg}`);

const missingBins = () =>
  wanted.filter((bin) => !binDirs.some((dir) => existsSync(path.join(dir, bin))));

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (missingBins().length === 0) process.exit(0);

log(`missing tool(s): ${missingBins().join(", ")} — dependencies are not installed`);
log(`workspace: ${repoRoot}`);

// Lives outside node_modules on purpose: a purging install deletes that whole
// directory, which would take the lock with it.
const lockDir = path.join(repoRoot, ".cache", "ensure-deps.lock");
const LOCK_STALE_MS = 15 * 60 * 1000;
const WAIT_STEP_MS = 2000;
const WAIT_MAX_MS = 20 * 60 * 1000;

function acquireLock() {
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(path.dirname(lockDir), { recursive: true });
      mkdirSync(lockDir);
      writeFileSync(path.join(lockDir, "owner"), `${process.pid} ${new Date().toISOString()}`);
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // A crashed install must not block the workspace forever.
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          log("removing stale install lock");
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between checks — retry immediately
      }
      if (Date.now() - started > WAIT_MAX_MS) {
        log("timed out waiting for another install to finish");
        return false;
      }
      let owner = "";
      try {
        owner = readFileSync(path.join(lockDir, "owner"), "utf8").trim();
      } catch {
        /* owner file may not exist yet */
      }
      log(`another install is running (${owner || "unknown"}) — waiting`);
      sleep(WAIT_STEP_MS);
    }
  }
}

function releaseLock() {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const env = {
  ...process.env,
  CI: process.env.CI ?? "true",
  npm_config_confirm_modules_purge: "false",
  // The Replit package firewall is a caching proxy: a cold tarball needs a
  // couple of retries before it settles, and a single 403 is not fatal.
  npm_config_fetch_retries: process.env.npm_config_fetch_retries ?? "5",
  npm_config_fetch_retry_mintimeout: "2000",
};

function runInstall(args) {
  log(`pnpm install ${args.join(" ")}`);
  return spawnSync("pnpm", ["install", "--reporter=append-only", ...args], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
}

// NOTE: never call process.exit() between acquireLock() and releaseLock() —
// process.exit() does not unwind the stack, so `finally` never runs and the lock
// file would survive the process, blocking every later workflow run.
if (!acquireLock()) process.exit(1);

let exitCode = 0;
try {
  exitCode = installIfNeeded();
} finally {
  releaseLock();
}

process.exit(exitCode);

function installIfNeeded() {
  // Someone else may have finished the install while we waited.
  if (missingBins().length === 0) {
    log("dependencies appeared while waiting — continuing");
    return 0;
  }

  const version = spawnSync("pnpm", ["--version"], { encoding: "utf8", env });
  log(`pnpm ${String(version.stdout || "").trim() || "unknown"}`);

  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
    ok = runInstall(["--frozen-lockfile", "--prefer-offline"]).status === 0;
    if (!ok) {
      log(`frozen install failed (attempt ${attempt}/3) — refreshing the lockfile`);
      ok = runInstall(["--no-frozen-lockfile", "--prefer-offline"]).status === 0;
    }
    if (!ok && attempt < 3) {
      const backoff = attempt * 5000;
      log(`retrying in ${backoff}ms`);
      sleep(backoff);
    }
  }

  if (!ok) {
    log("install failed after retries — the registry error above is the real cause");
    return 1;
  }

  const stillMissing = missingBins();
  if (stillMissing.length > 0) {
    log(`still missing after install: ${stillMissing.join(", ")}`);
    return 1;
  }

  log("dependencies installed, continuing");
  return 0;
}
