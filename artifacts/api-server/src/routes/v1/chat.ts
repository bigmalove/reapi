import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../lib/auth.js";
import { resolveProvider, isModelDisabled, getDefaultModel } from "../../lib/models.js";
import { getSettings } from "../../lib/settings.js";
import {
  callProvider,
  isNodeFault,
  MAX_ATTEMPTS,
  MAX_ATTEMPTS_NODE_FAULT,
} from "../../lib/providerDispatch.js";
import { logger } from "../../lib/logger.js";
import { runWithQuotaStrikeScope } from "../../lib/upstreamNodeFailure.js";
import { asUpstreamUnavailableError } from "../../lib/providerEndpoint.js";
import { asUpstreamHttpError, summarizeUpstreamError } from "../../lib/upstreamError.js";
import { looksLikeOutputLimitRejection, shrinkOutputBudget } from "../../lib/outputLimits.js";
import type { ChatCompletionRequest, StreamChunk } from "../../types.js";

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
  // Per-request override for the synthetic stream shim (on/off). Used for
  // A/B testing and client-side control; see lib/syntheticStreamShim.ts.
  "x-agw-stream-shim",
] as const;

function extractPassthroughHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PASSTHROUGH_HEADERS) {
    const v = req.headers[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

router.post("/v1/chat/completions", requireAuth, (req: Request, res: Response) =>
  // One request = one strike id, so the gateway's own replays across the pool
  // count as a single observation of "this node is throttled" rather than one
  // strike each. Without this a single request that replays six times could
  // evict a healthy node on a channel-wide rate limit.
  runWithQuotaStrikeScope(async () => {
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

  const dispatch = () => callProvider(provider, request, clientHeaders);

  let result: Awaited<ReturnType<typeof callProvider>> | undefined;
  let lastErr: unknown;

  for (let attempt = 1; ; attempt++) {
    try {
      result = await dispatch();
      break;
    } catch (err) {
      lastErr = err;
      // No endpoint exists right now (pool drained between attempts). Retrying
      // in the same millisecond cannot help — a replacement node needs seconds
      // to become usable — so stop and answer 503 + Retry-After.
      if (asUpstreamUnavailableError(err)) break;
      // The gateway defaults the output budget to each upstream's maximum; a
      // model that accepts less answers "max_tokens too large". Halve and replay.
      const upstream = asUpstreamHttpError(err);
      if (upstream && looksLikeOutputLimitRejection(upstream.status, upstream.body)) {
        const shrunk = shrinkOutputBudget(request);
        if (shrunk !== null) {
          logger.warn(
            { provider, to: shrunk },
            "upstream rejected the output budget — retrying with a smaller max_tokens",
          );
          continue;
        }
      }
      const limit = isNodeFault(err) ? MAX_ATTEMPTS_NODE_FAULT : MAX_ATTEMPTS;
      if (attempt >= limit) {
        logger.error({ err, attempt, limit, provider }, "all attempts exhausted");
        break;
      }
      logger.warn({ err, attempt, limit, provider }, "attempt failed, retrying");
      // Every pool node forwards to the same upstream channel, so a retry fired
      // in the same second lands inside the same throttling window and fails
      // again — six attempts in 7s have been observed dying on one wrapped
      // 429/quota-exhausted envelope. Back off exponentially so the window can
      // clear before the next node is tried.
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 8000)));
    }
  }

  if (result === undefined) {
    // Never hand a whole HTML placeholder page to the caller: it prints a
    // wall of markup and hides the real cause. Raw body is logged below.
    const message = summarizeUpstreamError(lastErr);
    const unavailable = asUpstreamUnavailableError(lastErr);
    req.log.error(
      { err: lastErr, retryAfterSeconds: unavailable?.retryAfterSeconds },
      "Chat completion error after all retries",
    );
    if (!res.headersSent) {
      if (unavailable) {
        // Temporary drain: tell the client when to come back instead of
        // returning a 502 that reads like a permanent gateway fault.
        res.setHeader("Retry-After", String(unavailable.retryAfterSeconds));
        res.status(503).json({ error: { message, type: "upstream_unavailable" } });
      } else {
        res.status(502).json({ error: { message, type: "upstream_error" } });
      }
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
  }),
);

export default router;
