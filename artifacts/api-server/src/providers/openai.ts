import type { ChatCompletionRequest, ChatCompletionResponse, StreamChunk } from "../types.js";

export async function callOpenAI(
  request: ChatCompletionRequest,
): Promise<ChatCompletionResponse | AsyncIterable<StreamChunk>> {
  const baseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

  if (!baseUrl || !apiKey) {
    throw new Error("Replit AI Integration for OpenAI is not configured. AI_INTEGRATIONS_OPENAI_BASE_URL and AI_INTEGRATIONS_OPENAI_API_KEY must be set.");
  }

  // Replit integration proxy doesn't include /v1 in path
  const url = `${baseUrl}/chat/completions`;

  // Strip -thinking suffix from o-series aliases (they reason by default)
  const resolvedModel = request.model.replace(/-thinking$/, "");
  const isOSeries = /^o\d/.test(resolvedModel);

  // o-series models don't support max_tokens or temperature; use max_completion_tokens instead
  const { max_tokens, temperature, top_p, ...restRequest } = request;
  const resolvedRequest: Record<string, unknown> = {
    ...restRequest,
    model: resolvedModel,
    ...(isOSeries
      ? { ...(max_tokens !== undefined ? { max_completion_tokens: max_tokens } : {}) }
      : {
          ...(max_tokens !== undefined ? { max_tokens } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(top_p !== undefined ? { top_p } : {}),
        }),
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
