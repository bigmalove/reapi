import type { ChatCompletionRequest, ChatCompletionResponse, StreamChunk } from "../types.js";
import { resolveProviderEndpoint } from "../lib/providerEndpoint.js";
import { maybeDisableSelectedNode } from "../lib/upstreamNodeFailure.js";

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

  // Models using adaptive thinking API (effort-based) via OpenRouter/Bedrock
  // actualModel is the resolved OpenRouter model ID (after Bedrock alias lookup)
  const ADAPTIVE_THINKING_MODELS = new Set([
    "anthropic/claude-opus-4.7",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-fable-5",
  ]);
  const usesAdaptiveThinking = ADAPTIVE_THINKING_MODELS.has(actualModel);

  // Build the request body
  const body: Record<string, unknown> = {
    ...request,
    model: actualModel,
  };

  // Force AWS Bedrock for all Claude models
  if (isClaude) {
    body["provider"] = {
      order: ["amazon-bedrock"],
      allow_fallbacks: false,
    };
  }

  // Force DeepSeek provider channel for deepseek-v4-pro
  if (actualModel === "deepseek/deepseek-v4-pro") {
    body["provider"] = {
      order: ["deepseek"],
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

  const maxTokens = (request.max_tokens as number | undefined) ?? 16000;

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

  if (usesAdaptiveThinking && thinkingEnabled) {
    const budgetTokens = Math.floor(maxTokens * 0.8);
    const effort = explicitEffort ?? budgetToEffort(budgetTokens);
    body["thinking"] = { type: "adaptive", display: "summarized" };
    body["output_config"] = { effort };
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
  } else if (thinkingEnabled && !isOpenAIReasoningModel) {
    // Anthropic-style budget_tokens thinking (skip for OpenAI — already handled above)
    // Anthropic requires budget_tokens >= 1024; ensure max_tokens is high enough too.
    const effectiveMax = Math.max(maxTokens, 2048);
    if (effectiveMax !== maxTokens) body["max_tokens"] = effectiveMax;
    const rawBudget = explicitEffort
      ? effortToTokens(explicitEffort, effectiveMax)
      : Math.floor(effectiveMax * 0.8);
    const budgetTokens = Math.max(rawBudget, 1024);
    body["thinking"] = { type: "enabled", budget_tokens: budgetTokens };
    delete body["temperature"];
  }

  const outboundHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": "https://replit.com",
    "X-Title": "AI Gateway",
    // Forward Anthropic / OpenAI beta headers when the caller asks for them —
    // OpenRouter passes them through to the underlying upstream.
    ...(clientHeaders["anthropic-beta"]
      ? { "anthropic-beta": clientHeaders["anthropic-beta"] }
      : {}),
    ...(clientHeaders["openai-beta"] ? { "OpenAI-Beta": clientHeaders["openai-beta"] } : {}),
  };

  const response = await fetch(url, {
    method: "POST",
    headers: outboundHeaders,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    maybeDisableSelectedNode({ endpoint, responseStatus: response.status, responseBody: text });
    throw new Error(`OpenRouter error ${response.status}: ${text}`);
  }

  if (request.stream) {
    return parseSSEStream(response);
  }

  return (await response.json()) as ChatCompletionResponse;
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
