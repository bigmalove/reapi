import { resolveProviderEndpoint } from "../lib/providerEndpoint.js";
import { maybeDisableSelectedNode } from "../lib/upstreamNodeFailure.js";
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
  clientHeaders: Record<string, string> = {},
): Promise<ChatCompletionResponse | AsyncIterable<StreamChunk>> {
  const endpoint = resolveProviderEndpoint("gemini");
  const { baseUrl, apiKey } = endpoint;

  const usingIntegration = true;

  // Resolve thinking variants: strip suffix and enable thinking config
  let actualModelId = request.model;
  let thinkingEnabled = false;
  let thinkingBudget: number = -1; // -1 = dynamic budget

  const budgetLevelMap: Record<string, number> = {
    low:    1024,
    medium: 8192,
    high:   16384,
    max:    32768,
  };

  const budgetLevelMatch = actualModelId.match(/-thinking-(low|medium|high|max)$/);
  if (budgetLevelMatch) {
    thinkingEnabled = true;
    thinkingBudget = budgetLevelMap[budgetLevelMatch[1]];
    actualModelId = actualModelId.replace(/-thinking-(low|medium|high|max)$/, "");
  } else if (actualModelId.endsWith("-thinking-visible") || actualModelId.endsWith("-thinking")) {
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
  if (clientHeaders["x-goog-api-client"]) {
    headers["x-goog-api-client"] = clientHeaders["x-goog-api-client"];
  }

  // Pass-through view of additional fields the base type doesn't enumerate.
  const extra = request as ChatCompletionRequest & {
    top_k?: number;
    stop?: string | string[];
    stop_sequences?: string[];
    presence_penalty?: number;
    frequency_penalty?: number;
    seed?: number;
    n?: number;
    response_format?: {
      type?: string;
      json_schema?: { schema?: Record<string, unknown> };
    };
    safety_settings?: unknown;
    safetySettings?: unknown;
  };

  // Accept either OpenAI-style `stop` or Gemini-style `stop_sequences`,
  // merging both sources with dedup.
  const stopParts: string[] = [];
  if (Array.isArray(extra.stop_sequences)) {
    stopParts.push(...extra.stop_sequences.filter((s): s is string => typeof s === "string"));
  }
  if (typeof extra.stop === "string") {
    stopParts.push(extra.stop);
  } else if (Array.isArray(extra.stop)) {
    stopParts.push(...extra.stop.filter((s): s is string => typeof s === "string"));
  }
  const stopSequences = stopParts.length > 0 ? Array.from(new Set(stopParts)) : undefined;

  // Map OpenAI-style response_format → Gemini responseMimeType / responseSchema.
  let responseFormat: { responseMimeType: string; responseSchema?: Record<string, unknown> } | undefined;
  if (extra.response_format && typeof extra.response_format === "object") {
    if (extra.response_format.type === "json_object") {
      responseFormat = { responseMimeType: "application/json" };
    } else if (
      extra.response_format.type === "json_schema" &&
      extra.response_format.json_schema?.schema
    ) {
      responseFormat = {
        responseMimeType: "application/json",
        responseSchema: extra.response_format.json_schema.schema,
      };
    }
  }

  const body: Record<string, unknown> = {
    contents,
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    generationConfig: {
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.max_tokens !== undefined ? { maxOutputTokens: request.max_tokens } : {}),
      ...(request.top_p !== undefined ? { topP: request.top_p } : {}),
      ...(extra.top_k !== undefined ? { topK: extra.top_k } : {}),
      ...(stopSequences ? { stopSequences } : {}),
      ...(extra.presence_penalty !== undefined ? { presencePenalty: extra.presence_penalty } : {}),
      ...(extra.frequency_penalty !== undefined ? { frequencyPenalty: extra.frequency_penalty } : {}),
      ...(extra.seed !== undefined ? { seed: extra.seed } : {}),
      ...(extra.n !== undefined ? { candidateCount: extra.n } : {}),
      ...(responseFormat ? responseFormat : {}),
      // Enable extended thinking for thinking variants (-1 = dynamic budget, or preset budget in tokens)
      ...(thinkingEnabled ? { thinkingConfig: { thinkingBudget } } : {}),
    },
  };

  // Forward Gemini-native safety settings if the caller provides them.
  const safety = extra.safetySettings ?? extra.safety_settings;
  if (Array.isArray(safety) && safety.length > 0) {
    body["safetySettings"] = safety;
  }

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
    maybeDisableSelectedNode({ endpoint, responseStatus: response.status, responseBody: text });
    throw new Error(`Gemini error ${response.status}: ${text}`);
  }

  if (request.stream) {
    return parseGeminiStream(response, request.model);
  }

  const data = (await response.json()) as GeminiResponse;
  return buildOpenAIResponse(data, request.model);
}

async function* parseGeminiStream(response: Response, requestModel: string): AsyncIterable<StreamChunk> {
  if (!response.body) {
    throw new Error("Gemini stream error: response body is null");
  }
  const reader = response.body.getReader();
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
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        yield* processLine(line);
      }
    }
    // Flush decoder and process any remaining buffered content
    buffer += decoder.decode();
    if (buffer.trim()) {
      yield* processLine(buffer);
    }
  } catch (err) {
    throw new Error(`Gemini stream error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    reader.releaseLock();
  }
}

