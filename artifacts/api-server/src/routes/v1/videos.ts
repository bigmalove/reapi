import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../lib/auth.js";
import { resolveProvider, isModelDisabled } from "../../lib/models.js";
import { resolveProviderEndpoint } from "../../lib/providerEndpoint.js";
import { maybeDisableSelectedNode } from "../../lib/upstreamNodeFailure.js";
import type { VideoGenerationRequest, VideoGenerationResponse } from "../../types.js";

const router = Router();

// Models that support video generation via OpenRouter
const VIDEO_MODELS = new Set([
  "bytedance/seedance-2.0",
  "bytedance/seedance-2.0-fast",
  "kwaivgi/kling-v3.0-pro",
]);

router.post("/v1/videos/generations", requireAuth, async (req: Request, res: Response) => {
  // Video generation can take a long time
  res.setTimeout(600_000);
  req.socket.setTimeout(600_000);

  const body = req.body as VideoGenerationRequest;

  if (!body.prompt || typeof body.prompt !== "string") {
    res.status(400).json({ error: { message: "prompt is required" } });
    return;
  }

  if (!body.model) {
    res.status(400).json({ error: { message: "model is required" } });
    return;
  }

  if (isModelDisabled(body.model)) {
    res.status(400).json({ error: { message: `Model ${body.model} is disabled` } });
    return;
  }

  const provider = resolveProvider(body.model);
  if (provider !== "openrouter" && !VIDEO_MODELS.has(body.model)) {
    res.status(400).json({ error: { message: `Model ${body.model} does not support video generation` } });
    return;
  }

  const endpoint = resolveProviderEndpoint("openrouter");
  const { baseUrl, apiKey } = endpoint;
  const url = `${baseUrl}/videos/generations`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://replit.com",
        "X-Title": "AI Gateway",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      maybeDisableSelectedNode({ endpoint, responseStatus: response.status, responseBody: text });
      req.log.error({ status: response.status, body: text }, "Video generation error");
      res.status(502).json({ error: { message: `Upstream error ${response.status}: ${text}`, type: "upstream_error" } });
      return;
    }

    const result = (await response.json()) as VideoGenerationResponse;
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err }, "Video generation error");
    if (!res.headersSent) {
      res.status(502).json({ error: { message, type: "upstream_error" } });
    }
  }
});

// Poll video generation job status
router.get("/v1/videos/generations/:id", requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;

  const endpoint = resolveProviderEndpoint("openrouter");
  const { baseUrl, apiKey } = endpoint;
  const url = `${baseUrl}/videos/generations/${id}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://replit.com",
        "X-Title": "AI Gateway",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      maybeDisableSelectedNode({ endpoint, responseStatus: response.status, responseBody: text });
      req.log.error({ status: response.status, body: text }, "Video status check error");
      res.status(502).json({ error: { message: `Upstream error ${response.status}: ${text}`, type: "upstream_error" } });
      return;
    }

    const result = (await response.json()) as VideoGenerationResponse;
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err }, "Video status check error");
    if (!res.headersSent) {
      res.status(502).json({ error: { message, type: "upstream_error" } });
    }
  }
});

export default router;
