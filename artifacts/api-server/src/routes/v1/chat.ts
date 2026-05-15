import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../lib/auth.js";
import { resolveProvider, isModelDisabled, getDefaultModel } from "../../lib/models.js";
import { getSettings } from "../../lib/settings.js";
import { callOpenAI } from "../../providers/openai.js";
import { callAnthropic } from "../../providers/anthropic.js";
import { callGemini } from "../../providers/gemini.js";
import { callOpenRouter } from "../../providers/openrouter.js";
import { logger } from "../../lib/logger.js";
import type { ChatCompletionRequest, StreamChunk } from "../../types.js";

const MAX_ATTEMPTS = 3;

const router = Router();

// Whitelisted client request headers to forward to upstream providers.
// Anything outside this list is dropped at the gateway. The whitelist is
// upstream-agnostic; each provider picks the headers it cares about.
const PASSTHROUGH_HEADERS = [
  "anthropic-beta",
  "anthropic-version",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "x-goog-api-client",
] as const;

function extractPassthroughHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PASSTHROUGH_HEADERS) {
    const v = req.headers[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

router.post("/v1/chat/completions", requireAuth, async (req: Request, res: Response) => {
  // Allow up to 600 seconds for model generation
  res.setTimeout(600_000);
  req.socket.setTimeout(600_000);

  const body = req.body as ChatCompletionRequest;

  if (!body.messages || !Array.isArray(body.messages)) {
    res.status(400).json({ error: { message: "messages is required" } });
    return;
  }

  let model = body.model || getDefaultModel();

  if (isModelDisabled(model)) {
    res.status(400).json({ error: { message: `Model ${model} is disabled` } });
    return;
  }

  const provider = resolveProvider(model);
  if (!provider) {
    res.status(400).json({ error: { message: `Unknown model: ${model}` } });
    return;
  }

  const settings = getSettings();
  const messages = [...body.messages];

  if (
    settings.sillyTavernMode &&
    provider === "anthropic" &&
    (!body.tools || body.tools.length === 0)
  ) {
    messages.push({ role: "user", content: "继续" });
  }

  const request: ChatCompletionRequest = { ...body, model, messages };
  const clientHeaders = extractPassthroughHeaders(req);

  async function callProvider() {
    switch (provider) {
      case "openai":      return callOpenAI(request, clientHeaders);
      case "anthropic":   return callAnthropic(request, clientHeaders);
      case "gemini":      return callGemini(request, clientHeaders);
      case "openrouter":  return callOpenRouter(request, clientHeaders);
      default:            throw new Error("Unknown provider");
    }
  }

  let result: Awaited<ReturnType<typeof callOpenAI>> | undefined;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      result = await callProvider();
      break;
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        logger.warn({ err, attempt, maxAttempts: MAX_ATTEMPTS, provider }, `attempt ${attempt} failed, retrying with next node`);
      } else {
        logger.error({ err, attempt, provider }, "all attempts exhausted");
      }
    }
  }

  if (result === undefined) {
    const message = lastErr instanceof Error ? lastErr.message : "Unknown error";
    req.log.error({ err: lastErr }, "Chat completion error after all retries");
    if (!res.headersSent) {
      res.status(502).json({ error: { message, type: "upstream_error" } });
    }
    return;
  }

  if (body.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
      for await (const chunk of result as AsyncIterable<StreamChunk>) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
    } catch (streamErr) {
      const message = streamErr instanceof Error ? streamErr.message : "Stream error";
      req.log.error({ err: streamErr }, "Stream error during chat completion");
      res.write(`data: ${JSON.stringify({ error: { message, type: "stream_error" } })}\n\n`);
    } finally {
      res.end();
    }
  } else {
    res.json(result);
  }
});

export default router;
