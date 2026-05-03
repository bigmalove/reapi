import { getSettings } from "./settings.js";

export type ProviderName = "openai" | "anthropic" | "gemini" | "openrouter";

export interface ProviderEndpoint {
  baseUrl: string;
  apiKey: string;
  source: "reverse-proxy" | "local-env";
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

/**
 * Resolve the upstream endpoint for a provider.
 *
 * - If reverse-proxy mode is enabled and a URL is configured, returns
 *   `<url>/modelfarm/<segment>` plus the configured upstream API key.
 * - Otherwise falls back to the local Replit AI Integration env vars.
 *
 * Throws when neither source is available.
 */
export function resolveProviderEndpoint(provider: ProviderName): ProviderEndpoint {
  const settings = getSettings();
  if (settings.reverseProxyEnabled && settings.reverseProxyUrl) {
    const base = settings.reverseProxyUrl.replace(/\/+$/, "");
    return {
      baseUrl: `${base}/modelfarm/${UPSTREAM_SEGMENT[provider]}`,
      apiKey: settings.reverseProxyApiKey ?? "",
      source: "reverse-proxy",
    };
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
  return !!(s.reverseProxyEnabled && s.reverseProxyUrl);
}
