import { Router } from "express";
import {
  isReverseProxyActive,
  peekNextPoolIndex,
  resolveProviderSource,
  type ProviderEndpointSource,
  type ProviderName,
} from "../lib/providerEndpoint.js";
import { getSettings, type UpstreamNodeType } from "../lib/settings.js";

const router = Router();

const PROVIDERS: readonly ProviderName[] = ["openai", "anthropic", "gemini", "openrouter"];

router.get("/api/setup-status", (_req, res) => {
  const reverseProxy = isReverseProxyActive();
  const settings = getSettings();

  const sources = {} as Record<ProviderName, ProviderEndpointSource | null>;
  const keys = {} as Record<ProviderName, boolean>;
  for (const p of PROVIDERS) {
    const source = resolveProviderSource(p);
    sources[p] = source;
    keys[p] = source !== null;
  }

  const providers = {
    ...keys,
    proxyKey: !!process.env["PROXY_API_KEY"],
  };

  const configured = Object.values(providers).some(Boolean);

  const activeNodes = settings.reverseProxyPool.map((e) => {
    const hostname = new URL(e.url).hostname.toLowerCase();
    const type: UpstreamNodeType = hostname.endsWith(".replit.dev") ? "replit-dev" : "replit-app";
    return { url: e.url, type };
  });

  const disabledNodes = settings.disabledUpstreamNodes.map((e) => ({
    url: e.url,
    type: e.type,
    disabledReason: e.disabledReason,
  }));

  res.json({
    configured,
    providers,
    providerSources: sources,
    reverseProxy,
    pool: {
      size: settings.reverseProxyPool.length,
      mode: settings.reverseProxyMode,
      nextIndex: peekNextPoolIndex(),
    },
    nodes: {
      active: activeNodes,
      disabled: disabledNodes,
    },
  });
});

export default router;
