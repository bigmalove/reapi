import type { ChatCompletionRequest, ChatCompletionResponse, StreamChunk } from "../types.js";
import { resolveProviderEndpoint } from "../lib/providerEndpoint.js";

// Models that behave like reasoning models (use max_completion_tokens, no temperature/top_p)
const REASONING_MODELS = new Set(["gpt-5.5"]);

// Map thinking-level suffix → OpenAI reasoning_effort value
// OpenAI supports: "minimal" | "low" | "medium" | "high" | "xhigh"
const EFFORT_MAP: Record<string, string> = {
  low:    "low",
  medium: "medium",
  high:   "high",
  xhigh:  "xhigh",
  max:    "xhigh",
};

function parseThinkingLevel(model: string): { baseModel: string; reasoningEffort: string | null } {
  // Match: <model>-thinking-<level>  e.g. gpt-5.5-thinking-high
  const withLevel = model.match(/^(.+)-thinking-(low|medium|high|xhigh|max)$/);
  if (withLevel) {
    return { baseModel: withLevel[1], reasoningEffort: EFFORT_MAP[withLevel[2]] };
  }
  // Match: <model>-thinking  (no level → default high)
  const plain = model.match(/^(.+)-thinking$/);
  if (plain) {
    return { baseModel: plain[1], reasoningEffort: "high" };
  }
  return { baseModel: model, reasoningEffort: null };
}

export async function callOpenAI(
  request: ChatCompletionRequest,
): Promise<ChatCompletionResponse | AsyncIterable<StreamChunk>> {
  const { baseUrl, apiKey } = resolveProviderEndpoint("openai");

  // Replit integration proxy doesn't include /v1 in path
  const url = `${baseUrl}/chat/completions`;

  // Parse thinking-level suffix (e.g. gpt-5.5-thinking-high → gpt-5.5 + effort=high)
  const { baseModel, reasoningEffort } = parseThinkingLevel(request.model);

  // o-series: starts with o + digit. Reasoning models: explicit set.
  const isOSeries = /^o\d/.test(baseModel);
  const isReasoningModel = REASONING_MODELS.has(baseModel) || isOSeries;

  // Reasoning models don't support: max_tokens, temperature, top_p,
  // presence_penalty, frequency_penalty, logit_bias, logprobs, top_logprobs
  const {
    max_tokens,
    temperature,
    top_p,
    presence_penalty,
    frequency_penalty,
    logit_bias,
    logprobs,
    top_logprobs,
    ...restRequest
  } = request as ChatCompletionRequest & {
    presence_penalty?: number;
    frequency_penalty?: number;
    logit_bias?: Record<string, number>;
    logprobs?: boolean;
    top_logprobs?: number;
  };

  const resolvedRequest: Record<string, unknown> = {
    ...restRequest,
    model: baseModel,
    ...(isReasoningModel
      ? { ...(max_tokens !== undefined ? { max_completion_tokens: max_tokens } : {}) }
      : {
          ...(max_tokens !== undefined ? { max_tokens } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(top_p !== undefined ? { top_p } : {}),
          ...(presence_penalty !== undefined ? { presence_penalty } : {}),
          ...(frequency_penalty !== undefined ? { frequency_penalty } : {}),
          ...(logit_bias !== undefined ? { logit_bias } : {}),
          ...(logprobs !== undefined ? { logprobs } : {}),
          ...(top_logprobs !== undefined ? { top_logprobs } : {}),
        }),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
  const body = JSON.stringify(resolvedRequest);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${text}`);
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
    throw new Error(`OpenAI stream error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
