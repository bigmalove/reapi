import { getSettings, type ProviderName, type PoolEntry } from "./settings.js";

export type { ProviderName };

export type ProviderEndpointSource = "upstream" | "local-env" | "per-provider override";

export interface ProviderEndpoint {
  baseUrl: string;
  apiKey: string;
  source: ProviderEndpointSource;
  upstreamIndex?: number; // 0-based pool index when source === "upstream"
  poolSize?: number;
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

function pickPoolIndex(pool: PoolEntry[], mode: "round-robin" | "sticky"): number {
  if (pool.length === 0) return -1;
  if (mode === "sticky") return 0;
  const idx = rrCursor % pool.length;
  rrCursor = (rrCursor + 1) % Number.MAX_SAFE_INTEGER;
  return idx;
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
      return {
        baseUrl: `${entry.url}/modelfarm/${UPSTREAM_SEGMENT[provider]}`,
        apiKey: entry.apiKey || defaultKey,
        source: "upstream",
        upstreamIndex: idx,
        poolSize: settings.reverseProxyPool.length,
      };
    }
  }

  const envKeys = ENV_BY_PROVIDER[provider];
  const baseUrl = process.env[envKeys.baseUrl];
  const apiKey = process.env[envKeys.apiKey];
  if (!baseUrl || !apiKey) {
    throw new Error(
      `Provider "${provider}" is not configured. Either set ${envKeys.baseUrl} and ${envKeys.apiKey}, or enable reverse-proxy mode in the admin portal.`,
    );
  }
  return { baseUrl, apiKey, source: "local-env" };
}

export function isReverseProxyActive(): boolean {
  const s = getSettings();
  if (!s.reverseProxyEnabled) return false;
  if (s.reverseProxyPool.length > 0) return true;
  return Object.values(s.providerOverrides).some((o) => !!o.url);
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
