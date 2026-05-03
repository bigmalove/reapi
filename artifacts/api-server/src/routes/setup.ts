import { Router } from "express";
import { isReverseProxyActive } from "../lib/providerEndpoint.js";

const router = Router();

router.get("/api/setup-status", (_req, res) => {
  const reverseProxy = isReverseProxyActive();

  const envOk = {
    openai:     !!(process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] && process.env["AI_INTEGRATIONS_OPENAI_API_KEY"]),
    anthropic:  !!(process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"] && process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"]),
    gemini:     !!(process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"] && process.env["AI_INTEGRATIONS_GEMINI_API_KEY"]),
    openrouter: !!(process.env["AI_INTEGRATIONS_OPENROUTER_BASE_URL"] && process.env["AI_INTEGRATIONS_OPENROUTER_API_KEY"]),
  };

  // In reverse-proxy mode, all providers route through the upstream.
  const keys = {
    openai:     reverseProxy || envOk.openai,
    anthropic:  reverseProxy || envOk.anthropic,
    gemini:     reverseProxy || envOk.gemini,
    openrouter: reverseProxy || envOk.openrouter,
    proxyKey:   !!process.env["PROXY_API_KEY"],
  };

  const configured = Object.values(keys).some(Boolean);

  res.json({
    configured,
    providers: keys,
    reverseProxy,
  });
});

export default router;
