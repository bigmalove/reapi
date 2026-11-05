import type { ChatCompletionRequest, ChatCompletionResponse, StreamChunk } from "../types.js";
import { resolveProviderEndpoint, type ProviderEndpoint } from "../lib/providerEndpoint.js";
import { handleEmptyUpstreamStream, maybeDisableSelectedNode } from "../lib/upstreamNodeFailure.js";
import { UpstreamHttpError } from "../lib/upstreamError.js";
import { clampIdentityFields } from "../lib/claudeCode.js";
import { resolveMaxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS } from "../lib/outputLimits.js";
import { logger } from "../lib/logger.js";
import {
  planSyntheticStreamShim,
  resolveShimEnabled,
  wrapSyntheticToolStream,
} from "../lib/syntheticStreamShim.js";
import { recordUsage, tapStreamUsage } from "../lib/usageLedger.js";
import {
  getSettings,
  OPENROUTER_ROUTING_SUFFIXES,
  hasModelVariantSuffix,
} from "../lib/settings.js";
import { cachedImageOutputCapability, warmCatalog } from "../lib/openrouterCatalog.js";

/**
 * Upstream-channel gate for OpenRouter.
 *
 * A pool node is not an account with its own budget: every node forwards to the
 * same OpenRouter key and channel. A wrapped 429 (`quota-exhausted` with
 * `upstreamStatus: 429`) is therefore a property of the CHANNEL, not of the node,
 * and rotating to the next node simply re-enters the same throttling window.
 * Concurrent agent turns make it worse — each one fans out over a fresh node and
 * they all report the channel as dead.
 *
 * Requests to a throttled model now queue for a few seconds instead of fanning
 * out, which is what makes concurrent traffic survivable. The window is capped:
 * a channel that stays saturated must still fail fast rather than hold callers
 * forever.
 *
 * Secondary gate, same reason: every waiter waking from its `setTimeout` in the
 * same tick hits the channel together again (measured — five concurrent turns
 * resumed within 3ms of each other). Handing out dispatch slots on a schedule
 * keeps the burst flat instead.
 */
const CHANNEL_COOLDOWN_MAX_MS = 8000;
const CHANNEL_COOLDOWN_DEFAULT_MS = 2000;
const CHANNEL_SPACING_MS = 400;
const channelCooldownUntil = new Map<string, number>();
const nextDispatchAt = new Map<string, number>();

async function waitForChannel(model: string): Promise<void> {
  const now = Date.now();
  const readyAt = Math.max(
    now,
    channelCooldownUntil.get(model) ?? 0,
    nextDispatchAt.get(model) ?? 0,
  );
  nextDispatchAt.set(model, readyAt + CHANNEL_SPACING_MS);
  const waitMs = readyAt - now;
  if (waitMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, CHANNEL_COOLDOWN_MAX_MS)));
}

function markChannelThrottled(model: string, retryAfterSeconds: number | null): void {
  const waitMs =
    retryAfterSeconds && retryAfterSeconds > 0
      ? Math.min(retryAfterSeconds * 1000, CHANNEL_COOLDOWN_MAX_MS)
      : CHANNEL_COOLDOWN_DEFAULT_MS;
  const until = Date.now() + waitMs;
  if (until > (channelCooldownUntil.get(model) ?? 0)) channelCooldownUntil.set(model, until);
  logger.info(
    { model, cooldownMs: waitMs, retryAfterSeconds },
    "openrouter channel reported throttling — queueing further dispatches to this model",
  );
}

/**
 * A node reports a throttled channel as HTTP 502 wrapping the upstream status,
 * so the body — not the response status — decides.
 */
function isWrappedThrottle(status: number, body: string): boolean {
  if (status !== 502 && status !== 429) return false;
  return /"upstreamStatus"\s*:\s*429/.test(body) || body.includes("quota-exhausted");
}

// Map Bedrock/* shorthand IDs to real OpenRouter model IDs
const BEDROCK_MODEL_MAP: Record<string, string> = {
  "Bedrock/claude-4.7-opus":           "anthropic/claude-opus-4.7",
  "Bedrock/claude-4.7-opus-thinking":  "anthropic/claude-opus-4.7",
  "Bedrock/claude-4.6-opus":           "anthropic/claude-opus-4.6",
  "Bedrock/claude-4.6-opus-thinking":  "anthropic/claude-opus-4.6",
  "Bedrock/claude-fable-5":            "anthropic/claude-fable-5",
  "Bedrock/claude-fable-5-thinking":   "anthropic/claude-fable-5",
};

function resolveBedrockAlias(modelId: string): { model: string; forceThinking: boolean } {
  if (BEDROCK_MODEL_MAP[modelId]) {
    return {
      model: BEDROCK_MODEL_MAP[modelId],
      forceThinking: modelId.endsWith("-thinking"),
    };
  }
  return { model: modelId, forceThinking: false };
}

function isClaudeModel(modelId: string): boolean {
  return modelId.includes("claude") || modelId.startsWith("anthropic/");
}

function isDeepSeekModel(modelId: string): boolean {
  return modelId.startsWith("deepseek/");
}

/**
 * Heuristic used only when the catalog cache is cold. Every drawing model
 * OpenRouter ships carries `image` in its slug (`google/gemini-3.1-flash-image`,
 * `openai/gpt-5-image`, `gpt-image-2`, `nano-banana`). `openrouter/auto` is
 * excluded on purpose: it *can* return images, but forcing image output on the
 * router would hijack ordinary text traffic routed through it.
 */
const IMAGE_OUTPUT_ID = /(?:^|[-/])image(?:$|[-.:_])|nano-banana/i;

export function looksLikeImageOutputModel(modelId: string): boolean {
  if (modelId.startsWith("openrouter/auto")) return false;
  return IMAGE_OUTPUT_ID.test(modelId);
}

export async function callOpenRouter(
  request: ChatCompletionRequest,
  clientHeaders: Record<string, string> = {},
): Promise<ChatCompletionResponse | AsyncIterable<StreamChunk>> {
  const endpoint = resolveProviderEndpoint("openrouter");
  const { baseUrl, apiKey } = endpoint;

  // Replit integration proxy doesn't include /v1 in path
  const url = `${baseUrl}/chat/completions`;

  // Extract effort-level suffix before alias resolution: model-thinking-{effort}
  const EFFORT_LEVELS = ["max", "xhigh", "high", "medium", "low"] as const;
  let rawModel = request.model;
  let explicitEffort: string | null = null;

  for (const level of EFFORT_LEVELS) {
    if (rawModel.endsWith(`-thinking-${level}`)) {
      explicitEffort = level;
      // Rewrite to -thinking so Bedrock alias resolution still works
      rawModel = rawModel.slice(0, rawModel.length - level.length - 1); // strips "-{level}", leaves "-thinking"
      break;
    }
  }

  // Strip leading ~ (deprecated alias marker) before further resolution
  if (rawModel.startsWith("~")) {
    rawModel = rawModel.slice(1);
  }

  // Resolve Bedrock/* shorthand aliases
  const { model: resolvedFromAlias, forceThinking } = resolveBedrockAlias(rawModel);

  // Strip remaining -thinking / -thinking-visible suffix
  let actualModel = resolvedFromAlias;
  let thinkingEnabled = forceThinking || explicitEffort !== null;
  if (actualModel.endsWith("-thinking-visible") || actualModel.endsWith("-thinking")) {
    thinkingEnabled = true;
    actualModel = actualModel
      .replace(/-thinking-visible$/, "")
      .replace(/-thinking$/, "");
  }

  const isClaude = isClaudeModel(actualModel);
  const isDeepSeek = isDeepSeekModel(actualModel);

  // OpenAI reasoning models on OpenRouter (gpt-5.x, gpt-5.x-pro, o-series)
  const isOpenAIReasoningModel = /^openai\/(gpt-5(\.\d+)?(-pro|-mini|-nano)?|o\d[\w-]*)$/.test(actualModel);

  // Models using adaptive thinking API (effort-based) via OpenRouter/Bedrock.
  // actualModel is the resolved OpenRouter model ID (after Bedrock alias lookup).
  // Matched by model-family prefix rather than exact id so point releases and
  // dated ids added at runtime from the OpenRouter catalog (e.g.
  // anthropic/claude-fable-5.1) get `output_config.effort` instead of the
  // legacy `budget_tokens` these models reject.
  const ADAPTIVE_THINKING_PREFIXES = [
    "anthropic/claude-opus-5",
    "anthropic/claude-opus-4.7",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-fable-5",
    "anthropic/claude-fable-latest",
    "anthropic/claude-sonnet-5",
  ];
  const usesAdaptiveThinking = ADAPTIVE_THINKING_PREFIXES.some(
    (prefix) =>
      actualModel === prefix ||
      actualModel.startsWith(`${prefix}.`) ||
      actualModel.startsWith(`${prefix}-`),
  );

  // Build the request body
  const body: Record<string, unknown> = {
    ...request,
    model: actualModel,
  };

  // No client budget → hand the model the maximum. Leaving the field out made
  // every upstream fall back to its own (small) default, which is how thinking
  // models ended up burning the whole allowance before writing a first token.
  if (typeof body["max_tokens"] !== "number") {
    body["max_tokens"] = DEFAULT_MAX_OUTPUT_TOKENS;
  }

  // Image output. OpenRouter only returns a picture from `chat/completions` when
  // the request declares `modalities`; without it the very same model answers in
  // text, which reads as "this gateway has no drawing model". Never override a
  // client that already picked its own modality list.
  if (body["modalities"] === undefined) {
    const fromCatalog = cachedImageOutputCapability(actualModel);
    if (fromCatalog === null) warmCatalog();
    if (fromCatalog ?? looksLikeImageOutputModel(actualModel)) {
      body["modalities"] = ["image", "text"];
      logger.info(
        { model: actualModel, source: fromCatalog === null ? "id-heuristic" : "catalog" },
        "openrouter image output requested via modalities",
      );
    }
  }

  // Claude routing. `amazon-bedrock/claude-on-aws` is not a valid OpenRouter
  // provider slug — the real endpoint tags are `amazon-bedrock`,
  // `claude-on-aws`, `anthropic`, `azure/global`, `google-vertex/…`. Pinning an
  // id that does not exist, with fallbacks disabled, made OpenRouter reject
  // every request for models it could not match on that one channel
  // (`anthropic/claude-opus-5.5` arrived as a gateway 502). Prefer Bedrock for
  // cost, but let OpenRouter fall back to the other Claude channels.
  if (isClaude) {
    body["provider"] = {
      order: ["amazon-bedrock", "claude-on-aws", "anthropic"],
      allow_fallbacks: true,
    };
  }

  // Force DeepSeek provider channel for deepseek-v4-pro
  if (actualModel === "deepseek/deepseek-v4-pro") {
    body["provider"] = {
      order: ["deepseek"],
      allow_fallbacks: false,
    };
  }

  // Force Tencent provider channel for hy3
  if (actualModel === "tencent/hy3") {
    body["provider"] = {
      order: ["tencent"],
      allow_fallbacks: false,
    };
  }

  // Force Fireworks fast endpoint for GLM-5.2
  if (actualModel === "z-ai/glm-5.2") {
    body["provider"] = {
      order: ["fireworks/fast"],
      allow_fallbacks: false,
    };
  }

  // Force OpenAI (not Azure) for OpenAI reasoning models routed via OpenRouter
  if (isOpenAIReasoningModel) {
    body["provider"] = {
      order: ["OpenAI"],
      allow_fallbacks: false,
    };

    // OpenAI reasoning models reject these params
    delete body["temperature"];
    delete body["top_p"];
    delete body["presence_penalty"];
    delete body["frequency_penalty"];
    delete body["logit_bias"];
    delete body["logprobs"];
    delete body["top_logprobs"];

    // OpenAI uses max_completion_tokens (not max_tokens) for reasoning models
    if (body["max_tokens"] !== undefined) {
      body["max_completion_tokens"] = body["max_tokens"];
      delete body["max_tokens"];
    }

    // Apply reasoning_effort from -thinking-{level} suffix
    if (thinkingEnabled) {
      const EFFORT_MAP_OAI: Record<string, string> = {
        low:    "low",
        medium: "medium",
        high:   "high",
        xhigh:  "xhigh",
        max:    "xhigh",
      };
      body["reasoning_effort"] = explicitEffort ? (EFFORT_MAP_OAI[explicitEffort] ?? "high") : "high";
    }
  }

  // NOTE: Replit AI Integration proxy strips the `provider` routing field for
  // some providers (e.g. DeepSeek). OpenAI/Bedrock routing has been observed to work.

  const maxTokens = resolveMaxOutputTokens(request.max_tokens);

  function budgetToEffort(budget: number): string {
    if (budget >= 20000) return "max";
    if (budget >= 14000) return "xhigh";
    if (budget >= 8000) return "high";
    if (budget >= 3000) return "medium";
    return "low";
  }

  function effortToTokens(effort: string, max: number): number {
    switch (effort) {
      case "max":    return Math.floor(max * 0.95);
      case "xhigh":  return Math.min(Math.floor(max * 0.9), 20000);
      case "high":   return Math.min(Math.floor(max * 0.8), 14000);
      case "medium": return Math.min(Math.floor(max * 0.5), 8000);
      case "low":    return Math.min(Math.floor(max * 0.3), 3000);
      default:       return Math.floor(max * 0.8);
    }
  }

  // claude-opus-4.7 deprecates temperature/top_p/top_k entirely (thinking or not)
  if (usesAdaptiveThinking) {
    delete body["temperature"];
    delete body["top_p"];
    delete body["top_k"];
  }

  // Claude thinking goes through OpenRouter's unified `reasoning` object. The
  // Chat Completions endpoint ignores Anthropic-native `thinking` /
  // `output_config` (those belong to OpenRouter's Messages API form), so
  // sending them silently left the model at its default effort. OpenRouter
  // re-emits `reasoning.effort` as `output_config.effort` for Claude (all of
  // low/medium/high/xhigh/max are accepted) and `reasoning.max_tokens` as
  // `budget_tokens` for legacy models.
  if (usesAdaptiveThinking && thinkingEnabled) {
    const budgetTokens = Math.floor(maxTokens * 0.8);
    const effort = explicitEffort ?? budgetToEffort(budgetTokens);
    body["reasoning"] = { effort };
  } else if (thinkingEnabled && isDeepSeek) {
    // DeepSeek uses OpenAI-compatible format:
    //   thinking: { type: "enabled" }  — enable thinking mode
    //   reasoning_effort: "high"|"max" — control intensity
    // Per DeepSeek docs: low/medium → high, xhigh → max
    // OpenRouter reasoning_effort enum: xhigh | high | medium | low | minimal | none
    // DeepSeek docs say xhigh→max, but OpenRouter doesn't accept "max" — use "xhigh" as ceiling
    const DEEPSEEK_EFFORT_MAP: Record<string, string> = {
      low:    "low",
      medium: "medium",
      high:   "high",
      xhigh:  "xhigh",
      max:    "xhigh",
    };
    const effort = explicitEffort
      ? (DEEPSEEK_EFFORT_MAP[explicitEffort] ?? "high")
      : "high";
    body["thinking"] = { type: "enabled" };
    body["reasoning_effort"] = effort;
    // DeepSeek's OpenAI-style API counts reasoning tokens against `max_tokens`.
    // A client budget that is small (or a hard task that thinks for a long time)
    // is consumed entirely by reasoning, and the model then returns
    // finish_reason "length" with ZERO content — which the client renders as
    // "已达到输出 token 上限，回答被截断" over an empty answer. Leave headroom for
    // the visible answer, mirroring what the Anthropic path already does with
    // its budget_tokens + 1024 floor.
    const THINKING_FLOOR = 16000;
    if (typeof body["max_tokens"] === "number" && (body["max_tokens"] as number) < THINKING_FLOOR) {
      logger.info(
        { model: actualModel, from: body["max_tokens"], to: THINKING_FLOOR },
        "deepseek thinking: raising max_tokens so reasoning cannot consume the whole budget",
      );
      body["max_tokens"] = THINKING_FLOOR;
    }
  } else if (thinkingEnabled && isClaude) {
    // Legacy Claude budget_tokens thinking (pre-adaptive families).
    // OpenRouter forwards `reasoning.max_tokens` to Anthropic as budget_tokens,
    // which must be >= 1024 and below max_tokens; ensure max_tokens is high enough.
    const effectiveMax = Math.max(maxTokens, 2048);
    if (effectiveMax !== maxTokens) body["max_tokens"] = effectiveMax;
    const rawBudget = explicitEffort
      ? effortToTokens(explicitEffort, effectiveMax)
      : Math.floor(effectiveMax * 0.8);
    const budgetTokens = Math.max(rawBudget, 1024);
    body["reasoning"] = { max_tokens: budgetTokens };
    delete body["temperature"];
  } else if (thinkingEnabled && !isOpenAIReasoningModel) {
    // Any other model (Qwen, GLM, Kimi, Grok, Gemini, … added from the
    // OpenRouter catalog): use OpenRouter's unified `reasoning.effort`.
    // Most of these are effort-only — their catalog `reasoning` descriptor
    // lists `supported_efforts` without `supports_max_tokens` — so the
    // Anthropic-style `reasoning.max_tokens` budget we used to send here was
    // ignored and the model stayed at its default effort (e.g.
    // qwen/qwen3.8-max-0902 defaults to `xhigh` with reasoning mandatory).
    // OpenRouter converts effort → budget itself for budget-only models, and
    // maps an effort the model lacks to its nearest supported level (per its
    // reasoning docs), so the level is passed through unchanged: `max` reaches
    // models that accept it (moonshotai/kimi-k3: max/high/low) and is snapped
    // to `xhigh` on those that don't (qwen/qwen3.8-max-0902).
    body["reasoning"] = { effort: explicitEffort ?? "high" };
  }

  // Antigravity-Gateway synthetic transport: Google models on OpenRouter
  // buffer the whole tool call (function arguments arrive as one chunk), so a
  // wrapped answer would reach the client only at the end. When this is a pure
  // text wrapper request, ask the model for plain text instead and re-encode
  // the streamed text into incremental tool_call argument deltas — the client
  // sees the same incremental tool stream an upstream with
  // streamFunctionCallArguments would produce. Non-matching requests are
  // untouched. Toggleable: portal setting (default on), `SYNTHETIC_STREAM_SHIM`
  // env override, per-request `x-agw-stream-shim: on|off` header override.
  // See lib/syntheticStreamShim.ts.
  const shim =
    request.stream && resolveShimEnabled(clientHeaders["x-agw-stream-shim"])
      ? planSyntheticStreamShim(body)
      : null;
  const outboundBody = shim ? shim.body : body;
  // Keep identity fields inside the 32-byte cap some upstreams enforce.
  clampIdentityFields(outboundBody as Record<string, unknown>);

  // Routing tier. The suffix goes on the OUTGOING id only — `actualModel`
  // stays bare so the price snapshot still resolves it (`…-1017:floor` is not a
  // catalog entry) and so `usage.byModel` does not fragment per tier.
  //
  // Note this is the one routing control that survives a pool node: the node
  // forwards our model string verbatim, whereas a `provider` object in the body
  // is stripped before it reaches OpenRouter.
  const routingTier = getSettings().openRouterRoutingTier;
  if (routingTier !== "auto" && !hasModelVariantSuffix(actualModel)) {
    (outboundBody as Record<string, unknown>)["model"] =
      `${actualModel}${OPENROUTER_ROUTING_SUFFIXES[routingTier]}`;
  }

  const outboundHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    // Pool nodes choose between their SSE path and the non-streaming
    // keep-alive heartbeat path based on this header. A streaming request
    // forwarded without `text/event-stream` takes the heartbeat path: the
    // node flushes a bare 200 + "\n" at its 10s grace deadline and the real
    // stream never reaches us (the client sees an empty reply). Announce SSE
    // whenever we intend to stream; non-streaming requests keep the
    // heartbeat path that exists to survive the 300s idle proxy timeout.
    ...(request.stream ? { Accept: "text/event-stream" } : {}),
    "HTTP-Referer": "https://replit.com",
    "X-Title": "AI Gateway",
    // Forward Anthropic / OpenAI beta headers when the caller asks for them —
    // OpenRouter passes them through to the underlying upstream.
    ...(clientHeaders["anthropic-beta"]
      ? { "anthropic-beta": clientHeaders["anthropic-beta"] }
      : {}),
    ...(clientHeaders["openai-beta"] ? { "OpenAI-Beta": clientHeaders["openai-beta"] } : {}),
  };

  // Queue behind any channel that just throttled this model: whichever node we
  // pick next forwards to that same channel, so sending immediately only adds
  // another 429 to the pile.
  await waitForChannel(actualModel);

  const response = await fetch(url, {
    method: "POST",
    headers: outboundHeaders,
    body: JSON.stringify(outboundBody),
  });

  if (!response.ok) {
    const text = await response.text();
    const retryAfterHeader = Number(response.headers.get("retry-after"));
    if (isWrappedThrottle(response.status, text)) {
      markChannelThrottled(actualModel, Number.isFinite(retryAfterHeader) ? retryAfterHeader : null);
    }
    const node = maybeDisableSelectedNode({
      endpoint,
      provider: "openrouter",
      responseStatus: response.status,
      responseBody: text,
    });
    throw new UpstreamHttpError("OpenRouter", response.status, text, node.retryElsewhere);
  }

  // Usage accounting: attribute tokens to the pool entry (account) that served
  // the request and price them with the OpenRouter catalog. `actualModel` is
  // the resolved id, which is what the catalog prices.
  const usageMeta = {
    provider: "openrouter" as const,
    model: actualModel,
    endpoint,
    requestedModel: request.model,
  };

  if (request.stream) {
    const stream = tapStreamUsage(parseSSEStream(response), usageMeta);
    if (shim) {
      logger.info(
        { model: actualModel, tool: shim.toolName },
        "synthetic stream shim active: re-encoding content into incremental tool_call arguments",
      );
      return ensureNonEmptyStream(wrapSyntheticToolStream(stream, shim.toolName), endpoint);
    }
    return ensureNonEmptyStream(stream, endpoint);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  // OpenRouter names the channel that actually answered ("Wafer", "DeepSeek",
  // "Chutes", …). That is the interesting supplier; `provider` in the ledger is
  // just this gateway's channel and reads "openrouter" for every row.
  const channel = (data as { provider?: unknown }).provider;
  recordUsage({
    ...usageMeta,
    usage: data.usage,
    ...(typeof channel === "string" && channel.trim() ? { upstreamProvider: channel.trim() } : {}),
  });
  return data;
}

/**
 * Some upstream relays (observed on the Replit AI-integration path) give up on
 * a streaming request when the model takes longer than their first-byte
 * budget: the request comes back as HTTP 200 with an empty placeholder body,
 * so the parsed stream ends without a single chunk. Forwarding that stream
 * as-is reaches the client as a silent blank reply. Peek at the first chunk
 * here instead: when the stream is empty, treat it as a transient node
 * failure (cooldown + retry against another pool entry); otherwise hand back
 * a regenerated stream that still carries the peeked chunk.
 */
async function ensureNonEmptyStream(
  stream: AsyncIterable<StreamChunk>,
  endpoint: ProviderEndpoint,
): Promise<AsyncIterable<StreamChunk>> {
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) {
    handleEmptyUpstreamStream(endpoint);
    throw new Error(
      "OpenRouter stream ended without emitting any chunks (upstream returned an empty placeholder response)",
    );
  }
  return (async function* () {
    yield first.value;
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  })();
}

async function* parseSSEStream(response: Response): AsyncIterable<StreamChunk> {
  if (!response.body) {
    throw new Error("OpenRouter stream error: response body is null");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function* processBuffer(flush = false): Generator<StreamChunk> {
    const lines = buffer.split(/\r?\n/);
    buffer = flush ? "" : (lines.pop() ?? "");
    if (flush && buffer) lines.push(buffer);

    for (const line of lines) {
      if (!line.startsWith("data")) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const data = line.slice(colonIdx + 1).trim();
      if (!data) continue;
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data) as StreamChunk;
      } catch {
        // skip malformed / non-JSON lines
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* processBuffer(false);
    }
    buffer += decoder.decode();
    yield* processBuffer(true);
  } catch (err) {
    throw new Error(`OpenRouter stream error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    reader.releaseLock();
  }
}
