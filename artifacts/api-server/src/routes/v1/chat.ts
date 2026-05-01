import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../lib/auth.js";
import { resolveProvider, isModelDisabled, getDefaultModel } from "../../lib/models.js";
import { getSettings } from "../../lib/settings.js";
import { callOpenAI } from "../../providers/openai.js";
import { callAnthropic } from "../../providers/anthropic.js";
import { callGemini } from "../../providers/gemini.js";
import { callOpenRouter } from "../../providers/openrouter.js";
import type { ChatCompletionRequest, StreamChunk } from "../../types.js";

const router = Router();

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

  try {
    let result: Awaited<ReturnType<typeof callOpenAI>>;

    switch (provider) {
      case "openai":
        result = await callOpenAI(request);
        break;
      case "anthropic":
        result = await callAnthropic(request);
        break;
      case "gemini":
        result = await callGemini(request);
        break;
      case "openrouter":
        result = await callOpenRouter(request);
        break;
      default:
        res.status(500).json({ error: { message: "Unknown provider" } });
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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err }, "Chat completion error");
    if (!res.headersSent) {
      res.status(502).json({ error: { message, type: "upstream_error" } });
    }
  }
});

export default router;
