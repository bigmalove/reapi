import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../lib/auth.js";
import { resolveProvider, isModelDisabled } from "../../lib/models.js";
import { resolveProviderEndpoint } from "../../lib/providerEndpoint.js";
import type { ImageGenerationRequest, ImageGenerationResponse } from "../../types.js";

const router = Router();

// Models that support image generation via OpenRouter
const IMAGE_MODELS = new Set([
  "openai/gpt-5.4-image-2",
  "bytedance-seed/seedream-4.5",
]);

router.post("/v1/images/generations", requireAuth, async (req: Request, res: Response) => {
  res.setTimeout(300_000);
  req.socket.setTimeout(300_000);

  const body = req.body as ImageGenerationRequest;

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
  if (provider !== "openrouter" && !IMAGE_MODELS.has(body.model)) {
    res.status(400).json({ error: { message: `Model ${body.model} does not support image generation` } });
    return;
  }

  const endpoint = resolveProviderEndpoint("openrouter");
  const { baseUrl, apiKey } = endpoint;
  const url = `${baseUrl}/images/generations`;

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
      req.log.error({ status: response.status, body: text }, "Image generation error");
      res.status(502).json({ error: { message: `Upstream error ${response.status}: ${text}`, type: "upstream_error" } });
      return;
    }

    const result = (await response.json()) as ImageGenerationResponse;
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err }, "Image generation error");
    if (!res.headersSent) {
      res.status(502).json({ error: { message, type: "upstream_error" } });
    }
  }
});

export default router;
