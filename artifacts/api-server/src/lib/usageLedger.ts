import { readJsonAsync, writeJson } from "./persist.js";
import { logger } from "./logger.js";
import { getSettings } from "./settings.js";
import { getOpenRouterCatalog } from "./openrouterCatalog.js";
import type { ProviderEndpoint, ProviderName } from "./providerEndpoint.js";
import type { StreamChunk } from "../types.js";

/**
 * Per-account / per-model usage accounting.
 *
 * The gateway serves every request through one pool node, and a node is a
 * quota-bearing account. Without attribution, "how much has this account
 * burned" can only be answered by Replit's own dashboard — which lags and says
 * nothing about which model or which node caused it. This module records the
 * token usage each provider reports, attributes it to the pool entry that
 * served the request, prices it with the OpenRouter catalog, and aggregates it
 * into hourly buckets so the ledger stays small on disk.
 *
 * Design notes:
 *  - Buckets, not events. One row per (hour, provider, model, account) keeps a
 *    month of traffic at a few thousand rows instead of hundreds of thousands.
 *  - Prices come from the OpenRouter `/models` catalog only. Nothing is
 *    hard-coded, so a cost is either sourced from a real catalog snapshot or
 *    reported as unknown (`costUsd: null`) — never invented.
 *  - Missing usage is tracked separately (`missingUsage`), because a stream that
 *    never reports tokens must not silently look like free traffic.
 */

const LEDGER_KEY = "usage_ledger_v1";
const PRICE_KEY = "openrouter_prices_v1";

const HOUR_MS = 60 * 60 * 1000;
const RETENTION_MS = 45 * 24 * HOUR_MS;
const MAX_BUCKETS = 40_000;
const MAX_RECENT = 120;
const FLUSH_DEBOUNCE_MS = 1_500;
const PRICE_TTL_MS = 10 * 60 * 1000;
const PRICE_RETRY_MS = 60 * 1000;

export type UsageWindow = "24h" | "7d" | "30d" | "all";

const WINDOW_MS: Record<UsageWindow, number> = {
  "24h": 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
  "30d": 30 * 24 * HOUR_MS,
  all: 0,
};

export function parseUsageWindow(raw: unknown): UsageWindow {
  return raw === "24h" || raw === "7d" || raw === "30d" || raw === "all" ? raw : "7d";
}

/** Usage shape reported by the four providers we talk to. */
export interface RawUsage {
  // OpenAI / OpenRouter
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
  // Anthropic
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // Gemini
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  /**
   * Cost the upstream itself reported, in USD. OpenRouter returns it as
   * `usage.cost` (with a `cost_details` breakdown). It is the only figure that
   * knows which upstream answered and what that upstream actually charged —
   * a catalog price cannot express a 10x-cheaper cache read, and it cannot
   * follow a request that routed to a differently-priced provider.
   */
  cost?: number;
}

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  /** Cost the upstream reported, or null when it did not report one. */
  upstreamCostUsd: number | null;
}

interface PriceRow {
  prompt: number; // USD per token
  completion: number; // USD per token
  name?: string;
}

interface PriceSnapshot {
  fetchedAt: number;
  source: string;
  prices: Record<string, PriceRow>;
}

/** Per-channel (OpenRouter provider) usage inside one bucket. */
interface ChannelTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

interface UsageBucket {
  /** Hour start, epoch ms. */
  t: number;
  provider: ProviderName;
  /** Resolved upstream model id — the key used for pricing. */
  model: string;
  account?: string;
  nodeUrl?: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Cost actually charged by the upstream, where it reported one. */
  upstreamCostUsd: number;
  /** Requests that carried an upstream-reported cost. */
  upstreamCostRequests: number;
  /** Cost the catalog price would have charged for the same tokens. */
  estimatedCostUsd: number;
  costUsd: number;
  pricedRequests: number;
  unpricedRequests: number;
  /**
   * Which channel actually served the request, keyed by channel name.
   *
   * OpenRouter answers with `provider` in both the JSON body and every SSE
   * chunk ("Wafer", "DeepSeek", "Chutes", …). That is the number the user
   * cares about when they ask "who served this" — the gateway's own
   * `provider` is just `openrouter` for every single row.
   */
  channels?: Record<string, ChannelTotals>;
}

export interface RecentUsageEvent {
  ts: number;
  /** Gateway channel (openrouter / openai / anthropic / gemini). */
  provider: ProviderName;
  model: string;
  /** OpenRouter-reported channel that actually served this request. */
  upstreamProvider?: string;
  account?: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
}

interface LedgerState {
  buckets: UsageBucket[];
  recent: RecentUsageEvent[];
  missingUsage: Record<string, number>;
  updatedAt: number;
}

let buckets = new Map<string, UsageBucket>();
let recent: RecentUsageEvent[] = [];
let missingUsage: Record<string, number> = {};
let loaded = false;
let initPromise: Promise<void> | null = null;
let flushTimer: NodeJS.Timeout | null = null;

let priceSnapshot: PriceSnapshot | null = null;
let priceInflight: Promise<void> | null = null;
let priceLastAttempt = 0;

function bucketKey(t: number, provider: string, model: string, account: string, nodeUrl: string): string {
  return `${t}|${provider}|${model}|${account}|${nodeUrl}`;
}

function hourStart(ts: number): number {
  return Math.floor(ts / HOUR_MS) * HOUR_MS;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Re-hydrate persisted per-channel counters, dropping anything malformed. */
function sanitizeChannels(raw: Record<string, unknown>): Record<string, ChannelTotals> {
  const out: Record<string, ChannelTotals> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!name || !value || typeof value !== "object") continue;
    const row = value as Partial<ChannelTotals>;
    out[name] = {
      requests: num(row.requests),
      promptTokens: num(row.promptTokens),
      completionTokens: num(row.completionTokens),
      costUsd: typeof row.costUsd === "number" && Number.isFinite(row.costUsd) ? row.costUsd : 0,
    };
  }
  return out;
}

/** Normalise any provider's usage object into prompt/completion token counts. */
export function normalizeUsage(raw: RawUsage | null | undefined): NormalizedUsage | null {
  if (!raw || typeof raw !== "object") return null;

  const prompt =
    num(raw.prompt_tokens) ||
    num(raw.input_tokens) ||
    num(raw.promptTokenCount);
  const completion =
    num(raw.completion_tokens) ||
    num(raw.output_tokens) ||
    num(raw.candidatesTokenCount);

  if (prompt === 0 && completion === 0) return null;

  const cached =
    num(raw.prompt_tokens_details?.cached_tokens) ||
    num(raw.cache_read_input_tokens) ||
    num(raw.cachedContentTokenCount);
  const reasoning = num(raw.completion_tokens_details?.reasoning_tokens);
  const upstreamCost = typeof raw.cost === "number" && Number.isFinite(raw.cost) ? raw.cost : null;

  return {
    promptTokens: prompt,
    completionTokens: completion,
    cachedTokens: cached,
    reasoningTokens: reasoning,
    upstreamCostUsd: upstreamCost,
  };
}

function loadLedger(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const raw = await readJsonAsync<Partial<LedgerState>>(LEDGER_KEY, {});
      const now = Date.now();
      const cutoff = now - RETENTION_MS;
      const list = Array.isArray(raw.buckets) ? raw.buckets : [];
      for (const b of list) {
        if (!b || typeof b.t !== "number" || b.t < cutoff) continue;
        if (!b.provider || !b.model) continue;
        buckets.set(
          bucketKey(b.t, b.provider, b.model, b.account ?? "", b.nodeUrl ?? ""),
          {
            t: b.t,
            provider: b.provider,
            model: b.model,
            ...(b.account ? { account: b.account } : {}),
            ...(b.nodeUrl ? { nodeUrl: b.nodeUrl } : {}),
            requests: num(b.requests),
            promptTokens: num(b.promptTokens),
            completionTokens: num(b.completionTokens),
            cachedTokens: num(b.cachedTokens),
            upstreamCostUsd: num(b.upstreamCostUsd),
            upstreamCostRequests: num(b.upstreamCostRequests),
            estimatedCostUsd: num(b.estimatedCostUsd),
            costUsd: typeof b.costUsd === "number" && Number.isFinite(b.costUsd) ? b.costUsd : 0,
            pricedRequests: num(b.pricedRequests),
            unpricedRequests: num(b.unpricedRequests),
            ...(b.channels && typeof b.channels === "object"
              ? { channels: sanitizeChannels(b.channels) }
              : {}),
          },
        );
      }
      // Older ledgers have no `upstreamProvider` on recent events; keep them as
      // they are and let the UI say "未上报" rather than inventing a channel.
      recent = Array.isArray(raw.recent) ? raw.recent.slice(-MAX_RECENT) : [];
      missingUsage = raw.missingUsage && typeof raw.missingUsage === "object" ? { ...raw.missingUsage } : {};
    } catch (err) {
      logger.warn({ err }, "failed to load usage ledger — starting empty");
    }
    try {
      const snap = await readJsonAsync<PriceSnapshot | null>(PRICE_KEY, null);
      if (snap && typeof snap === "object" && snap.prices && typeof snap.fetchedAt === "number") {
        priceSnapshot = snap;
      }
    } catch (err) {
      logger.warn({ err }, "failed to load OpenRouter price snapshot");
    }
    loaded = true;
  })();
  return initPromise;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushLedger();
  }, FLUSH_DEBOUNCE_MS);
  flushTimer.unref?.();
}

function flushLedger(): void {
  if (!loaded) return;
  const cutoff = Date.now() - RETENTION_MS;
  for (const [key, bucket] of buckets) {
    if (bucket.t < cutoff) buckets.delete(key);
  }
  // Hard cap: drop the oldest hours first if the ledger somehow explodes.
  if (buckets.size > MAX_BUCKETS) {
    const sorted = [...buckets.entries()].sort((a, b) => a[1].t - b[1].t);
    for (const [key] of sorted.slice(0, buckets.size - MAX_BUCKETS)) buckets.delete(key);
  }
  const state: LedgerState = {
    buckets: [...buckets.values()],
    recent,
    missingUsage,
    updatedAt: Date.now(),
  };
  try {
    writeJson(LEDGER_KEY, state);
  } catch (err) {
    logger.error({ err }, "failed to persist usage ledger");
  }
}

/**
 * Load the ledger and warm the price snapshot. Safe to call more than once.
 */
export async function initUsageLedger(): Promise<void> {
  await loadLedger();
  void refreshPrices().catch(() => {
    /* logged inside */
  });
}

function parsePerToken(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Refresh the OpenRouter price table from the public catalog and persist it, so
 * costs survive a restart even when the catalog is briefly unreachable.
 */
export async function refreshPrices(force = false): Promise<PriceSnapshot | null> {
  await loadLedger();
  const now = Date.now();
  if (!force && priceSnapshot && now - priceSnapshot.fetchedAt < PRICE_TTL_MS) return priceSnapshot;
  if (!force && now - priceLastAttempt < PRICE_RETRY_MS) return priceSnapshot;
  if (priceInflight) {
    await priceInflight;
    return priceSnapshot;
  }

  priceLastAttempt = now;
  priceInflight = (async () => {
    try {
      const catalog = await getOpenRouterCatalog({ refresh: force });
      const prices: Record<string, PriceRow> = {};
      for (const entry of catalog.models) {
        const prompt = parsePerToken(entry.promptPrice);
        const completion = parsePerToken(entry.completionPrice);
        if (prompt === null || completion === null) continue;
        prices[entry.id.toLowerCase()] = {
          prompt,
          completion,
          ...(entry.name ? { name: entry.name } : {}),
        };
      }
      if (Object.keys(prices).length === 0) return;
      priceSnapshot = { fetchedAt: Date.now(), source: catalog.source, prices };
      try {
        writeJson(PRICE_KEY, priceSnapshot);
      } catch (err) {
        logger.warn({ err }, "failed to persist OpenRouter price snapshot");
      }
      logger.info(
        { models: Object.keys(prices).length, source: catalog.source },
        "OpenRouter price snapshot refreshed",
      );
    } catch (err) {
      logger.warn({ err }, "failed to refresh OpenRouter prices — keeping previous snapshot");
    } finally {
      priceInflight = null;
    }
  })();

  await priceInflight;
  return priceSnapshot;
}

function priceCandidates(model: string): string[] {
  const base = model.trim().toLowerCase();
  const out = new Set<string>([base]);
  // OpenRouter variants: "vendor/model:free" and "~vendor/model" (deprecated).
  const noVariant = base.replace(/:(free|online|nitro|floor|extended)$/, "");
  out.add(noVariant);
  out.add(noVariant.replace(/^~/, ""));
  out.add(base.replace(/^~/, ""));
  out.add(base.replace(/-thinking-(low|medium|high|xhigh|max)$/, ""));
  out.add(noVariant.replace(/-thinking-(low|medium|high|xhigh|max)$/, ""));
  return [...out];
}

/** USD-per-token price for a model, or null when the catalog has no entry. */
export function getModelPrice(
  provider: ProviderName,
  model: string,
): { prompt: number; completion: number; source: "catalog" } | null {
  if (provider !== "openrouter" || !priceSnapshot) return null;
  for (const candidate of priceCandidates(model)) {
    const row = priceSnapshot.prices[candidate];
    if (row) return { prompt: row.prompt, completion: row.completion, source: "catalog" };
  }
  return null;
}

export interface RecordUsageInput {
  provider: ProviderName;
  /** Resolved upstream model (pricing key). */
  model: string;
  endpoint?: ProviderEndpoint;
  usage?: RawUsage | null;
  /** Client-facing model id, kept out of the pricing path. */
  requestedModel?: string;
  /** Channel that actually served the request (OpenRouter's `provider`). */
  upstreamProvider?: string;
  ts?: number;
}

/**
 * Record one completed request. Cheap and synchronous: it merges into an hourly
 * bucket and schedules a debounced flush.
 */
export function recordUsage(input: RecordUsageInput): void {
  const usage = normalizeUsage(input.usage);
  if (!usage) {
    // Non-zero traffic that reports no tokens is a coverage gap, not zero use.
    missingUsage[input.provider] = (missingUsage[input.provider] ?? 0) + 1;
    scheduleFlush();
    return;
  }

  const ts = input.ts ?? Date.now();
  const t = hourStart(ts);
  const account = input.endpoint?.account?.trim() ?? "";
  const nodeUrl = input.endpoint?.nodeUrl ?? "";
  const key = bucketKey(t, input.provider, input.model, account, nodeUrl);

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      t,
      provider: input.provider,
      model: input.model,
      ...(account ? { account } : {}),
      ...(nodeUrl ? { nodeUrl } : {}),
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      upstreamCostUsd: 0,
      upstreamCostRequests: 0,
      estimatedCostUsd: 0,
      costUsd: 0,
      pricedRequests: 0,
      unpricedRequests: 0,
    };
    buckets.set(key, bucket);
  }

  bucket.requests += 1;
  bucket.promptTokens += usage.promptTokens;
  bucket.completionTokens += usage.completionTokens;
  bucket.cachedTokens += usage.cachedTokens;

  const price = getModelPrice(input.provider, input.model);
  const estimated = price
    ? usage.promptTokens * price.prompt + usage.completionTokens * price.completion
    : null;
  // Prefer what the upstream actually charged. A catalog price cannot see a
  // 10x-cheaper cache read, nor which of the many providers for a model
  // actually answered — on 2026-10-24 that gap was 3.5x over 24 hours, and a
  // wrong number here is what drives quota decisions.
  const upstream = usage.upstreamCostUsd;
  const cost = upstream ?? estimated;
  if (upstream !== null) {
    bucket.upstreamCostUsd += upstream;
    bucket.upstreamCostRequests += 1;
  }
  if (estimated !== null) bucket.estimatedCostUsd += estimated;
  if (cost !== null) {
    bucket.costUsd += cost;
    bucket.pricedRequests += 1;
  } else {
    bucket.unpricedRequests += 1;
  }

  recent.push({
    ts,
    provider: input.provider,
    model: input.model,
    ...(input.upstreamProvider ? { upstreamProvider: input.upstreamProvider } : {}),
    ...(account ? { account } : nodeUrl ? { account: nodeUrl } : {}),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    costUsd: cost,
  });
  if (recent.length > MAX_RECENT) recent = recent.slice(-MAX_RECENT);

  // Which channel served it — same attribution the recent list shows, rolled up
  // per hour so the model table can say "DeepSeek 3,900 · Wafer 210" instead of
  // collapsing every OpenRouter row into one line.
  const channelName = input.upstreamProvider?.trim();
  if (channelName) {
    const channels = (bucket.channels ??= {});
    const channel = (channels[channelName] ??= {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
    });
    channel.requests += 1;
    channel.promptTokens += usage.promptTokens;
    channel.completionTokens += usage.completionTokens;
    channel.costUsd += cost ?? 0;
  }

  scheduleFlush();
}

/** Clear every recorded bucket. Used by the portal's reset action. */
export async function resetUsage(): Promise<void> {
  await loadLedger();
  buckets.clear();
  recent = [];
  missingUsage = {};
  flushLedger();
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  costUsd: number;
  /**
   * Cost the upstream itself reported, summed over the requests that reported
   * one. `costUsd` prefers this; `estimatedCostUsd` is what the catalog price
   * would have said for the same tokens.
   */
  upstreamCostUsd: number;
  /** Requests that carried an upstream-reported cost. */
  upstreamCostRequests: number;
  /** Catalog-price estimate for the same traffic. */
  estimatedCostUsd: number;
  pricedRequests: number;
  unpricedRequests: number;
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    upstreamCostUsd: 0,
    upstreamCostRequests: 0,
    estimatedCostUsd: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
  };
}

function addTotals(target: UsageTotals, b: UsageBucket): void {
  target.requests += b.requests;
  target.promptTokens += b.promptTokens;
  target.completionTokens += b.completionTokens;
  target.totalTokens += b.promptTokens + b.completionTokens;
  target.cachedTokens += b.cachedTokens;
  target.costUsd += b.costUsd;
  target.upstreamCostUsd += b.upstreamCostUsd;
  target.upstreamCostRequests += b.upstreamCostRequests;
  target.estimatedCostUsd += b.estimatedCostUsd;
  target.pricedRequests += b.pricedRequests;
  target.unpricedRequests += b.unpricedRequests;
}

export interface UsageAccountRow extends UsageTotals {
  key: string;
  account?: string;
  nodeUrls: string[];
  firstUsedAt?: number;
  lastUsedAt?: number;
  /** Share of the window's total tokens, 0-100. */
  sharePct: number;
  status: "active" | "blocked-quota" | "blocked-suspect" | "blocked" | "wakeup" | "inactive";
  blocked?: {
    disabledAt?: string;
    disabledReason: string;
    upstreamReason?: string;
    upstreamStatus?: number;
    recoverAt?: string;
    lastError?: string;
    /** Quota verdict rests on an inferred signal — a short, re-probeable park. */
    quotaSignalUnverified?: boolean;
  };
}

export interface UsageModelRow extends UsageTotals {
  provider: ProviderName;
  model: string;
  priced: boolean;
  promptPricePerM: number | null;
  completionPricePerM: number | null;
  sharePct: number;
  avgCostPerRequest: number | null;
  /** Channels (OpenRouter providers) that served this model, busiest first. */
  channels: UsageChannelRow[];
}

/** One OpenRouter channel's slice of a model's traffic. */
export interface UsageChannelRow {
  /** Channel name exactly as OpenRouter reported it ("Wafer", "DeepSeek", …). */
  name: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /**
   * Share of the *channel-attributed* requests this channel served, 0-100.
   * Requests recorded before channel capture have no attribution and are left
   * out of the denominator on purpose.
   */
  sharePct: number;
}

export interface UsageProviderRow extends UsageTotals {
  provider: ProviderName;
  sharePct: number;
}

export interface UsageDailyRow extends UsageTotals {
  date: string;
}

export interface UsageReport {
  window: UsageWindow;
  since: number;
  generatedAt: number;
  totals: UsageTotals;
  byProvider: UsageProviderRow[];
  byAccount: UsageAccountRow[];
  byModel: UsageModelRow[];
  daily: UsageDailyRow[];
  recent: RecentUsageEvent[];
  coverage: {
    /** Requests that reported tokens. */
    measuredRequests: number;
    /** Requests that completed but reported no usage object. */
    missingUsage: Record<string, number>;
    missingTotal: number;
  };
  pricing: {
    source: string | null;
    fetchedAt: number | null;
    models: number;
    currency: "USD";
  };
  pool: {
    size: number;
    mode: string;
    enabled: boolean;
    blockedQuota: number;
    blockedTotal: number;
  };
  /**
   * Fleet-level inventory slot. This gateway serves one pool and has no
   * separate inventory, so it is always null; the field stays in the shape so
   * the portal does not have to branch on it.
   */
  fleet: null;
}

const BUDGET_REASON_RE = /FREE_TIER|budget|spend|quota|exceeded|额度|余额/i;

/**
 * Build the portal report. Everything is derived from the hourly buckets plus
 * the current pool/blocked state, so a blocked account with no traffic still
 * shows up (with zero consumption) instead of silently disappearing.
 */
export function buildUsageReport(window: UsageWindow, now = Date.now()): UsageReport {
  const since = window === "all" ? 0 : now - WINDOW_MS[window];
  const settings = getSettings();

  // url → account, used to attribute buckets recorded before the account was
  // known (older state files only had URLs).
  const urlToAccount = new Map<string, string>();
  for (const entry of settings.reverseProxyPool) {
    if (entry.account) urlToAccount.set(entry.url, entry.account);
  }
  for (const entry of settings.disabledUpstreamNodes) {
    if (entry.account) urlToAccount.set(entry.url, entry.account);
  }

  const totals = emptyTotals();
  const byProvider = new Map<ProviderName, UsageTotals>();
  const byAccount = new Map<string, UsageAccountRow>();
  const byModel = new Map<string, UsageModelRow>();
  /** modelKey → channel name → totals, rolled up across buckets. */
  const modelChannels = new Map<string, Map<string, ChannelTotals>>();
  const daily = new Map<string, UsageDailyRow>();
  const accountUrls = new Map<string, Set<string>>();

  for (const bucket of buckets.values()) {
    if (bucket.t + HOUR_MS <= since) continue;

    addTotals(totals, bucket);

    let providerRow = byProvider.get(bucket.provider);
    if (!providerRow) {
      providerRow = emptyTotals();
      byProvider.set(bucket.provider, providerRow);
    }
    addTotals(providerRow, bucket);

    const accountKey =
      (bucket.account && bucket.account.trim()) ||
      (bucket.nodeUrl ? urlToAccount.get(bucket.nodeUrl) : undefined) ||
      bucket.nodeUrl ||
      "unknown";
    let accountRow = byAccount.get(accountKey);
    if (!accountRow) {
      accountRow = {
        key: accountKey,
        ...(accountKey !== "unknown" && accountKey.includes("@") ? { account: accountKey } : {}),
        nodeUrls: [],
        sharePct: 0,
        status: "inactive",
        ...emptyTotals(),
      };
      byAccount.set(accountKey, accountRow);
      accountUrls.set(accountKey, new Set());
    }
    addTotals(accountRow, bucket);
    if (bucket.nodeUrl) {
      accountUrls.get(accountKey)!.add(bucket.nodeUrl);
      if (!accountRow.nodeUrls.includes(bucket.nodeUrl)) accountRow.nodeUrls.push(bucket.nodeUrl);
    }
    if (accountRow.firstUsedAt === undefined || bucket.t < accountRow.firstUsedAt) accountRow.firstUsedAt = bucket.t;
    const bucketEnd = bucket.t + HOUR_MS;
    if (accountRow.lastUsedAt === undefined || bucketEnd > accountRow.lastUsedAt) {
      accountRow.lastUsedAt = Math.min(bucketEnd, now);
    }

    const modelKey = `${bucket.provider}|${bucket.model}`;
    let modelRow = byModel.get(modelKey);
    if (!modelRow) {
      const price = getModelPrice(bucket.provider, bucket.model);
      modelRow = {
        provider: bucket.provider,
        model: bucket.model,
        priced: !!price,
        promptPricePerM: price ? round(price.prompt * 1_000_000, 6) : null,
        completionPricePerM: price ? round(price.completion * 1_000_000, 6) : null,
        sharePct: 0,
        avgCostPerRequest: null,
        channels: [],
        ...emptyTotals(),
      };
      byModel.set(modelKey, modelRow);
    }
    addTotals(modelRow, bucket);
    if (bucket.channels) {
      const channelMap = modelChannels.get(modelKey) ?? new Map<string, ChannelTotals>();
      for (const [name, row] of Object.entries(bucket.channels)) {
        const target = channelMap.get(name) ?? { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
        target.requests += row.requests;
        target.promptTokens += row.promptTokens;
        target.completionTokens += row.completionTokens;
        target.costUsd += row.costUsd;
        channelMap.set(name, target);
      }
      modelChannels.set(modelKey, channelMap);
    }

    const date = new Date(bucket.t).toISOString().slice(0, 10);
    let dayRow = daily.get(date);
    if (!dayRow) {
      dayRow = { date, ...emptyTotals() };
      daily.set(date, dayRow);
    }
    addTotals(dayRow, bucket);
  }

  // Accounts that exist in the pool but served nothing in this window.
  for (const entry of settings.reverseProxyPool) {
    const key = entry.account || entry.url;
    if (byAccount.has(key)) continue;
    byAccount.set(key, {
      key,
      ...(entry.account ? { account: entry.account } : {}),
      nodeUrls: [entry.url],
      sharePct: 0,
      status: "active",
      ...emptyTotals(),
    });
  }

  // Blocked entries — this is the "屏蔽池" view, including quota 403s.
  let blockedQuota = 0;
  for (const entry of settings.disabledUpstreamNodes) {
    const key = entry.account || urlToAccount.get(entry.url) || entry.url;
    let row = byAccount.get(key);
    if (!row && entry.account && byAccount.has(entry.url)) {
      // Traffic was recorded under the bare URL before the account was known.
      const legacy = byAccount.get(entry.url)!;
      byAccount.delete(entry.url);
      row = { ...legacy, key, account: entry.account };
      byAccount.set(key, row);
    }
    if (!row) {
      row = {
        key,
        ...(entry.account ? { account: entry.account } : {}),
        nodeUrls: [entry.url],
        sharePct: 0,
        status: "inactive",
        ...emptyTotals(),
      };
      byAccount.set(key, row);
    }
    if (!row.nodeUrls.includes(entry.url)) row.nodeUrls.push(entry.url);
    // Only an explicit 403 budget body is a spent account. A pool node folds
    // every upstream 429 into `reason: "quota-exhausted"`, and a row the
    // gateway itself marked `quotaSignalUnverified` is parked for five minutes
    // pending a probe — counting those as "额度 403" made the panel report twice
    // the real casualties (six rows shown, three real, 2026-10-26).
    const budgetReason = BUDGET_REASON_RE.test(entry.upstreamReason ?? "");
    const quota =
      entry.upstreamStatus === 403 && budgetReason && entry.quotaSignalUnverified !== true;
    const suspect = !quota && (entry.quotaSignalUnverified === true || budgetReason);
    if (quota) blockedQuota += 1;
    row.blocked = {
      disabledAt: entry.disabledAt,
      disabledReason: entry.disabledReason,
      upstreamReason: entry.upstreamReason,
      upstreamStatus: entry.upstreamStatus,
      recoverAt: entry.recoverAt,
      lastError: entry.lastError,
      ...(entry.quotaSignalUnverified ? { quotaSignalUnverified: true } : {}),
    };
    row.status = quota
      ? "blocked-quota"
      : suspect
        ? "blocked-suspect"
        : entry.disabledReason === "requires-wakeup"
          ? "wakeup"
          : "blocked";
  }
  for (const row of byAccount.values()) {
    if (row.blocked) continue;
    const inPool = settings.reverseProxyPool.some(
      (e) => row.nodeUrls.includes(e.url) || (row.account !== undefined && e.account === row.account),
    );
    row.status = inPool ? "active" : "inactive";
  }
  for (const row of byAccount.values()) {
    row.nodeUrls.sort();
    row.sharePct = totals.totalTokens > 0 ? round((row.totalTokens / totals.totalTokens) * 100, 2) : 0;
  }

  const providerRows: UsageProviderRow[] = [...byProvider.entries()]
    .map(([provider, row]) => ({
      ...row,
      provider,
      sharePct: totals.totalTokens > 0 ? round((row.totalTokens / totals.totalTokens) * 100, 2) : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const modelRows = [...byModel.values()];
  for (const row of modelRows) {
    row.sharePct = totals.totalTokens > 0 ? round((row.totalTokens / totals.totalTokens) * 100, 2) : 0;
    row.avgCostPerRequest = row.pricedRequests > 0 ? round(row.costUsd / row.pricedRequests, 8) : null;
    const channelMap = modelChannels.get(`${row.provider}|${row.model}`);
    const attributed = channelMap
      ? [...channelMap.values()].reduce((sum, totals_) => sum + totals_.requests, 0)
      : 0;
    row.channels = channelMap
      ? [...channelMap.entries()]
          .map(([name, totals_]) => ({
            name,
            requests: totals_.requests,
            promptTokens: totals_.promptTokens,
            completionTokens: totals_.completionTokens,
            totalTokens: totals_.promptTokens + totals_.completionTokens,
            costUsd: totals_.costUsd,
            // Share of the requests that have a channel recorded — not of the
            // model's whole traffic. Traffic recorded before this field existed
            // has no channel, and dividing by it would render the only known
            // channel as "0.2%" and look broken.
            sharePct: attributed > 0 ? round((totals_.requests / attributed) * 100, 2) : 0,
          }))
          .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name))
      : [];
  }
  modelRows.sort((a, b) => b.totalTokens - a.totalTokens);

  const accountRows = [...byAccount.values()].sort(
    (a, b) => b.totalTokens - a.totalTokens || String(a.key).localeCompare(String(b.key)),
  );

  const dailyRows = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const missingTotal = Object.values(missingUsage).reduce((sum, n) => sum + n, 0);

  return {
    window,
    since,
    generatedAt: now,
    totals,
    byProvider: providerRows,
    byAccount: accountRows,
    byModel: modelRows,
    daily: dailyRows,
    recent: [...recent].reverse().slice(0, 50),
    coverage: {
      measuredRequests: totals.requests,
      missingUsage: { ...missingUsage },
      missingTotal,
    },
    pricing: {
      source: priceSnapshot?.source ?? null,
      fetchedAt: priceSnapshot?.fetchedAt ?? null,
      models: priceSnapshot ? Object.keys(priceSnapshot.prices).length : 0,
      currency: "USD",
    },
    pool: {
      size: settings.reverseProxyPool.length,
      mode: settings.reverseProxyMode,
      enabled: settings.reverseProxyEnabled,
      blockedQuota,
      blockedTotal: settings.disabledUpstreamNodes.length,
    },
    fleet: null,
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Wrap an SSE chunk stream so the usage object the upstream reports (usually on
 * the last chunk) is recorded after the stream finishes. Chunks pass through
 * untouched; when the stream never reports usage the gap is counted.
 *
 * OpenRouter stamps `provider` on every chunk — that is the channel that
 * actually served the request, so pick it up here too (streaming traffic is
 * the bulk of it, and a recent-calls list without it is back to "openrouter").
 */
export async function* tapStreamUsage(
  stream: AsyncIterable<StreamChunk>,
  meta: { provider: ProviderName; model: string; endpoint?: ProviderEndpoint; requestedModel?: string },
): AsyncGenerator<StreamChunk> {
  let usage: RawUsage | null = null;
  let upstreamProvider: string | undefined;
  for await (const chunk of stream) {
    if (chunk && typeof chunk === "object") {
      if (chunk.usage) usage = chunk.usage as RawUsage;
      const channel = (chunk as { provider?: unknown }).provider;
      if (typeof channel === "string" && channel.trim()) upstreamProvider = channel.trim();
    }
    yield chunk;
  }
  recordUsage({ ...meta, usage, ...(upstreamProvider ? { upstreamProvider } : {}) });
}
