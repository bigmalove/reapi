#!/usr/bin/env node
// Pre-flight for artifact dev/build commands.
//
// Why this exists (all three observed in the Replit workspace):
//
// 1. `node_modules` empty → `sh: 1: vite: not found` / `Cannot find package
//    'esbuild'`, and nobody has a terminal to run `pnpm install`.
// 2. Several workflows start at once → parallel `pnpm install` on one
//    node_modules → `ERR_PNPM_ENOTEMPTY … rename '…_tmp_447' -> '…'`.
// 3. The Replit package firewall answers
//      ERR_PNPM_FETCH_403 … /npm/<pkg>/-/<pkg>-x.y.z.tgz
//      No authorization header was set for the request.
//    for any tarball it has not cached — pnpm started from a workflow carries no
//    firewall credentials. Cache hits install fine, a single miss kills the run.
//    So: serialise, retry against the public registry when the firewall refuses,
//    and remember a hard failure instead of hammering the firewall on every
//    restart.
//
// Usage: node ../../scripts/ensure-deps.mjs <bin> [<bin> ...]

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const missingBins = () =>
  wanted.filter((bin) => !binDirs.some((dir) => existsSync(path.join(dir, bin))));

if (missingBins().length === 0) process.exit(0);

log(`missing tool(s): ${missingBins().join(", ")} — dependencies are not installed`);
log(`workspace: ${repoRoot}`);

// Lives outside node_modules: a purging install deletes that whole directory.
const cacheDir = path.join(repoRoot, ".cache");
const lockDir = path.join(cacheDir, "ensure-deps.lock");
const memoFile = path.join(cacheDir, "install-failure.json");

const LOCK_STALE_MS = 15 * 60 * 1000;
const WAIT_STEP_MS = 2000;
const WAIT_MAX_MS = 20 * 60 * 1000;
const MEMO_TTL_MS = 15 * 60 * 1000;

function acquireLock() {
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      mkdirSync(lockDir);
      writeFileSync(path.join(lockDir, "owner"), `${process.pid} ${new Date().toISOString()}`);
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          log("removing stale install lock");
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
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

const releaseLock = () => {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};

const env = {
  ...process.env,
  CI: process.env.CI ?? "true",
  npm_config_confirm_modules_purge: "false",
  npm_config_fetch_retries: process.env.npm_config_fetch_retries ?? "3",
  npm_config_fetch_retry_mintimeout: "2000",
};

const FALLBACK_REGISTRY =
  process.env.ENSURE_DEPS_FALLBACK_REGISTRY ?? "https://registry.npmjs.org/";

function runInstall(args) {
  log(`pnpm install ${args.join(" ")}`);
  const res = spawnSync("pnpm", ["install", "--reporter=append-only", ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const status = res.status ?? 1;
  if (status === 0) {
    log("install ok");
  } else {
    const lines = out.trimEnd().split("\n");
    console.error(lines.slice(-25).join("\n"));
  }
  return { status, out };
}

function diagnose() {
  const userconfig = spawnSync("pnpm", ["config", "get", "userconfig"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  const registry = spawnSync("pnpm", ["config", "get", "registry"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  const home = process.env.HOME ?? "(unset)";
  log(`diagnostics: registry=${String(registry.stdout || "").trim() || "?"}`);
  log(`diagnostics: userconfig=${String(userconfig.stdout || "").trim() || "?"}`);
  log(`diagnostics: NPM_CONFIG_USERCONFIG=${process.env.NPM_CONFIG_USERCONFIG ?? "(unset)"}`);
  for (const candidate of [".npmrc", `${home}/.npmrc`, `${home}/.config/npmrc`]) {
    log(`diagnostics: ${candidate} ${existsSync(candidate) ? "exists" : "missing"}`);
  }
}

function readMemo() {
  try {
    const memo = JSON.parse(readFileSync(memoFile, "utf8"));
    if (Date.now() - Date.parse(memo.at) < MEMO_TTL_MS) return memo;
  } catch {
    /* no memo */
  }
  return null;
}

const writeMemo = (message) => {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(memoFile, JSON.stringify({ at: new Date().toISOString(), message }));
  } catch {
    /* best effort */
  }
};

const clearMemo = () => {
  try {
    rmSync(memoFile, { force: true });
  } catch {
    /* best effort */
  }
};

// NOTE: never call process.exit() between acquireLock() and releaseLock() —
// process.exit() does not unwind the stack, so `finally` would not run and the
// lock would outlive the process, blocking every later workflow run.
if (!acquireLock()) process.exit(1);

let exitCode = 0;
try {
  exitCode = installIfNeeded();
} finally {
  releaseLock();
}

process.exit(exitCode);

function installIfNeeded() {
  // Someone else may have completed the install while we waited.
  if (missingBins().length === 0) {
    log("dependencies appeared while waiting — continuing");
    return 0;
  }

  const memo = readMemo();
  if (memo) {
    log(`a recent install failed (${memo.at}); not retrying yet`);
    log(memo.message);
    log("delete .cache/install-failure.json to force another attempt");
    return 1;
  }

  const version = spawnSync("pnpm", ["--version"], { encoding: "utf8", env });
  log(`pnpm ${String(version.stdout || "").trim() || "unknown"}`);

  let result = runInstall(["--frozen-lockfile", "--prefer-offline"]);

  if (result.status !== 0 && result.out.includes("ERR_PNPM_FETCH_403")) {
    log(`package firewall refused a tarball — retrying against ${FALLBACK_REGISTRY}`);
    result = runInstall(["--frozen-lockfile", `--registry=${FALLBACK_REGISTRY}`]);
  }

  if (result.status !== 0) {
    log("frozen install failed — refreshing the lockfile");
    result = runInstall(["--no-frozen-lockfile", "--prefer-offline"]);
  }

  if (result.status !== 0) {
    diagnose();
    const reason = (result.out.match(/ERR_PNPM_[A-Z_]+.*$/m) ?? ["install failed"])[0];
    writeMemo(reason);
    log("install failed — the registry error above is the real cause");
    return 1;
  }

  const stillMissing = missingBins();
  if (stillMissing.length > 0) {
    log(`still missing after install: ${stillMissing.join(", ")}`);
    writeMemo(`install finished but ${stillMissing.join(", ")} still missing`);
    return 1;
  }

  clearMemo();
  log("dependencies installed, continuing");
  return 0;
}
