const API_BASE = "/api";
const V1_BASE = "/v1";

export type ProviderName = "openai" | "anthropic" | "gemini" | "openrouter";

export type ProviderSource = "upstream" | "local-env" | "per-provider override";

export type ReverseProxyMode = "round-robin" | "sticky";

export interface SetupStatus {
  configured: boolean;
  providers: {
    openai: boolean;
    anthropic: boolean;
    gemini: boolean;
    openrouter: boolean;
    proxyKey: boolean;
  };
  providerSources?: Record<ProviderName, ProviderSource | null>;
  reverseProxy?: boolean;
  pool?: { size: number; mode: ReverseProxyMode; nextIndex: number | null };
}

export interface PublicProviderOverride {
  url: string;
  apiKeySet: boolean;
}

export interface PublicPoolEntry {
  url: string;
  apiKeySet: boolean;
}

export interface DisabledUpstreamNode {
  url: string;
  type: string;
  disabledReason: string;
  disabledAt?: string;
  lastError?: string;
  upstreamReason?: string;
  upstreamStatus?: number;
  /** ISO time after which the node is automatically restored to the pool. */
  recoverAt?: string;
}

export type OpenRouterRoutingTier = "auto" | "floor" | "nitro";

export interface Settings {
  sillyTavernMode: boolean;
  syntheticStreamShim: boolean;
  /**
   * OpenRouter routing variant appended to the outgoing model id.
   * `auto` = untouched; `floor` = price sort + flex tier eligible;
   * `nitro` = throughput sort + priority tier eligible. Neither pins a provider.
   */
  openRouterRoutingTier: OpenRouterRoutingTier;
  /** Claude Code client model id → gateway model id. */
  claudeCodeModelMap: Record<string, string>;
  reverseProxyEnabled: boolean;
  reverseProxyMode: ReverseProxyMode;
  reverseProxyPool: PublicPoolEntry[];
  providerOverrides: Record<ProviderName, PublicProviderOverride>;
  disabledUpstreamNodes: DisabledUpstreamNode[];
}

export interface ProviderOverridePatch {
  url?: string;
  // Empty string = leave unchanged; null = clear the stored key.
  apiKey?: string | null;
}

export interface PoolEntryPatch {
  url: string;
  // Empty string / undefined = preserve existing key for this URL; null = clear.
  apiKey?: string | null;
}

export interface SettingsPatch {
  sillyTavernMode?: boolean;
  syntheticStreamShim?: boolean;
  openRouterRoutingTier?: OpenRouterRoutingTier;
  /** Whole-map replacement; `{}` clears every alias. */
  claudeCodeModelMap?: Record<string, string>;
  reverseProxyEnabled?: boolean;
  reverseProxyMode?: ReverseProxyMode;
  reverseProxyPool?: PoolEntryPatch[];
  providerOverrides?: Partial<Record<ProviderName, ProviderOverridePatch>>;
}

export interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  provider: string;
  disabled: boolean;
  /** True for models the operator added at runtime — those can be deleted. */
  custom?: boolean;
}

export interface ModelsResponse {
  object: string;
  data: ModelEntry[];
}

export type CatalogSource = "openrouter-public" | "gateway-upstream";

export interface OpenRouterCatalogEntry {
  id: string;
  name: string;
  created: number;
  description?: string;
  contextLength: number | null;
  promptPrice: string | null;
  completionPrice: string | null;
  modality: string | null;
  /** Already present in the gateway registry (built-in or previously added). */
  existing: boolean;
}

export interface OpenRouterCatalogResponse {
  object: string;
  source: CatalogSource;
  fetched_at: number;
  data: OpenRouterCatalogEntry[];
}

export type AddModelSkipReason = "invalid-id" | "builtin" | "already-added" | "limit-reached";

/**
 * Thinking-variant suffixes the gateway registers next to a base model when
 * asked to (mirrors THINKING_VARIANT_SUFFIXES in the api-server).
 */
export const THINKING_VARIANT_SUFFIXES = [
  "-thinking",
  "-thinking-low",
  "-thinking-medium",
  "-thinking-high",
  "-thinking-xhigh",
  "-thinking-max",
] as const;

/** True when `id` is itself a thinking variant rather than a base model. */
export function isThinkingVariantId(id: string): boolean {
  return /-thinking(-visible|-low|-medium|-high|-xhigh|-max)?$/.test(id);
}

/** Thinking-variant ids derived from a base model id. */
export function thinkingVariantIds(baseId: string): string[] {
  return THINKING_VARIANT_SUFFIXES.map((suffix) => `${baseId}${suffix}`);
}

export interface AddModelsResult {
  ok: boolean;
  added: Array<{ id: string; provider: string; created: number }>;
  skipped: Array<{ id: string; reason: AddModelSkipReason }>;
}

function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// In-memory store (primary) — works even when localStorage/cookies are blocked by iframe sandbox
let _inMemoryKey = "";

function getCookie(name: string): string {
  try {
    const match = document.cookie.split("; ").find((row) => row.startsWith(name + "="));
    return match ? decodeURIComponent(match.split("=")[1]!) : "";
  } catch {
    return "";
  }
}

function setCookie(name: string, value: string, days: number): void {
  try {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Strict`;
  } catch {
    // cookie access blocked — in-memory key is still set
  }
}

function deleteCookie(name: string): void {
  try {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Strict`;
  } catch {}
}

export function setClientKey(key: string): void {
  _inMemoryKey = key.trim();
  if (_inMemoryKey) {
    setCookie("gateway_api_key", _inMemoryKey, 7);
    try { window.localStorage.setItem("gateway_api_key", _inMemoryKey); } catch {}
  } else {
    deleteCookie("gateway_api_key");
    try { window.localStorage.removeItem("gateway_api_key"); } catch {}
  }
}

export function getApiKey(): string {
  if (_inMemoryKey) return _inMemoryKey;
  // Try cookie first (works in more iframe contexts than localStorage)
  const fromCookie = getCookie("gateway_api_key");
  if (fromCookie) {
    _inMemoryKey = fromCookie;
    return _inMemoryKey;
  }
  const fromStorage = safeLocalStorage()?.getItem("gateway_api_key") ?? "";
  if (fromStorage) {
    _inMemoryKey = fromStorage;
    return _inMemoryKey;
  }
  return "";
}

function authHeaders(): HeadersInit {
  const key = getApiKey();
  return key ? { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

export async function verifyKey(): Promise<{ valid: boolean; keyRequired: boolean }> {
  const res = await fetch(`${API_BASE}/verify-key`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await fetch(`${API_BASE}/setup-status`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSettings(): Promise<Settings> {
  const res = await fetch(`${API_BASE}/settings`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const res = await fetch(`${API_BASE}/settings`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchAdminModels(): Promise<ModelsResponse> {
  const res = await fetch(`${V1_BASE}/admin/models`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export type ClaudeModelMatch = "exact" | "mapped" | "normalized" | "canonical" | "family" | "unmapped";

export interface ClaudeModelObservation {
  requested: string;
  resolved: string;
  match: ClaudeModelMatch;
  resolvedDisabled: boolean;
  count: number;
  lastSeen: string;
  mapped: boolean;
  target: string | null;
}

export interface ClaudeModelObservationsResponse {
  object: string;
  count: number;
  data: ClaudeModelObservation[];
}

/** Model ids Claude Code has actually sent recently (in-memory on the server). */
export async function fetchClaudeCodeModels(): Promise<ClaudeModelObservationsResponse> {
  const res = await fetch(`${V1_BASE}/admin/claude-code/models`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function patchModel(id: string, disabled: boolean): Promise<void> {
  const res = await fetch(`${V1_BASE}/admin/models`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ id, disabled }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function patchProviderModels(provider: string, all_disabled: boolean): Promise<void> {
  const res = await fetch(`${V1_BASE}/admin/models`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ provider, all_disabled }),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    return JSON.parse(text)?.error?.message ?? text;
  } catch {
    return text;
  }
}

/** Pull the live OpenRouter model catalog. `refresh` bypasses the server cache. */
export async function fetchOpenRouterCatalog(refresh = false): Promise<OpenRouterCatalogResponse> {
  const res = await fetch(`${V1_BASE}/admin/openrouter/models${refresh ? "?refresh=1" : ""}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

/**
 * Add models to the registry. With `thinkingVariants` the server also registers
 * the `-thinking*` variants of every base id (see THINKING_VARIANT_SUFFIXES).
 */
export async function addModels(
  models: Array<{ id: string; created?: number }>,
  provider = "openrouter",
  thinkingVariants = false,
): Promise<AddModelsResult> {
  const res = await fetch(`${V1_BASE}/admin/models`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ provider, models, thinking_variants: thinkingVariants }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

/** Remove an operator-added model, optionally together with its `-thinking*` variants. */
export async function deleteModel(id: string, thinkingVariants = false): Promise<void> {
  const res = await fetch(`${V1_BASE}/admin/models`, {
    method: "DELETE",
    headers: authHeaders(),
    body: JSON.stringify({ id, thinking_variants: thinkingVariants }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
}

export async function reEnableUpstreamNode(url: string): Promise<void> {
  const res = await fetch(`${API_BASE}/upstream-nodes/re-enable`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export interface NodeCheckResult {
  url: string;
  online: boolean;
  status?: number;
  latencyMs: number;
  reason?: string;
  error?: string;
  /**
   * Classification from the AI check:
   * - ok                     reachable and answered a real completion
   * - credential             500 with an empty body — no AI credential, needs a republish
   * - server-error-with-body 500 but the request reached upstream (transient), cooled down
   * - quota                  403 FREE_TIER_BUDGET_EXCEEDED — monthly quota, republishing cannot help
   * - forbidden              any other 403 that carries a body — access refused, no recovery window
   * - unreachable            no HTTP response at all (DNS / timeout / refused)
   * - error                  anything else, including a 403 that never yields a body
   */
  kind?: "ok" | "credential" | "server-error-with-body" | "quota" | "forbidden" | "unreachable" | "error";
}

export interface NodeAiCheckResult {
  results: NodeCheckResult[];
  disabled: string[];
  cooled: string[];
  summary: {
    total: number;
    ok: number;
    disabled: number;
    cooled: number;
    quota: number;
    forbidden: number;
    unreachable: number;
    error: number;
  };
}

/** Probe every pool node; offline ones are disabled server-side. */
export async function checkUpstreamNodes(): Promise<{ results: NodeCheckResult[]; disabled: string[] }> {
  const res = await fetch(`${API_BASE}/upstream-nodes/check`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

/**
 * Send a 1-token LLM call through every pool node. A 500 with an empty body is
 * disabled (it cannot obtain an AI credential until the deployment is
 * republished); a 500 carrying a provider error body is merely cooled down;
 * a quota 403 is disabled for 31 days and any other 403 is disabled outright.
 */
export async function checkUpstreamNodesAi(): Promise<NodeAiCheckResult> {
  const res = await fetch(`${API_BASE}/upstream-nodes/check-ai`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

/** Send a 1-token LLM call through every disabled node; passing ones are restored server-side. */
export async function checkDisabledUpstreamNodes(): Promise<{
  results: NodeCheckResult[];
  restored: string[];
  /** Entries whose recorded reason changed while re-probing (e.g. forbidden → quota). */
  relabeled: Array<{ url: string; from?: string; to: string }>;
}> {
  const res = await fetch(`${API_BASE}/upstream-nodes/check-disabled`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export interface BuildInfo {
  /** Short git commit the running bundle was built from ("dev" when unbundled). */
  commit: string;
  /** ISO timestamp of the build, not of the deploy. */
  builtAt: string;
}

/**
 * Which build the api-server is running. Public and unauthenticated — it is
 * the one thing that distinguishes "my fix isn't deployed" from "my fix is
 * deployed but the portal is stale".
 */
export async function fetchBuildInfo(): Promise<BuildInfo> {
  const res = await fetch(`${API_BASE}/build-info`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export interface CopyFromResult {
  poolEntries: Array<{ url: string }>;
  disabledNodesImported: number;
}

export async function fetchCooldowns(): Promise<Record<string, number>> {
  const res = await fetch(`${API_BASE}/upstream-nodes/cooldowns`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { cooldowns: Record<string, number> };
  return data.cooldowns;
}

export async function fetchUpstreamNodesFrom(masterUrl: string, apiKey?: string): Promise<CopyFromResult> {
  const res = await fetch(`${API_BASE}/upstream-nodes/copy-from`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ url: masterUrl, apiKey: apiKey ?? "" }),
  });
  if (!res.ok) {
    let msg = await res.text();
    try { msg = JSON.parse(msg)?.error?.message ?? msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Usage accounting
// ---------------------------------------------------------------------------
//
// 直接追加到 reapi-main/artifacts/api-portal/src/lib/api.ts 的**文件末尾**。
// 后端已具备同形接口（api-server/src/routes/usage.ts 提供 GET /api/usage、
// POST /api/usage/refresh-prices、POST /api/usage/reset），本块只补前端类型与
// fetch 封装；`API_BASE` / `authHeaders()` / `errorMessage()` 都是 main 现有
// 私有符号，风格与文件内其他函数一致（同目录、同 base URL 处理，均为 "/api"）。

export type UsageWindow = "24h" | "7d" | "30d" | "all";

export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  costUsd: number;
  /** Cost the upstream itself reported (preferred over the catalog estimate). */
  upstreamCostUsd: number;
  upstreamCostRequests: number;
  /** What the catalog price would have charged for the same tokens. */
  estimatedCostUsd: number;
  pricedRequests: number;
  unpricedRequests: number;
}

export interface UsageAccountRow extends UsageTotals {
  key: string;
  account?: string;
  nodeUrls: string[];
  firstUsedAt?: number;
  lastUsedAt?: number;
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

/** One OpenRouter channel's slice of a model's traffic. */
export interface UsageChannelRow {
  /** Channel name exactly as OpenRouter reported it ("Wafer", "DeepSeek", …). */
  name: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  sharePct: number;
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

export interface UsageProviderRow extends UsageTotals {
  provider: ProviderName;
  sharePct: number;
}

export interface UsageDailyRow extends UsageTotals {
  date: string;
}

export interface UsageRecentEvent {
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

export interface UsageReport {
  window: UsageWindow;
  since: number;
  generatedAt: number;
  totals: UsageTotals;
  byProvider: UsageProviderRow[];
  byAccount: UsageAccountRow[];
  byModel: UsageModelRow[];
  daily: UsageDailyRow[];
  recent: UsageRecentEvent[];
  coverage: {
    measuredRequests: number;
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
   * Fleet-level inventory slot. This gateway has none — the server always sends
   * `null` (`lib/usageLedger.ts`). Kept optional so the shape stays stable.
   */
  fleet?: null;
}

export async function fetchUsageReport(window: UsageWindow = "7d"): Promise<UsageReport> {
  const res = await fetch(`${API_BASE}/usage?window=${window}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function refreshUsagePrices(): Promise<{
  refreshed: boolean;
  source: string | null;
  fetchedAt: number | null;
  models: number;
}> {
  const res = await fetch(`${API_BASE}/usage/refresh-prices`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function resetUsageLedger(): Promise<{ reset: boolean }> {
  const res = await fetch(`${API_BASE}/usage/reset`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}
