import { resolveProviderEndpoint } from "../lib/providerEndpoint.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  Message,
  Tool,
} from "../types.js";

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: { content: unknown };
  };
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
}

interface GeminiCandidate {
  content: {
    role: string;
    parts: GeminiPart[];
  };
  finishReason?: string;
  index?: number;
}

interface GeminiResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

function convertMessagesToGemini(messages: Message[]): {
  systemInstruction: string | undefined;
  contents: GeminiContent[];
} {
  let systemInstruction: string | undefined;
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemInstruction = typeof m.content === "string" ? m.content : "";
      continue;
    }
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : "";
      contents.push({ role: "user", parts: [{ text }] });
    } else if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.content) {
        parts.push({ text: typeof m.content === "string" ? m.content : "" });
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            // ignore
          }
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
      }
      contents.push({ role: "model", parts });
    } else if (m.role === "tool") {
      const text = typeof m.content === "string" ? m.content : "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.name ?? "unknown",
              response: { content: parsed },
            },
          },
        ],
      });
    }
  }

  return { systemInstruction, contents };
}

function convertToolsToGemini(tools: Tool[]): GeminiTool[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    },
  ];
}

function buildOpenAIResponse(geminiResponse: GeminiResponse, requestModel: string): ChatCompletionResponse {
  const id = `chatcmpl-gemini-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  const candidates = geminiResponse.candidates ?? [];
  const choices = candidates.map((candidate, index) => {
    const parts = candidate.content?.parts ?? [];
    let textContent: string | null = null;
    const toolCalls = [];

    for (const part of parts) {
      if (part.text !== undefined) {
        textContent = (textContent ?? "") + part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: `call_${index}_${toolCalls.length}`,
          type: "function" as const,
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        });
      }
    }

    let finishReason = "stop";
    const reason = candidate.finishReason;
    if (reason === "MAX_TOKENS") finishReason = "length";
    else if (reason === "SAFETY") finishReason = "content_filter";
    else if (toolCalls.length > 0) finishReason = "tool_calls";

    return {
      index,
      message: {
        role: "assistant" as const,
        content: textContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    };
  });

  return {
    id,
    object: "chat.completion",
    created,
    model: requestModel,
    choices,
    usage: geminiResponse.usageMetadata
      ? {
          prompt_tokens: geminiResponse.usageMetadata.promptTokenCount,
          completion_tokens: geminiResponse.usageMetadata.candidatesTokenCount,
          total_tokens: geminiResponse.usageMetadata.totalTokenCount,
        }
      : undefined,
  };
}

function getGeminiModelName(model: string): string {
  if (model.startsWith("models/")) return model;
  return `models/${model}`;
}

export async function callGemini(
  request: ChatCompletionRequest,
): Promise<ChatCompletionResponse | AsyncIterable<StreamChunk>> {
  const { baseUrl, apiKey } = resolveProviderEndpoint("gemini");

  const usingIntegration = true;

  // Resolve thinking variants: strip suffix and enable thinking config
  let actualModelId = request.model;
  let thinkingEnabled = false;
  if (actualModelId.endsWith("-thinking-visible") || actualModelId.endsWith("-thinking")) {
    thinkingEnabled = true;
    actualModelId = actualModelId.replace(/-thinking-visible$/, "").replace(/-thinking$/, "");
  }

  const { systemInstruction, contents } = convertMessagesToGemini(request.messages);
  const geminiModel = getGeminiModelName(actualModelId);

  const action = request.stream ? "streamGenerateContent" : "generateContent";
  // Replit integration proxy uses /models/... (no /v1beta prefix); direct API uses /v1beta/models/...
  const pathPrefix = usingIntegration ? "" : "/v1beta";
  const keyParam = usingIntegration ? "" : `?key=${apiKey}`;
  const streamParam = request.stream ? (usingIntegration ? "?alt=sse" : "&alt=sse") : "";
  const url = `${baseUrl}${pathPrefix}/${geminiModel}:${action}${keyParam}${streamParam}`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (usingIntegration) {
    headers["x-goog-api-key"] = apiKey;
  }

  const body: Record<string, unknown> = {
    contents,
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    generationConfig: {
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.max_tokens !== undefined ? { maxOutputTokens: request.max_tokens } : {}),
      ...(request.top_p !== undefined ? { topP: request.top_p } : {}),
      // Enable extended thinking for thinking variants (-1 = dynamic budget)
      ...(thinkingEnabled ? { thinkingConfig: { thinkingBudget: -1 } } : {}),
    },
  };

  if (request.tools && request.tools.length > 0) {
    body["tools"] = convertToolsToGemini(request.tools);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini error ${response.status}: ${text}`);
  }

  if (request.stream) {
    return parseGeminiStream(response, request.model);
  }

  const data = (await response.json()) as GeminiResponse;
  return buildOpenAIResponse(data, request.model);
}

async function* parseGeminiStream(response: Response, requestModel: string): AsyncIterable<StreamChunk> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const id = `chatcmpl-gemini-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  function* processLine(line: string): Iterable<StreamChunk> {
    if (!line.startsWith("data: ")) return;
    const data = line.slice(6).trim();
    if (data === "[DONE]") return;
    try {
      const geminiResp = JSON.parse(data) as GeminiResponse;
      const candidates = geminiResp.candidates ?? [];
      for (const candidate of candidates) {
        const parts = candidate.content?.parts ?? [];
        for (const part of parts) {
          if (part.text) {
            yield {
              id,
              object: "chat.completion.chunk",
              created,
              model: requestModel,
              choices: [
                {
                  index: candidate.index ?? 0,
                  delta: { role: "assistant", content: part.text },
                  finish_reason: null,
                },
              ],
            };
          } else if (part.functionCall) {
            yield {
              id,
              object: "chat.completion.chunk",
              created,
              model: requestModel,
              choices: [
                {
                  index: candidate.index ?? 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_gemini_${Date.now()}`,
                        type: "function",
                        function: {
                          name: part.functionCall.name,
                          arguments: JSON.stringify(part.functionCall.args ?? {}),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
          }
        }
        if (candidate.finishReason) {
          let finishReason = "stop";
          if (candidate.finishReason === "MAX_TOKENS") finishReason = "length";
          else if (candidate.finishReason === "SAFETY") finishReason = "content_filter";
          yield {
            id,
            object: "chat.completion.chunk",
            created,
            model: requestModel,
            choices: [
              {
                index: candidate.index ?? 0,
                delta: {},
                finish_reason: finishReason,
              },
            ],
          };
        }
      }
    } catch {
      // skip malformed events
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        yield* processLine(line);
      }
    }
    // Process any remaining content in buffer after stream ends
    if (buffer.trim()) {
      yield* processLine(buffer);
    }
  } catch (err) {
    throw new Error(`Gemini stream error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

