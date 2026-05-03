import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth.js";

type AuthMode = "bearer" | "x-api-key" | "x-goog-api-key";

interface UpstreamConfig {
  baseUrlEnv: string;
  apiKeyEnv: string;
  authMode: AuthMode;
}

const UPSTREAM: Record<string, UpstreamConfig> = {
  openai: {
    baseUrlEnv: "AI_INTEGRATIONS_OPENAI_BASE_URL",
    apiKeyEnv: "AI_INTEGRATIONS_OPENAI_API_KEY",
    authMode: "bearer",
  },
  anthropic: {
    baseUrlEnv: "AI_INTEGRATIONS_ANTHROPIC_BASE_URL",
    apiKeyEnv: "AI_INTEGRATIONS_ANTHROPIC_API_KEY",
    authMode: "x-api-key",
  },
  google: {
    baseUrlEnv: "AI_INTEGRATIONS_GEMINI_BASE_URL",
    apiKeyEnv: "AI_INTEGRATIONS_GEMINI_API_KEY",
    authMode: "x-goog-api-key",
  },
  openrouter: {
    baseUrlEnv: "AI_INTEGRATIONS_OPENROUTER_BASE_URL",
    apiKeyEnv: "AI_INTEGRATIONS_OPENROUTER_API_KEY",
    authMode: "bearer",
  },
};

export const SEGMENTS = Object.keys(UPSTREAM);

export interface SegmentStatus {
  segment: string;
  configured: boolean;
  baseUrlEnv: string;
  apiKeyEnv: string;
}

export function listSegmentStatus(): SegmentStatus[] {
  return SEGMENTS.map((segment) => {
    const cfg = UPSTREAM[segment]!;
    return {
      segment,
      configured: !!process.env[cfg.baseUrlEnv] && !!process.env[cfg.apiKeyEnv],
      baseUrlEnv: cfg.baseUrlEnv,
      apiKeyEnv: cfg.apiKeyEnv,
    };
  });
}

const router: IRouter = Router();

router.use(requireAuth);

router.use(async (req: Request, res: Response) => {
  const match = req.path.match(/^\/([^/]+)(\/.*)?$/);
  if (!match) {
    res.status(404).json({ error: { message: "Not found", type: "not_found" } });
    return;
  }
  const segment = match[1]!;
  const rest = match[2] ?? "/";
  const cfg = UPSTREAM[segment];
  if (!cfg) {
    res.status(404).json({
      error: {
        message: `Unknown upstream segment "${segment}". Expected one of: ${SEGMENTS.join(", ")}.`,
        type: "not_found",
      },
    });
    return;
  }

  const baseUrl = process.env[cfg.baseUrlEnv];
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!baseUrl || !apiKey) {
    res.status(503).json({
      error: {
        message: `Upstream "${segment}" is not configured. Set ${cfg.baseUrlEnv} and ${cfg.apiKeyEnv}.`,
        type: "upstream_not_configured",
      },
    });
    return;
  }

  const qIdx = req.originalUrl.indexOf("?");
  const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx) : "";
  const targetUrl = `${baseUrl.replace(/\/+$/, "")}${rest}${qs}`;

  const headers: Record<string, string> = {};
  const incomingCT = req.headers["content-type"];
  if (typeof incomingCT === "string") headers["Content-Type"] = incomingCT;
  const accept = req.headers["accept"];
  if (typeof accept === "string") headers["Accept"] = accept;

  switch (cfg.authMode) {
    case "bearer":
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "x-api-key": {
      headers["x-api-key"] = apiKey;
      const av = req.headers["anthropic-version"];
      headers["anthropic-version"] = typeof av === "string" ? av : "2023-06-01";
      const beta = req.headers["anthropic-beta"];
      if (typeof beta === "string") headers["anthropic-beta"] = beta;
      break;
    }
    case "x-goog-api-key":
      headers["x-goog-api-key"] = apiKey;
      break;
  }

  res.setTimeout(600_000);
  req.socket.setTimeout(600_000);

  let body: Buffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (Buffer.isBuffer(req.body)) {
      body = req.body;
    } else if (typeof req.body === "string") {
      body = Buffer.from(req.body, "utf-8");
    }
  }

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });
  } catch (err) {
    req.log.error({ err, segment, targetUrl }, "Upstream fetch failed");
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : "Upstream fetch failed",
        type: "upstream_error",
      },
    });
    return;
  }

  res.status(upstream.status);
  const upCT = upstream.headers.get("content-type");
  if (upCT) res.setHeader("Content-Type", upCT);
  const cacheCtrl = upstream.headers.get("cache-control");
  if (cacheCtrl) res.setHeader("Cache-Control", cacheCtrl);

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  res.flushHeaders?.();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && !res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => res.once("drain", () => resolve()));
      }
    }
  } catch (err) {
    req.log.error({ err, segment }, "Upstream stream error");
  } finally {
    res.end();
  }
});

export default router;
