import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../lib/auth.js";
import { resolveProvider, isModelDisabled } from "../../lib/models.js";
import { resolveProviderEndpoint, asUpstreamUnavailableError, type ProviderEndpoint } from "../../lib/providerEndpoint.js";
import { maybeDisableSelectedNode } from "../../lib/upstreamNodeFailure.js";
import { listImageOutputModels } from "../../lib/openrouterCatalog.js";
import type { ImageGenerationRequest, ImageGenerationResponse } from "../../types.js";

const router = Router();

// Pure image vendors (seedream, gpt-image, …) are NOT chat models, so OpenRouter
// never lists them in `/models`; these ids have to be pinned by hand. Everything
// else that can draw is discovered through the catalog's `output_modalities`
// (see `listImageOutputModels`).
const IMAGE_MODELS = new Set([
  "openai/gpt-image-2",
  "openai/gpt-5.4-image-2",
  "bytedance-seed/seedream-4.5",
]);

/**
 * Image-capable models this gateway knows about: the pinned vendor ids plus every
 * catalog entry whose output modality includes `image`. Catalog failures degrade
 * to the pinned set instead of breaking the endpoint.
 */
router.get("/v1/images/models", requireAuth, async (_req: Request, res: Response) => {
  const catalog = await listImageOutputModels();
  const data = [
    ...Array.from(IMAGE_MODELS).map((id) => ({ id, source: "pinned" as const })),
    ...catalog
      .filter((m) => !IMAGE_MODELS.has(m.id))
      .map((m) => ({ id: m.id, source: "catalog" as const, outputModalities: m.outputModalities })),
  ];
  res.json({ object: "list", data });
});

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
    // Not a registered OpenRouter model and not pinned: only a catalog card that
    // declares image output can still be served. Only reached on that slow path,
    // so the extra catalog lookup is not on the hot path.
    const catalogIds = new Set((await listImageOutputModels()).map((m) => m.id));
    if (!catalogIds.has(body.model)) {
      res.status(400).json({
        error: {
          message: `Model ${body.model} does not support image generation (see GET /v1/images/models for the list)`,
          type: "invalid_request",
        },
      });
      return;
    }
  }

  let endpoint: ProviderEndpoint;
  try {
    endpoint = resolveProviderEndpoint("openrouter");
  } catch (err) {
    // The pool is momentarily empty — every node is parked after an upstream
    // failure. Answer 503 with a Retry-After rather than letting the error
    // escape as an unhandled 500.
    const unavailable = asUpstreamUnavailableError(err);
    if (unavailable) {
      res.setHeader("Retry-After", String(unavailable.retryAfterSeconds));
      res.status(503).json({ error: { message: unavailable.message, type: "upstream_unavailable" } });
      return;
    }
    throw err;
  }
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
      maybeDisableSelectedNode({
        endpoint,
        provider: "openrouter",
        responseStatus: response.status,
        responseBody: text,
      });
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
