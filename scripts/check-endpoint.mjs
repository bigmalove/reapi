#!/usr/bin/env node
/**
 * Classify a gateway / pool-node endpoint in one shot.
 *
 * The failure this exists for: a run fails with a wall of Replit HTML
 * ("This app isn't live yet") and it is impossible to tell from the client
 * whether
 *   - the gateway deployment itself is not live (Replit edge answered, the
 *     gateway process never ran, so the pool's disable logic never ran either),
 *     or
 *   - a pool node was down and the gateway relayed it (a bug: the gateway is
 *     supposed to collapse that to a one-line JSON 502 — see
 *     summarizeUpstreamError in artifacts/api-server/src/lib/upstreamError.ts).
 *
 * Usage:
 *   node scripts/check-endpoint.mjs                     # checks REAPI_DISCOVERY_URL.json
 *   node scripts/check-endpoint.mjs <url> [<url> ...]   # classify each URL
 *   node scripts/check-endpoint.mjs --write --url U     # rewrite the discovery file
 *
 * Exit codes: 0 at least one live endpoint, 1 none reachable, 2 usage error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DISCOVERY = path.join(ROOT, "REAPI_DISCOVERY_URL.json");
const TIMEOUT_MS = 12_000;

// Same shape test as looksLikeHtmlDocument() in the server bundle: leading
// markup means the platform edge answered instead of the app.
function firstHtmlAt(text) {
  return text.search(/<!doctype html|<html[\s>]/i);
}

function classify(status, contentType, body) {
  const at = firstHtmlAt(body);
  if (at >= 0) {
    if (body.includes("replit.com/site/hosting") || body.includes("isn&#39;t live yet") || body.includes("isn't live yet")) {
      return "edge-placeholder: Replit App is not published/live (404 HTML) — the gateway process never ran";
    }
    if (body.includes("Run this app to see the results here")) {
      return "edge-placeholder: Replit dev workspace is not running";
    }
    return "html-body: platform edge answered instead of the app";
  }
  if (status === 0) return "unreachable";
  if (status >= 200 && status < 300) return contentType.includes("json") ? "live" : `live (non-json: ${contentType || "?"})`;
  return `http ${status} (${contentType || "?"})`;
}

function isLive(verdict) {
  return verdict === "live" || verdict.startsWith("live (");
}

async function probe(url) {
  const target = `${url.replace(/\/+$/, "")}/healthz`;
  try {
    const res = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text().catch(() => "");
    const ct = res.headers.get("content-type") ?? "";
    const verdict = classify(res.status, ct, body);
    return { url, target, status: res.status, contentType: ct, bytes: body.length, verdict };
  } catch (err) {
    const name = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "unreachable";
    return { url, target, status: 0, contentType: "", bytes: 0, verdict: `${name}: ${err?.message ?? err}` };
  }
}

function readDiscovery() {
  try {
    const raw = JSON.parse(readFileSync(DISCOVERY, "utf8"));
    return typeof raw.reapiBaseUrl === "string" ? raw.reapiBaseUrl : null;
  } catch {
    return null;
  }
}

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const urls = argv.filter((a) => !a.startsWith("--"));

const targets = urls.length > 0 ? urls : [readDiscovery()].filter(Boolean);
if (targets.length === 0) {
  console.error("no URL to check (REAPI_DISCOVERY_URL.json has no reapiBaseUrl)");
  process.exit(2);
}

const results = await Promise.all(targets.map(probe));
for (const r of results) {
  console.log(`${isLive(r.verdict) ? "OK  " : "DEAD"}  ${r.url}`);
  console.log(`      ${r.target} -> ${r.status} ${r.contentType} ${r.bytes}B`);
  console.log(`      ${r.verdict}`);
}

const live = results.find((r) => isLive(r.verdict));
if (write) {
  if (!live) {
    console.error("\n--write requested but no live endpoint was found; discovery file left untouched");
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(DISCOVERY, "utf8"));
  raw.reapiBaseUrl = live.url.endsWith("/") ? live.url : `${live.url}/`;
  writeFileSync(DISCOVERY, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(ROOT, DISCOVERY)}: reapiBaseUrl=${raw.reapiBaseUrl}`);
}

process.exit(live ? 0 : 1);
