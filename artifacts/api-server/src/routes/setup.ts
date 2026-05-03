import { Router } from "express";
import {
  isReverseProxyActive,
  resolveProviderSource,
  type ProviderEndpointSource,
  type ProviderName,
} from "../lib/providerEndpoint.js";
import { getSettings } from "../lib/settings.js";

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

  res.json({
    configured,
    providers,
    providerSources: sources,
    reverseProxy,
    pool: {
      size: settings.reverseProxyPool.length,
      mode: settings.reverseProxyMode,
    },
  });
});

export default router;
