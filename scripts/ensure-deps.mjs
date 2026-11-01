#!/usr/bin/env node
// Pre-flight for artifact dev/build commands.
//
// The Replit workflows run `pnpm --filter <pkg> run dev` in a container that is
// supposed to have node_modules already. When the platform's install step failed
// (see pnpm-workspace.yaml: allowBuilds / confirmModulesPurge), that command is
// the thing that shows the damage:
//   sh: 1: vite: not found
//   Cannot find package 'esbuild'
// and nobody has a terminal to fix it. So the artifact command heals itself
// first: if the tool it is about to use is missing, install the workspace, then
// continue with the original command.
//
// Usage: node ../../scripts/ensure-deps.mjs <bin> [<bin> ...]

import { existsSync } from "node:fs";
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

const missing = wanted.filter(
  (bin) => !binDirs.some((dir) => existsSync(path.join(dir, bin))),
);

if (missing.length === 0) process.exit(0);

const log = (msg) => console.error(`[ensure-deps] ${msg}`);

log(`missing tool(s): ${missing.join(", ")} — dependencies are not installed`);
log(`workspace: ${repoRoot}`);

// Same two guards bootstrap.sh uses, but without needing a shell: no TTY means
// pnpm must be told it is allowed to purge, and dependency build scripts
// (esbuild) must be pre-approved in pnpm-workspace.yaml.
const env = {
  ...process.env,
  CI: process.env.CI ?? "true",
  npm_config_confirm_modules_purge: "false",
};

function install(args) {
  log(`pnpm install ${args.join(" ")}`);
  return spawnSync("pnpm", ["install", ...args], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
}

let result = spawnSync("pnpm", ["--version"], { encoding: "utf8", env });
log(`pnpm ${String(result.stdout || "").trim() || "unknown"}`);

result = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
  cwd: repoRoot,
  env,
  stdio: "inherit",
});

if (result.status !== 0) {
  log("frozen install failed — retrying with a lockfile refresh");
  const retry = spawnSync(
    "pnpm",
    ["install", "--no-frozen-lockfile", "--prefer-offline"],
    { cwd: repoRoot, env, stdio: "inherit" },
  );
  if (retry.status !== 0) {
    log("install failed — the registry error above is the real cause");
    process.exit(retry.status ?? 1);
  }
}

const stillMissing = wanted.filter(
  (bin) => !binDirs.some((dir) => existsSync(path.join(dir, bin))),
);

if (stillMissing.length > 0) {
  log(`still missing after install: ${stillMissing.join(", ")}`);
  process.exit(1);
}

log("dependencies installed, continuing");
process.exit(0);
