import { readJsonAsync, writeJson } from "./persist.js";
import { logger } from "./logger.js";

export type ProviderName = "openai" | "anthropic" | "gemini" | "openrouter";

export interface ProviderOverride {
  url: string;
  apiKey: string;
}

export type ProviderOverrides = Record<ProviderName, ProviderOverride>;

export type ReverseProxyMode = "round-robin" | "sticky";

/**
 * Operator-defined aliases for the Claude Code entry point: the model id a
 * client sends (`claude-haiku-5-5`, or a retired snapshot) → the gateway model
 * that should serve it. Checked before the automatic registry resolution, so an
 * operator can pin a family, point an id at any provider, or work around a
 * disabled model without touching the client.
 */
export type ClaudeCodeModelMap = Record<string, string>;

export const MAX_CLAUDE_CODE_MODEL_MAP = 200;

export interface PoolEntry {
  url: string;
  apiKey: string;
  /**
   * Owning account (usually the Replit login email for a dev node). Optional:
   * plain deployments are registered by URL only, and older state has no
   * account. Used to attribute usage buckets and blocked entries to a
   * human-readable account instead of an opaque node URL.
   */
  account?: string;
}

export type UpstreamNodeType = "replit-app" | "replit-dev";

export type DisabledReason = "requires-wakeup" | "upstream-node-unavailable";

/**
 * `upstreamReason` for a node disabled because Replit served its hosting
 * placeholder page instead of the node app. Unlike every other disable reason,
 * this one means no node process was running at all — so the node cannot
 * self-register while disabled, and an incoming registration is proof that the
 * deployment is live again.
 */
export const REPLIT_HOSTING_SHUTDOWN = "replit-hosting-shutdown";

/**
 * `upstreamReason` for a node disabled by the manual status check because it
 * did not answer at all (timeout, connection error, or a Replit edge 5xx).
 * Like REPLIT_HOSTING_SHUTDOWN, an offline node cannot self-register, so an
 * incoming registration means it is back online.
 */
export const NODE_PROBE_OFFLINE = "probe-offline";

/**
 * How long a node stays disabled after its free-tier monthly spend limit is
 * exceeded. The quota is monthly, so the node is automatically restored to the
 * pool once this window has passed (see `restoreExpiredDisabledNodes`).
 */
export const FREE_TIER_RECOVERY_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * `upstreamReason` for a node disabled after it answered HTTP 500 with nothing
 * but an empty body — observed when the deployment's Replit AI Integration
 * cannot mint a credential (`metasidecar: failed to get modelfarm app
 * credential`). The node process is alive and `/api/setup-status` still reports
 * every provider `configured: true`, so nothing else catches it.
 *
 * Unlike the free-tier quota, this condition does NOT clear on its own: it
 * persists until the deployment is republished. Nodes are therefore disabled
 * WITHOUT a `recoverAt`, so re-registration (every node posts a heartbeat every
 * 5 hours) can never quietly put a still-broken node back into the pool. It
 * returns only through an authenticated action: the portal's "重新启用", or
 * "检测并恢复" which sends a real 1-token call to every disabled node and
 * restores the ones that answer.
 *
 * A time-boxed disable would not work here. With a 6-hour window and a 5-hour
 * heartbeat the node is re-added within 10 hours, fails immediately, and gets
 * disabled again — a permanent churn of failing requests, because the
 * underlying fault never went away.
 */
export const NODE_SERVER_ERROR = "server-error";

/** `upstreamReason` values that denote an exhausted free-tier budget. */
const BUDGET_REASON_RE = /FREE_TIER|budget|spend/i;

export interface DisabledUpstreamNode {
  url: string;
  type: UpstreamNodeType;
  disabledReason: DisabledReason;
  provider?: string;
  upstreamReason?: string;
  upstreamStatus?: number;
  disabledAt?: string;
  lastError?: string;
  /** Owning account (login email) when known — see `PoolEntry.account`. */
  account?: string;
  /**
   * Verbatim (truncated) upstream response that triggered the disable.
   * `lastError` is frequently a normalised sentence, which makes a real
   * `FREE_TIER_BUDGET_EXCEEDED` indistinguishable from a rate limit that a pool
   * node folded into the same envelope. Keeping the raw text is what lets the
   * portal — and the next person debugging this — tell the two apart after the
   * fact instead of trusting a summary.
   */
  rawUpstreamBody?: string;
  /**
   * True when the quota verdict came from a generic envelope (`status: 429` /
   * `reason: quota-exhausted`) rather than wording that names a spend limit.
   * The usage report uses it to separate a spent account from a transient rate
   * limit, so a healthy node is not reported as a quota casualty.
   */
  quotaSignalUnverified?: boolean;
  /**
   * ISO timestamp after which the node is automatically restored to the pool.
   * Absent means the disable is permanent until re-enabled manually (or, for
   * REPLIT_HOSTING_SHUTDOWN, until the node re-registers).
   */
  recoverAt?: string;
}

/**
 * OpenRouter routing variants. These are the only two reserved model-id
 * suffixes OpenRouter documents; an arbitrary `:<provider>` suffix is not a
 * routing instruction at all — it becomes part of the id and matches nothing,
 * so the request silently falls back to default routing.
 *
 * Each suffix is a superset of the corresponding `provider.sort` value: it
 * sorts candidates AND makes an extra service tier ELIGIBLE. Neither suffix
 * pins a provider or a tier — the tier endpoint has to win the sort like any
 * other endpoint, so "nitro" does not mean "always the priority endpoint".
 * Verified against live traffic: `:nitro` on a DeepSeek flash model landed on
 * the fastest default-tier endpoint 4/4 times and never on the priority one. So
 * the suffix is a heuristic preference, and the platform must not describe it
 * as a pin.
 *
 *  - `floor` → sort by price, plus `flex` tier eligible (idle capacity,
 *    cheapest, preempted on demand). Preemption surfaces as a 429.
 *  - `nitro` → sort by throughput, plus `priority` tier eligible (dedicated
 *    capacity, dearer; charged only when a priority endpoint actually serves
 *    the request).
 */
export type OpenRouterRoutingTier = "auto" | "floor" | "nitro";

/** Suffix appended to the outgoing model id, empty for `auto`. */
export const OPENROUTER_ROUTING_SUFFIXES: Record<OpenRouterRoutingTier, string> = {
  auto: "",
  floor: ":floor",
  nitro: ":nitro",
};

/**
 * Model ids that already carry a variant suffix, or that cannot take one.
 * `:free` is a free-tier model variant, not a routing variant — appending
 * another suffix would produce an id no upstream recognises.
 */
export function hasModelVariantSuffix(model: string): boolean {
  return /:(?:floor|nitro|online|free|extended)$/i.test(model);
}

export function parseOpenRouterRoutingTier(raw: unknown): OpenRouterRoutingTier {
  return raw === "floor" || raw === "nitro" ? raw : "auto";
}

export interface ServerSettings {
  sillyTavernMode: boolean;
  /**
   * Map of client-facing model ids → gateway model ids for `/v1/messages`
   * (the Claude Code entry point). See `ClaudeCodeModelMap`.
   */
  claudeCodeModelMap: ClaudeCodeModelMap;
  /**
   * Synthetic stream shim for Antigravity-Gateway wrapped requests
   * (`agw_emit_*` synthetic transport tool): re-encode the streamed answer
   * into incremental tool_call argument deltas instead of forwarding the
   * upstream's buffered single-chunk tool call.
   *
   * Overridable at request time — precedence: `x-agw-stream-shim` header
   * (on/off) > `SYNTHETIC_STREAM_SHIM` env (on/off) > this setting (default on).
   */
  syntheticStreamShim: boolean;
  /**
   * Which OpenRouter routing variant to append to the outgoing model id.
   *
   * `auto` sends the id untouched and lets OpenRouter load-balance across every
   * upstream that serves the model. `floor` / `nitro` append the reserved
   * suffixes, which do two things at once: sort the candidates (by price or by
   * throughput) *and* make an extra service tier eligible — `flex` (cheap,
   * preemptible) for `:floor`, `priority` for `:nitro`. Eligibility is not
   * selection: the tier endpoint competes on the same sort and only serves the
   * request when it wins, so neither suffix pins a provider or a tier. See
   * `OPENROUTER_ROUTING_SUFFIXES`.
   *
   * Only applies to the openrouter provider. Scope is deliberately global
   * rather than per-model: the trade-off is a single knob an operator flips
   * when the default routing starts returning 429 storms, and a per-model table
   * would be another thing to keep in sync with the catalog.
   */
  openRouterRoutingTier: OpenRouterRoutingTier;
  reverseProxyEnabled: boolean;
  reverseProxyMode: ReverseProxyMode;
  reverseProxyPool: PoolEntry[];
  disabledUpstreamNodes: DisabledUpstreamNode[];
  providerOverrides: ProviderOverrides;
}

const EMPTY_OVERRIDE: ProviderOverride = { url: "", apiKey: "" };

const EMPTY_OVERRIDES: ProviderOverrides = {
  openai: { ...EMPTY_OVERRIDE },
  anthropic: { ...EMPTY_OVERRIDE },
  gemini: { ...EMPTY_OVERRIDE },
  openrouter: { ...EMPTY_OVERRIDE },
};

const DEFAULTS: ServerSettings = {
  sillyTavernMode: false,
  claudeCodeModelMap: {},
  syntheticStreamShim: true,
  openRouterRoutingTier: "auto",
  reverseProxyEnabled: false,
  reverseProxyMode: "sticky",
  reverseProxyPool: [],
  disabledUpstreamNodes: [],
  providerOverrides: EMPTY_OVERRIDES,
};

let _settings: ServerSettings | null = null;

function normalizeOverrides(raw: unknown): ProviderOverrides {
  const out: ProviderOverrides = {
    openai: { ...EMPTY_OVERRIDE },
    anthropic: { ...EMPTY_OVERRIDE },
    gemini: { ...EMPTY_OVERRIDE },
    openrouter: { ...EMPTY_OVERRIDE },
  };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const p of ["openai", "anthropic", "gemini", "openrouter"] as const) {
    const v = r[p];
    if (v && typeof v === "object") {
      const vo = v as Record<string, unknown>;
      out[p] = {
        url: typeof vo["url"] === "string" ? vo["url"] : "",
        apiKey: typeof vo["apiKey"] === "string" ? vo["apiKey"] : "",
      };
    }
  }
  return out;
}

function normalizePool(raw: unknown): PoolEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PoolEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    const url = typeof v["url"] === "string" ? v["url"].trim().replace(/\/+$/, "") : "";
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      apiKey: typeof v["apiKey"] === "string" ? v["apiKey"] : "",
      ...(typeof v["account"] === "string" && v["account"].trim()
        ? { account: v["account"].trim() }
        : {}),
    });
  }
  return out;
}

function normalizeMode(raw: unknown): ReverseProxyMode {
  return raw === "round-robin" ? "round-robin" : "sticky";
}

/**
 * Coerce a persisted / client-supplied model map. Keys and values are trimmed,
 * empty and over-long entries are dropped, and the entry count is capped so a
 * bad client cannot blow up the settings row.
 */
export function normalizeClaudeCodeModelMap(raw: unknown): ClaudeCodeModelMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ClaudeCodeModelMap = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_CLAUDE_CODE_MODEL_MAP) break;
    if (typeof rawValue !== "string") continue;
    const key = rawKey.trim().slice(0, 200);
    const value = rawValue.trim().slice(0, 200);
    if (!key || !value) continue;
    out[key] = value;
    count++;
  }
  return out;
}

function normalizeDisabledNodes(raw: unknown): DisabledUpstreamNode[] {
  if (!Array.isArray(raw)) return [];
  const out: DisabledUpstreamNode[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    const url = typeof v["url"] === "string" ? v["url"].trim().replace(/\/+$/, "") : "";
    const type = v["type"];
    if (!url || (type !== "replit-app" && type !== "replit-dev")) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const reason = v["disabledReason"];
    const disabledReason: DisabledReason =
      reason === "upstream-node-unavailable" ? "upstream-node-unavailable" : "requires-wakeup";
    const entry: DisabledUpstreamNode = { url, type, disabledReason };
    if (typeof v["account"] === "string" && v["account"].trim()) entry.account = v["account"].trim();
    if (typeof v["provider"] === "string") entry.provider = v["provider"];
    if (typeof v["upstreamReason"] === "string") entry.upstreamReason = v["upstreamReason"];
    if (typeof v["upstreamStatus"] === "number") entry.upstreamStatus = v["upstreamStatus"];
    if (typeof v["disabledAt"] === "string") entry.disabledAt = v["disabledAt"];
    if (typeof v["lastError"] === "string") entry.lastError = v["lastError"];
    if (typeof v["rawUpstreamBody"] === "string") {
      entry.rawUpstreamBody = v["rawUpstreamBody"].slice(0, 1000);
    }
    if (v["quotaSignalUnverified"] === true) entry.quotaSignalUnverified = true;
    if (typeof v["recoverAt"] === "string") entry.recoverAt = v["recoverAt"];
    // Migration: budget-exceeded nodes persisted before `recoverAt` existed were
    // disabled permanently. Backfill the recovery time from `disabledAt` so they
    // still come back once the monthly quota resets.
    if (
      entry.recoverAt === undefined &&
      entry.disabledAt !== undefined &&
      entry.upstreamReason !== undefined &&
      BUDGET_REASON_RE.test(entry.upstreamReason)
    ) {
      const disabledMs = Date.parse(entry.disabledAt);
      if (!Number.isNaN(disabledMs)) {
        entry.recoverAt = new Date(disabledMs + FREE_TIER_RECOVERY_MS).toISOString();
      }
    }
    out.push(entry);
  }
  return out;
}

/** `.replit.dev` workspace URLs — temporary nodes that sleep when idle. */
export function isDevNodeUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith(".replit.dev");
  } catch {
    return false;
  }
}

/**
 * Dev nodes are never served from: move any `.replit.dev` URL out of the pool
 * into disabledUpstreamNodes (as requires-wakeup, unless already listed).
 * Status checks skip them as well.
 */
function divertDevNodes(
  pool: PoolEntry[],
  disabled: DisabledUpstreamNode[],
): { pool: PoolEntry[]; disabled: DisabledUpstreamNode[] } {
  const dev = pool.filter((e) => isDevNodeUrl(e.url));
  if (dev.length === 0) return { pool, disabled };
  const listed = new Set(disabled.map((e) => e.url));
  const added: DisabledUpstreamNode[] = dev
    .filter((e) => !listed.has(e.url))
    .map((e) => ({
      url: e.url,
      type: "replit-dev",
      disabledReason: "requires-wakeup",
      disabledAt: new Date().toISOString(),
    }));
  return { pool: pool.filter((e) => !isDevNodeUrl(e.url)), disabled: [...disabled, ...added] };
}

export async function initSettings(): Promise<void> {
  const loaded = await readJsonAsync<Record<string, unknown>>("server_settings.json", {});
  let pool = normalizePool(loaded["reverseProxyPool"]);
  const legacyKey = typeof loaded["reverseProxyApiKey"] === "string" ? (loaded["reverseProxyApiKey"] as string) : "";
  if (pool.length === 0 && typeof loaded["reverseProxyUrl"] === "string") {
    const legacyUrl = (loaded["reverseProxyUrl"] as string).trim().replace(/\/+$/, "");
    if (legacyUrl) {
      pool = [{ url: legacyUrl, apiKey: legacyKey }];
    }
  }
  if (pool.length === 0 && legacyKey) {
    const overridesRaw = loaded["providerOverrides"];
    if (overridesRaw && typeof overridesRaw === "object") {
      const o = overridesRaw as Record<string, unknown>;
      for (const p of ["openai", "anthropic", "gemini", "openrouter"] as const) {
        const entry = o[p] as { url?: string; apiKey?: string } | undefined;
        if (entry && typeof entry.url === "string" && entry.url && (!entry.apiKey || entry.apiKey === "")) {
          entry.apiKey = legacyKey;
        }
      }
    }
  }
  _settings = {
    ...DEFAULTS,
    sillyTavernMode: typeof loaded["sillyTavernMode"] === "boolean" ? loaded["sillyTavernMode"] : DEFAULTS.sillyTavernMode,
    claudeCodeModelMap: normalizeClaudeCodeModelMap(loaded["claudeCodeModelMap"]),
    syntheticStreamShim:
      typeof loaded["syntheticStreamShim"] === "boolean"
        ? loaded["syntheticStreamShim"]
        : DEFAULTS.syntheticStreamShim,
    openRouterRoutingTier: parseOpenRouterRoutingTier(loaded["openRouterRoutingTier"]),
    reverseProxyEnabled: typeof loaded["reverseProxyEnabled"] === "boolean" ? loaded["reverseProxyEnabled"] : DEFAULTS.reverseProxyEnabled,
    reverseProxyMode: normalizeMode(loaded["reverseProxyMode"]),
    reverseProxyPool: pool,
    disabledUpstreamNodes: normalizeDisabledNodes(loaded["disabledUpstreamNodes"]),
    providerOverrides: normalizeOverrides(loaded["providerOverrides"]),
  };
  const diverted = divertDevNodes(_settings.reverseProxyPool, _settings.disabledUpstreamNodes);
  _settings.reverseProxyPool = diverted.pool;
  _settings.disabledUpstreamNodes = diverted.disabled;
}

export function getSettings(): ServerSettings {
  if (_settings === null) {
    _settings = { ...DEFAULTS };
  }
  return _settings;
}

/**
 * Disable an upstream node. Removes it from the pool, records it in
 * disabledUpstreamNodes, and disables the proxy entirely if the pool empties.
 * Does NOT touch reverseProxyMode or providerOverrides.
 */
export function disableUpstreamNode(args: {
  url: string;
  disabledReason: DisabledReason;
  account?: string;
  provider?: string;
  upstreamReason?: string;
  upstreamStatus?: number;
  lastError?: string;
  /** Verbatim upstream response, truncated. See `DisabledUpstreamNode`. */
  rawUpstreamBody?: string;
  /** Quota verdict came from an inferred signal, not explicit wording. */
  quotaSignalUnverified?: boolean;
  /** When set, the node is automatically restored after this many ms. */
  recoverAfterMs?: number;
  /**
   * Absolute recovery time (ISO). Takes precedence over `recoverAfterMs`.
   *
   * The gateway cannot always derive the real reset on its own: the quota
   * snapshot that carries the refill date belongs to the upstream account
   * console. Without this the panel showed `disabledAt + 31d` while the real
   * window ended weeks earlier, so one row displayed two dates far apart.
   */
  recoverAt?: string;
}): void {
  const settings = getSettings();
  const url = args.url.trim().replace(/\/+$/, "");

  const type: UpstreamNodeType = isDevNodeUrl(url) ? "replit-dev" : "replit-app";

  // Remove from active pool
  const removed = settings.reverseProxyPool.find((e) => e.url === url);
  const newPool = settings.reverseProxyPool.filter((e) => e.url !== url);

  // Build disabled entry. The account survives the move out of the pool so the
  // blocked list (and the usage report) can name the account, not just a URL.
  const account =
    args.account?.trim() ||
    removed?.account?.trim() ||
    settings.disabledUpstreamNodes.find((e) => e.url === url)?.account?.trim() ||
    "";
  const entry: DisabledUpstreamNode = {
    url,
    type,
    disabledReason: args.disabledReason,
    disabledAt: new Date().toISOString(),
  };
  if (account) entry.account = account;
  if (args.provider !== undefined) entry.provider = args.provider;
  if (args.upstreamReason !== undefined) entry.upstreamReason = args.upstreamReason;
  if (args.upstreamStatus !== undefined) entry.upstreamStatus = args.upstreamStatus;
  if (args.lastError !== undefined) entry.lastError = args.lastError;
  if (args.rawUpstreamBody !== undefined) {
    entry.rawUpstreamBody = args.rawUpstreamBody.slice(0, 1000);
  }
  if (args.quotaSignalUnverified) entry.quotaSignalUnverified = true;
  if (args.recoverAt !== undefined) {
    // Absolute wins: an explicit date is a fact the caller measured, while
    // `recoverAfterMs` is a guess.
    const explicit = Date.parse(args.recoverAt);
    if (!Number.isNaN(explicit)) entry.recoverAt = new Date(explicit).toISOString();
  }
  if (entry.recoverAt === undefined && args.recoverAfterMs !== undefined) {
    entry.recoverAt = new Date(Date.now() + args.recoverAfterMs).toISOString();
  }

  // Replace or append in disabled list
  const newDisabled = settings.disabledUpstreamNodes.filter((e) => e.url !== url);
  newDisabled.push(entry);

  const patch: Partial<ServerSettings> = {
    reverseProxyPool: newPool,
    disabledUpstreamNodes: newDisabled,
  };

  // Deliberately keep `reverseProxyEnabled` on when the pool empties. Flipping
  // it off turned a routine drain (every node parked on a 429/quota signal) into
  // a state indistinguishable from "the operator never configured the proxy":
  // the next request fell through to the env fallback and failed with
  // `Provider "<p>" is not configured…`, which read as a configuration mistake
  // and masked the real upstream cause. Availability is derived instead:
  // `isReverseProxyActive()` is false while the pool is empty, and
  // `resolveProviderEndpoint()` raises `UpstreamUnavailableError` for the drain
  // window. Only the operator turns the mode itself off.

  updateSettings(patch);
}

/**
 * Restore every disabled node whose `recoverAt` has passed. Restored nodes are
 * appended to the pool with a blank apiKey (inheriting pool[0]'s key, as the
 * register / re-enable routes do) and the proxy is switched back on. Only
 * writes settings when something actually changed. Returns the restored URLs.
 */
export function restoreExpiredDisabledNodes(now: number = Date.now()): string[] {
  const due = getSettings().disabledUpstreamNodes.filter((entry) => {
    const recoverMs = entry.recoverAt !== undefined ? Date.parse(entry.recoverAt) : NaN;
    return entry.type === "replit-app" && !Number.isNaN(recoverMs) && recoverMs <= now;
  });
  if (due.length === 0) return [];

  const restored = due.map((e) => e.url);
  for (const url of restored) {
    logger.info({ nodeUrl: url }, "disabled upstream node reached its recovery time — restoring to pool");
  }
  restoreDisabledNodes(restored);
  return restored;
}

/**
 * Move the given nodes from disabledUpstreamNodes back into the pool (blank
 * apiKey, inheriting pool[0]'s key) and switch the proxy back on.
 */
export function restoreDisabledNodes(urls: string[]): void {
  if (urls.length === 0) return;
  const settings = getSettings();
  const restore = new Set(urls);
  const pool = [...settings.reverseProxyPool];
  for (const url of urls) {
    if (!pool.some((e) => e.url === url)) pool.push({ url, apiKey: "" });
  }
  updateSettings({
    reverseProxyPool: pool,
    disabledUpstreamNodes: settings.disabledUpstreamNodes.filter((e) => !restore.has(e.url)),
    reverseProxyEnabled: true,
  });
}

export function updateSettings(patch: Partial<ServerSettings>): ServerSettings {
  const current = getSettings();
  const next: ServerSettings = { ...current, ...patch };

  if (patch.reverseProxyPool) {
    // Pool is replaced atomically; preserve existing keys when an entry with
    // the same URL is resubmitted with a blank apiKey (the route layer also
    // applies null-vs-empty semantics before we get here).
    const seen = new Set<string>();
    const cleaned: PoolEntry[] = [];
    for (const e of patch.reverseProxyPool) {
      const url = (e.url ?? "").trim().replace(/\/+$/, "");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      cleaned.push({ url, apiKey: e.apiKey ?? "" });
    }
    const diverted = divertDevNodes(cleaned, next.disabledUpstreamNodes);
    next.reverseProxyPool = diverted.pool;
    next.disabledUpstreamNodes = diverted.disabled;
  }

  if (patch.providerOverrides) {
    const merged: ProviderOverrides = { ...current.providerOverrides };
    for (const p of ["openai", "anthropic", "gemini", "openrouter"] as const) {
      const incoming = patch.providerOverrides[p];
      if (incoming) {
        merged[p] = {
          url: (incoming.url ?? current.providerOverrides[p].url).trim().replace(/\/+$/, ""),
          apiKey: incoming.apiKey ?? current.providerOverrides[p].apiKey,
        };
      }
    }
    next.providerOverrides = merged;
  }

  if (patch.reverseProxyMode !== undefined) {
    next.reverseProxyMode = normalizeMode(patch.reverseProxyMode);
  }

  if (patch.claudeCodeModelMap !== undefined) {
    next.claudeCodeModelMap = normalizeClaudeCodeModelMap(patch.claudeCodeModelMap);
  }

  _settings = next;
  writeJson("server_settings.json", _settings);
  return _settings;
}
