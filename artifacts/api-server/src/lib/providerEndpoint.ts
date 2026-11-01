import { getSettings, updateSettings, restoreExpiredDisabledNodes, type ProviderName, type PoolEntry } from "./settings.js";
import { logger } from "./logger.js";

export type { ProviderName };

export type ProviderEndpointSource = "upstream" | "local-env" | "per-provider override";

export interface ProviderEndpoint {
  baseUrl: string;
  apiKey: string;
  source: ProviderEndpointSource;
  upstreamIndex?: number; // 0-based pool index when source === "upstream"
  poolSize?: number;
  nodeUrl?: string; // raw pool entry URL (no /modelfarm suffix), set when source === "upstream"
  /** Owning account for the selected pool entry (used by usage accounting). */
  account?: string;
}

/**
 * Reverse-proxy mode is on, but there is nothing to forward to right now: every
 * pool node is parked (rate-limit cooldown, quota window), no per-provider
 * override is set, and no local-env credentials exist.
 *
 * This is a *temporary availability* problem, not a configuration mistake. It
 * used to be reported as `Provider "<p>" is not configured…` because
 * `disableUpstreamNode` switched the proxy off when the last node left the
 * pool, which made a routine drain look like an operator error and hid the real
 * upstream cause (a 429 wrapped as `quota-exhausted`). Routes answer this with
 * 503 + `Retry-After` so clients back off instead of treating it as fatal.
 */
export class UpstreamUnavailableError extends Error {
  readonly provider: ProviderName;
  readonly parkedNodes: number;
  readonly retryAfterSeconds: number;

  constructor(provider: ProviderName, parkedNodes: number, retryAfterSeconds = 20) {
    super(
      `No upstream node is available for "${provider}": the reverse-proxy pool is empty ` +
        `(${parkedNodes} node(s) parked after upstream rate-limit/quota failures) and no ` +
        `provider override is set. The pool is refilled automatically — retry in about ` +
        `${retryAfterSeconds}s.`,
    );
    this.name = "UpstreamUnavailableError";
    this.provider = provider;
    this.parkedNodes = parkedNodes;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Narrow an unknown thrown value, tolerating a duplicated module instance. */
export function asUpstreamUnavailableError(err: unknown): UpstreamUnavailableError | null {
  if (err instanceof UpstreamUnavailableError) return err;
  if (
    err instanceof Error &&
    err.name === "UpstreamUnavailableError" &&
    typeof (err as Partial<UpstreamUnavailableError>).retryAfterSeconds === "number"
  ) {
    return err as UpstreamUnavailableError;
  }
  return null;
}

const ENV_BY_PROVIDER: Record<ProviderName, { baseUrl: string; apiKey: string }> = {
  openai:     { baseUrl: "AI_INTEGRATIONS_OPENAI_BASE_URL",     apiKey: "AI_INTEGRATIONS_OPENAI_API_KEY" },
  anthropic:  { baseUrl: "AI_INTEGRATIONS_ANTHROPIC_BASE_URL",  apiKey: "AI_INTEGRATIONS_ANTHROPIC_API_KEY" },
  gemini:     { baseUrl: "AI_INTEGRATIONS_GEMINI_BASE_URL",     apiKey: "AI_INTEGRATIONS_GEMINI_API_KEY" },
  openrouter: { baseUrl: "AI_INTEGRATIONS_OPENROUTER_BASE_URL", apiKey: "AI_INTEGRATIONS_OPENROUTER_API_KEY" },
};

// Upstream `/modelfarm/<segment>` segment per provider. Note `gemini` → `google`.
const UPSTREAM_SEGMENT: Record<ProviderName, string> = {
  openai:     "openai",
  anthropic:  "anthropic",
  gemini:     "google",
  openrouter: "openrouter",
};

// Process-local round-robin cursor. Not persisted across restarts. Multi-process
// deployments will not share rotation state — acceptable for a single-instance
// gateway.
let rrCursor = 0;

// nodeUrl → cooldown expiry timestamp (ms). Nodes in this map are temporarily
// skipped by round-robin until the expiry passes.
const nodeCooldowns = new Map<string, number>();

const COOLDOWN_DURATION_MS = 60_000; // 60 seconds

/** Mark a node as rate-limited; it will be skipped for COOLDOWN_DURATION_MS. */
export function setNodeCooldown(nodeUrl: string, durationMs = COOLDOWN_DURATION_MS): void {
  nodeCooldowns.set(nodeUrl, Date.now() + durationMs);
}

/** Check whether a node is currently in its cooldown window. */
export function isNodeCoolingDown(nodeUrl: string): boolean {
  const expiry = nodeCooldowns.get(nodeUrl);
  if (expiry === undefined) return false;
  if (Date.now() >= expiry) {
    nodeCooldowns.delete(nodeUrl);
    return false;
  }
  return true;
}

/** Return a snapshot of all active cooldowns (nodeUrl → remaining ms). */
export function getActiveCooldowns(): Record<string, number> {
  const now = Date.now();
  const result: Record<string, number> = {};
  for (const [url, expiry] of nodeCooldowns) {
    const remaining = expiry - now;
    if (remaining > 0) {
      result[url] = remaining;
    } else {
      nodeCooldowns.delete(url);
    }
  }
  return result;
}

/**
 * Move a node to the end of the pool so the next node takes its place. Used
 * after a 429: in sticky mode this is what actually switches traffic to the
 * next node, and in round-robin it pushes the throttled node to the back of
 * the queue. Entries with a blank apiKey inherit pool[0]'s key, so when the
 * head changes the inherited key is carried over to the new head.
 */
export function rotateNodeToEnd(nodeUrl: string): void {
  const pool = getSettings().reverseProxyPool;
  const idx = pool.findIndex((e) => e.url === nodeUrl);
  if (idx < 0 || pool.length < 2 || idx === pool.length - 1) return;

  const moved = pool[idx]!;
  const rest = pool.filter((_, i) => i !== idx);
  const defaultKey = pool[0]?.apiKey ?? "";
  if (idx === 0 && rest[0] && !rest[0].apiKey && defaultKey) {
    rest[0] = { ...rest[0], apiKey: defaultKey };
  }

  logger.info(
    { nodeUrl, from: idx, to: pool.length - 1, newHead: rest[0]?.url },
    "moving upstream node to end of pool",
  );
  updateSettings({ reverseProxyPool: [...rest, moved] });
}

/** Sticky mode: first node not currently cooling down, else fall back to #1. */
function firstAvailableIndex(pool: PoolEntry[]): number {
  for (let i = 0; i < pool.length; i++) {
    if (!isNodeCoolingDown(pool[i]!.url)) return i;
  }
  return 0;
}

function pickPoolIndex(pool: PoolEntry[], mode: "round-robin" | "sticky"): number {
  if (pool.length === 0) return -1;
  if (mode === "sticky") return firstAvailableIndex(pool);

  // Build list of indices for nodes that are not currently cooling down.
  const now = Date.now();
  const available: number[] = [];
  for (let i = 0; i < pool.length; i++) {
    const expiry = nodeCooldowns.get(pool[i]!.url);
    if (expiry === undefined || now >= expiry) {
      if (expiry !== undefined) nodeCooldowns.delete(pool[i]!.url); // clean up expired entry
      available.push(i);
    }
  }

  // If every node is cooling down, fall back to the full pool rather than
  // refusing to serve requests entirely.
  const candidates = available.length > 0 ? available : pool.map((_, i) => i);

  const pick = candidates[rrCursor % candidates.length]!;
  rrCursor = (rrCursor + 1) % Number.MAX_SAFE_INTEGER;
  return pick;
}

/** Peek the index that round-robin will pick next, without advancing. */
export function peekNextPoolIndex(): number | null {
  const s = getSettings();
  if (!s.reverseProxyEnabled || s.reverseProxyPool.length === 0) return null;
  if (s.reverseProxyMode === "sticky") return firstAvailableIndex(s.reverseProxyPool);
  return rrCursor % s.reverseProxyPool.length;
}

/**
 * Resolve the upstream endpoint for a provider.
 *
 * Resolution order when reverse-proxy mode is enabled:
 *   1. Per-provider override URL (with per-provider key, falling back to pool[0] key)
 *   2. Pool entry chosen by current mode (sticky → entry 0; round-robin → next cursor)
 *      - per-entry apiKey falls back to pool[0].apiKey if blank
 *   3. Local Replit AI Integration env vars
 *
 * When reverse-proxy mode is disabled, only env vars are consulted.
 *
 * Throws when no source is available.
 */
export function resolveProviderEndpoint(provider: ProviderName): ProviderEndpoint {
  // Bring back any disabled node whose recovery window (e.g. the 31-day
  // free-tier reset) has elapsed. Cheap when nothing is due; only writes when
  // a node is actually restored.
  restoreExpiredDisabledNodes();
  const settings = getSettings();
  if (settings.reverseProxyEnabled) {
    const override = settings.providerOverrides[provider];
    const overrideUrl = override.url.trim().replace(/\/+$/, "");
    const defaultKey = settings.reverseProxyPool[0]?.apiKey ?? "";

    if (overrideUrl) {
      return {
        baseUrl: `${overrideUrl}/modelfarm/${UPSTREAM_SEGMENT[provider]}`,
        apiKey: override.apiKey || defaultKey,
        source: "per-provider override",
      };
    }

    const idx = pickPoolIndex(settings.reverseProxyPool, settings.reverseProxyMode);
    if (idx >= 0) {
      const entry = settings.reverseProxyPool[idx]!;
      const poolSize = settings.reverseProxyPool.length;
      // Lightweight visibility into rotation. Logged per request — easy to
      // grep when debugging round-robin behaviour.
      logger.info(
        { provider, mode: settings.reverseProxyMode, upstreamIndex: idx, poolSize, url: entry.url },
        "reverse-proxy pool pick",
      );
      return {
        baseUrl: `${entry.url}/modelfarm/${UPSTREAM_SEGMENT[provider]}`,
        apiKey: entry.apiKey || defaultKey,
        source: "upstream",
        upstreamIndex: idx,
        poolSize,
        nodeUrl: entry.url,
        ...(entry.account ? { account: entry.account } : {}),
      };
    }
  }

  const envKeys = ENV_BY_PROVIDER[provider];
  const baseUrl = process.env[envKeys.baseUrl];
  const apiKey = process.env[envKeys.apiKey];
  if (baseUrl && apiKey) {
    return { baseUrl, apiKey, source: "local-env" };
  }

  // Reverse-proxy mode is on, yet there is no pool entry, no override and no
  // env credential. That is the normal shape of a drain: the last node was just
  // parked after a 429/quota failure and a replacement needs a few seconds.
  // Report it as transient unavailability so the caller retries, instead of the
  // misleading "not configured" error below.
  if (settings.reverseProxyEnabled) {
    throw new UpstreamUnavailableError(provider, settings.disabledUpstreamNodes.length);
  }

  throw new Error(
    `Provider "${provider}" is not configured. Either set ${envKeys.baseUrl} and ${envKeys.apiKey}, or enable reverse-proxy mode in the admin portal.`,
  );
}

export function isReverseProxyActive(): boolean {
  const s = getSettings();
  if (!s.reverseProxyEnabled) return false;
  if (s.reverseProxyPool.length > 0) return true;
  return Object.values(s.providerOverrides).some((o) => !!o.url);
}

/**
 * Can this provider still be served after the node we just used was dropped?
 *
 * Used to decide whether a node-level failure is worth replaying: a retry only
 * helps while another pool entry (or an override) remains. When the last node
 * was just disabled the pool is empty for the drain window, and a retry would
 * either hit the local env fallback or throw `UpstreamUnavailableError` —
 * hiding the real quota message the client needs to see.
 */
export function hasUsableUpstreamEndpoint(provider: ProviderName): boolean {
  const settings = getSettings();
  if (!settings.reverseProxyEnabled) return false;
  if (settings.providerOverrides[provider].url.trim()) return true;
  return settings.reverseProxyPool.length > 0;
}

/**
 * Resolve only the source label per provider, without throwing or advancing
 * the round-robin cursor. Useful for the setup-status endpoint.
 */
export function resolveProviderSource(provider: ProviderName): ProviderEndpointSource | null {
  const settings = getSettings();
  if (settings.reverseProxyEnabled) {
    const override = settings.providerOverrides[provider];
    if (override.url.trim()) return "per-provider override";
    if (settings.reverseProxyPool.length > 0) return "upstream";
  }
  const envKeys = ENV_BY_PROVIDER[provider];
  if (process.env[envKeys.baseUrl] && process.env[envKeys.apiKey]) return "local-env";
  return null;
}

// Test-only: reset the round-robin cursor.
export function _resetRoundRobinCursor(): void {
  rrCursor = 0;
}
