#!/usr/bin/env node
// Fails when the committed deployment artifacts were not built from HEAD.
//
// Why: the deployment cannot run `pnpm install` / `pnpm build` (Replit's package
// firewall 403s any tarball it has not cached), so `artifacts/*/dist` is committed
// and shipped as-is. If someone edits src/ and forgets `pnpm run build`, the
// deployment keeps serving the previous bundle while `/api/build-info` reports the
// old commit — which looks exactly like "the fix did not deploy".
//
// The bundle embeds the commit it was built from (build.mjs → __BUILD_COMMIT__),
// so freshness is checkable without timestamps:
//   var BUILD_COMMIT = true ? "8ac6211" : "dev";
//
// Usage: node scripts/check-dist.mjs [--quiet]
//   exits 0  → artifacts match HEAD
//   exits 1  → stale or missing; run `pnpm run build` and commit artifacts/*/dist

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");
const say = (msg) => {
  if (!quiet) console.log(msg);
};

const git = (...args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

let head = "unknown";
try {
  head = git("rev-parse", "--short", "HEAD");
} catch {
  console.error("! not a git checkout — cannot verify build stamps");
  process.exit(0);
}

// Anything whose change invalidates the committed bundle.
const BUILD_INPUTS = [
  "artifacts/api-server/src",
  "artifacts/api-server/build.mjs",
  "artifacts/api-server/package.json",
  "artifacts/api-portal/src",
  "artifacts/api-portal/index.html",
  "artifacts/api-portal/vite.config.ts",
  "lib",
  // dependency changes always land in the lockfile, so the lockfile is the signal
  // (adding a script to package.json must not trip this check)
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
];

const bundlePath = "artifacts/api-server/dist/index.mjs";
const bundle = path.join(repoRoot, bundlePath);
const portalIndex = path.join(repoRoot, "artifacts/api-portal/dist/public/index.html");

const problems = [];

if (!existsSync(bundle)) {
  problems.push(`missing ${bundlePath} — commit it (pnpm run build produces it)`);
} else {
  const source = readFileSync(bundle, "utf8");
  const match = source.match(/var BUILD_COMMIT = [^?]*\?\s*"([^"]+)"/);
  const stamped = match?.[1] ?? "unknown";

  // The bundle records the commit it was built from, and dist is committed in the
  // *same* commit — so the stamp is always the parent of HEAD, never HEAD itself.
  // Freshness therefore means: the stamp is an ancestor of HEAD, and nothing that
  // affects the build changed between the stamp and HEAD.
  if (stamped === "dev" || stamped === "unknown") {
    problems.push(
      "api-server bundle carries no build stamp (built outside git) — " +
        "run `pnpm run build` and commit artifacts/api-server/dist",
    );
  } else {
    let ancestor = false;
    try {
      git("merge-base", "--is-ancestor", stamped, "HEAD");
      ancestor = true;
    } catch {
      ancestor = false;
    }

    if (!ancestor) {
      problems.push(
        `api-server bundle was built from ${stamped}, which is not an ancestor of HEAD (${head}) — ` +
          "run `pnpm run build` and commit artifacts/api-server/dist",
      );
    } else {
      const touched = git(
        "diff",
        "--name-only",
        stamped,
        "HEAD",
        "--",
        ...BUILD_INPUTS,
      );
      if (touched) {
        problems.push(
          `build inputs changed since ${stamped}:\n${touched
            .split("\n")
            .map((file) => `       ${file}`)
            .join("\n")}\n     — run \`pnpm run build\` and commit artifacts/*/dist`,
        );
      } else {
        say(`ok  api-server bundle stamped ${stamped}, no build inputs changed since`);
      }
    }
  }
}

if (!existsSync(portalIndex)) {
  problems.push("missing artifacts/api-portal/dist/public/index.html — commit it");
} else {
  const html = readFileSync(portalIndex, "utf8");
  const assets = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1]);
  const missing = assets.filter(
    (rel) => !existsSync(path.join(repoRoot, "artifacts/api-portal/dist/public", rel)),
  );
  if (missing.length > 0) {
    problems.push(`portal index.html references missing assets: ${missing.join(", ")}`);
  } else {
    say(`ok  api-portal bundle present (${assets.length} assets resolved)`);
  }
}

// Uncommitted source edits make any committed bundle suspect: the build stamp
// only proves "built from commit X", not "built from the tree you are about to
// commit". This is the most common way the deployment silently serves old code.
try {
  const dirty = [
    ...git("diff", "--name-only", "HEAD", "--", ...BUILD_INPUTS).split("\n"),
    ...git("ls-files", "--others", "--exclude-standard", "--", ...BUILD_INPUTS).split("\n"),
  ].filter(Boolean);
  if (dirty.length > 0) {
    problems.push(
      `uncommitted build inputs:\n${dirty
        .map((file) => `       ${file}`)
        .join("\n")}\n     — run \`pnpm run build\` and commit sources + artifacts/*/dist together`,
    );
  }
} catch {
  /* not a git checkout */
}

if (problems.length > 0) {
  console.error("\n!! deployment artifacts are stale or incomplete:\n");
  for (const problem of problems) console.error(`   - ${problem}`);
  console.error("\n   fix: pnpm run build && git add -f artifacts/api-server/dist artifacts/api-portal/dist\n");
  process.exit(1);
}

say("deployment artifacts match HEAD");
