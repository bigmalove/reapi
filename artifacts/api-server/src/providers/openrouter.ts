import type { ChatCompletionRequest, ChatCompletionResponse, StreamChunk } from "../types.js";

// Map Bedrock/* shorthand IDs to real OpenRouter model IDs
const BEDROCK_MODEL_MAP: Record<string, string> = {
  "Bedrock/claude-4.7-opus":           "anthropic/claude-opus-4.7",
  "Bedrock/claude-4.7-opus-thinking":  "anthropic/claude-opus-4.7",
  "Bedrock/claude-4.6-opus":           "anthropic/claude-opus-4.6",
  "Bedrock/claude-4.6-opus-thinking":  "anthropic/claude-opus-4.6",
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

export async function callOpenRouter(
  request: ChatCompletionRequest,
): Promise<ChatCompletionResponse | AsyncIterable<StreamChunk>> {
  const baseUrl = process.env["AI_INTEGRATIONS_OPENROUTER_BASE_URL"];
  const apiKey = process.env["AI_INTEGRATIONS_OPENROUTER_API_KEY"];

  if (!baseUrl || !apiKey) {
    throw new Error("Replit AI Integration for OpenRouter is not configured. AI_INTEGRATIONS_OPENROUTER_BASE_URL and AI_INTEGRATIONS_OPENROUTER_API_KEY must be set.");
  }

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

  // Models using adaptive thinking API (effort-based) via OpenRouter/Bedrock
  // actualModel is the resolved OpenRouter model ID (after Bedrock alias lookup)
  const ADAPTIVE_THINKING_MODELS = new Set([
    "anthropic/claude-opus-4.7",
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
  } else if (thinkingEnabled) {
    const budgetTokens = explicitEffort
      ? effortToTokens(explicitEffort, maxTokens)
      : Math.floor(maxTokens * 0.8);
    body["thinking"] = { type: "enabled", budget_tokens: budgetTokens };
    delete body["temperature"];
  }

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
    throw new Error(`OpenRouter error ${response.status}: ${text}`);
  }

  if (request.stream) {
    return parseSSEStream(response);
  }

  return (await response.json()) as ChatCompletionResponse;
}

async function* parseSSEStream(response: Response): AsyncIterable<StreamChunk> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data) as StreamChunk;
          } catch {
            // skip malformed chunks
          }
        }
      }
    }
    // Process any remaining content in buffer after stream ends
    if (buffer.startsWith("data: ")) {
      const data = buffer.slice(6).trim();
      if (data && data !== "[DONE]") {
        try {
          yield JSON.parse(data) as StreamChunk;
        } catch {
          // skip malformed chunks
        }
      }
    }
  } catch (err) {
    throw new Error(`OpenRouter stream error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
