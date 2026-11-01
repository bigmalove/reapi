import { resolveProviderEndpoint } from "../lib/providerEndpoint.js";
import { maybeDisableSelectedNode } from "../lib/upstreamNodeFailure.js";
import { UpstreamHttpError } from "../lib/upstreamError.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../lib/outputLimits.js";
import { recordUsage, tapStreamUsage } from "../lib/usageLedger.js";
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
  inlineData?: {
    mimeType: string;
    data: string;
  };
  fileData?: {
    fileUri: string;
    mimeType?: string;
  };
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
    cachedContentTokenCount?: number;
  };
}

const DATA_URL_PATTERN = /^data:([^;,]+);base64,([\s\S]*)$/;
const DEFAULT_IMAGE_MEDIA_TYPE = "image/png";

/** Read the URL out of an OpenAI `image_url` part, accepting both shapes. */
function imageUrlOf(part: Record<string, unknown>): string {
  const imageUrl = part["image_url"];
  if (typeof imageUrl === "string") return imageUrl;
  if (typeof imageUrl === "object" && imageUrl !== null) {
    const url = (imageUrl as { url?: unknown }).url;
    if (typeof url === "string") return url;
  }
  return "";
}

/**
 * Translate one OpenAI `image_url` content part into a Gemini image part.
 * Inline `data:` URLs become `inlineData`; http(s) links become `fileData`,
 * which Gemini fetches itself. Anything else is not an image this gateway can
 * forward and is dropped instead of being echoed back as empty text.
 */
function geminiPartFromContentPart(part: Record<string, unknown>): GeminiPart | null {
  if (part["type"] !== "image_url") return null;
  const url = imageUrlOf(part);
  if (url === "") return null;

  const dataUrl = DATA_URL_PATTERN.exec(url);
  if (dataUrl !== null) {
    const data = dataUrl[2].replace(/\s+/g, "");
    if (data === "") return null;
    return {
      inlineData: {
        mimeType: dataUrl[1] || DEFAULT_IMAGE_MEDIA_TYPE,
        data,
      },
    };
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return { fileData: { fileUri: url } };
  }

  return null;
}

/**
 * Plain text of a message content value. OpenAI clients may send a string or an
 * array of parts; only the text parts belong in a system instruction, a tool
 * result or a model turn.
 */
function textContentOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const raw of content as unknown[]) {
    const part = raw as Record<string, unknown>;
    if (typeof part["text"] === "string") text += part["text"];
  }
  return text;
}

function convertMessagesToGemini(messages: Message[]): {
  systemInstruction: string | undefined;
  contents: GeminiContent[];
} {
  let systemInstruction: string | undefined;
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemInstruction = textContentOf(m.content);
      continue;
    }
    if (m.role === "user") {
      if (typeof m.content === "string") {
        contents.push({ role: "user", parts: [{ text: m.content }] });
      } else {
        const parts: GeminiPart[] = [];
        for (const raw of (m.content ?? []) as unknown[]) {
          const p = raw as Record<string, unknown>;
          const image = geminiPartFromContentPart(p);
          if (image !== null) {
            parts.push(image);
            continue;
          }
          const text = typeof p.text === "string" ? p.text : "";
          if (text !== "") parts.push({ text });
        }
        if (parts.length === 0) parts.push({ text: "" });
        contents.push({ role: "user", parts });
      }
    } else if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      const assistantText = textContentOf(m.content);
      if (assistantText !== "") {
        parts.push({ text: assistantText });
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
      const text = textContentOf(m.content);
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
  // Pool nodes gate their SSE path on this header; without it a streaming
  // request takes the node's keep-alive heartbeat path and the stream is
  // replaced by an empty placeholder. See providers/openrouter.ts.
  if (request.stream) {
    headers["Accept"] = "text/event-stream";
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
      ...(request.max_tokens !== undefined
        ? { maxOutputTokens: request.max_tokens }
        : { maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS }),
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
    const node = maybeDisableSelectedNode({
      endpoint,
      provider: "gemini",
      responseStatus: response.status,
      responseBody: text,
    });
    throw new UpstreamHttpError("Gemini", response.status, text, node.retryElsewhere);
  }

  const usageMeta = {
    provider: "gemini" as const,
    model: actualModelId,
    endpoint,
    requestedModel: request.model,
  };

  if (request.stream) {
    return tapStreamUsage(parseGeminiStream(response, request.model), usageMeta);
  }

  const data = (await response.json()) as GeminiResponse;
  recordUsage({ ...usageMeta, usage: data.usageMetadata });
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
  // Gemini attaches usageMetadata to (at least) the final chunk; keep the last
  // one so the ledger gets the totals once the stream drains.
  let usageTotal: GeminiResponse["usageMetadata"] | undefined;

  function* processLine(line: string): Iterable<StreamChunk> {
    if (!line.startsWith("data: ")) return;
    const data = line.slice(6).trim();
    if (data === "[DONE]") return;
    try {
      const geminiResp = JSON.parse(data) as GeminiResponse;
      if (geminiResp.usageMetadata) usageTotal = geminiResp.usageMetadata;
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
    // One usage-only chunk so the gateway ledger records real token counts.
    if (usageTotal) {
      yield {
        id,
        object: "chat.completion.chunk",
        created,
        model: requestModel,
        choices: [],
        usage: {
          prompt_tokens: usageTotal.promptTokenCount ?? 0,
          completion_tokens: usageTotal.candidatesTokenCount ?? 0,
          total_tokens: usageTotal.totalTokenCount ?? 0,
          ...(usageTotal.cachedContentTokenCount
            ? { prompt_tokens_details: { cached_tokens: usageTotal.cachedContentTokenCount } }
            : {}),
        },
      };
    }
  } catch (err) {
    throw new Error(`Gemini stream error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    reader.releaseLock();
  }
}

