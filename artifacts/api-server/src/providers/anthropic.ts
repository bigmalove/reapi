import { logger } from "../lib/logger.js";
import { resolveProviderEndpoint } from "../lib/providerEndpoint.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  Message,
  Tool,
  ToolCall,
} from "../types.js";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

function convertMessagesToAnthropic(messages: Message[]): {
  system: string | undefined;
  msgs: AnthropicMessage[];
} {
  let system: string | undefined;
  const msgs: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      system = typeof m.content === "string" ? m.content : "";
      continue;
    }
    if (m.role === "user") {
      const content =
        typeof m.content === "string"
          ? m.content
          : (m.content ?? [])
              .map((p) => (p.type === "text" ? p.text ?? "" : ""))
              .join("");
      msgs.push({ role: "user", content });
    } else if (m.role === "assistant") {
      if (m.tool_calls && m.tool_calls.length > 0) {
        const blocks: AnthropicContentBlock[] = [];
        if (m.content) {
          blocks.push({ type: "text", text: typeof m.content === "string" ? m.content : "" });
        }
        for (const tc of m.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            // ignore
          }
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
        msgs.push({ role: "assistant", content: blocks });
      } else {
        msgs.push({
          role: "assistant",
          content: typeof m.content === "string" ? m.content ?? "" : "",
        });
      }
    } else if (m.role === "tool") {
      const resultBlock: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "",
        content: typeof m.content === "string" ? m.content : "",
      };
      msgs.push({ role: "user", content: [resultBlock] });
    }
  }

  return { system, msgs };
}

function convertToolsToAnthropic(tools: Tool[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

function buildOpenAIResponse(anthropicResponse: AnthropicApiResponse, requestModel: string): ChatCompletionResponse {
  const id = `chatcmpl-${anthropicResponse.id}`;
  const created = Math.floor(Date.now() / 1000);
  const content = anthropicResponse.content ?? [];

  let textContent: string | null = null;
  let thinkingContent = "";
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === "thinking" && block.thinking) {
      thinkingContent += block.thinking;
    } else if (block.type === "text") {
      textContent = block.text ?? null;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? `tool_${toolCalls.length}`,
        type: "function",
        function: {
          name: block.name ?? "",
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  if (thinkingContent) {
    const thinkingWrapped = `<antml_thinking>\n${thinkingContent}\n</antml_thinking>\n\n`;
    textContent = thinkingWrapped + (textContent ?? "");
  }

  let finishReason = "stop";
  if (anthropicResponse.stop_reason === "tool_use") {
    finishReason = "tool_calls";
  } else if (anthropicResponse.stop_reason === "max_tokens") {
    finishReason = "length";
  }

  return {
    id,
    object: "chat.completion",
    created,
    model: requestModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textContent,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: anthropicResponse.usage
      ? {
          prompt_tokens: anthropicResponse.usage.input_tokens,
          completion_tokens: anthropicResponse.usage.output_tokens,
          total_tokens: anthropicResponse.usage.input_tokens + anthropicResponse.usage.output_tokens,
        }
      : undefined,
  };
}

interface AnthropicApiResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export async function callAnthropic(
  request: ChatCompletionRequest,
): Promise<ChatCompletionResponse | AsyncIterable<StreamChunk>> {
  const { baseUrl, apiKey } = resolveProviderEndpoint("anthropic");

  // Resolve thinking variants and optional effort-level suffix
  const EFFORT_LEVELS = ["max", "xhigh", "high", "medium", "low"] as const;
  let actualModel = request.model;
  let thinkingEnabled = false;
  let explicitEffort: string | null = null;

  // Check for effort-level suffix first: model-thinking-{effort}
  for (const level of EFFORT_LEVELS) {
    if (actualModel.endsWith(`-thinking-${level}`)) {
      thinkingEnabled = true;
      explicitEffort = level;
      actualModel = actualModel.slice(0, actualModel.length - (`-thinking-${level}`).length);
      break;
    }
  }
  // Check for plain -thinking or -thinking-visible suffix
  if (!thinkingEnabled) {
    if (actualModel.endsWith("-thinking-visible") || actualModel.endsWith("-thinking")) {
      thinkingEnabled = true;
      actualModel = actualModel.replace(/-thinking-visible$/, "").replace(/-thinking$/, "");
    }
  }

  const { system, msgs } = convertMessagesToAnthropic(request.messages);

  // Models using adaptive thinking API (effort-based); all others use legacy budget_tokens
  const ADAPTIVE_THINKING_MODELS = new Set([
    "claude-opus-4-7",
  ]);
  const usesAdaptiveThinking = ADAPTIVE_THINKING_MODELS.has(actualModel);

  const maxTokens = request.max_tokens ?? (thinkingEnabled ? 16000 : 4096);
  const thinkingBudget = thinkingEnabled ? Math.floor(maxTokens * 0.8) : 0;

  // Map token budget → effort level (adaptive thinking)
  function budgetToEffort(budget: number): string {
    if (budget >= 20000) return "max";
    if (budget >= 14000) return "xhigh";
    if (budget >= 8000) return "high";
    if (budget >= 3000) return "medium";
    return "low";
  }

  // Map effort level → token budget (legacy budget_tokens thinking)
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

  const resolvedEffort = explicitEffort ?? (thinkingEnabled ? budgetToEffort(thinkingBudget) : "high");
  const resolvedBudget = explicitEffort ? effortToTokens(explicitEffort, maxTokens) : thinkingBudget;

  // Adaptive thinking (opus 4.7+): only send thinking params when thinkingEnabled
  // Legacy thinking (opus 4.6 and below): uses budget_tokens
  const thinkingBlock = usesAdaptiveThinking
    ? thinkingEnabled
      ? { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: resolvedEffort } }
      : {}
    : thinkingEnabled
      ? { thinking: { type: "enabled", budget_tokens: resolvedBudget } }
      : {};

  // claude-opus-4-7 deprecates temperature/top_p/top_k entirely (thinking or not)
  const stripSamplingParams = usesAdaptiveThinking || thinkingEnabled;

  const body: Record<string, unknown> = {
    model: actualModel,
    messages: msgs,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    ...(!stripSamplingParams && request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
    ...(request.stream ? { stream: true } : {}),
    ...thinkingBlock,
  };

  if (request.tools && request.tools.length > 0) {
    body["tools"] = convertToolsToAnthropic(request.tools);
  }

  const outboundUrl = `${baseUrl}/v1/messages`;
  const outboundHeaders = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  const outboundBody = JSON.stringify(body);

  logger.info({
    debug: "anthropic_outbound_request",
    url: outboundUrl,
    headers: {
      ...outboundHeaders,
      "x-api-key": `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`,
    },
    body: JSON.parse(outboundBody),
  }, "Anthropic outbound request");

  const response = await fetch(outboundUrl, {
    method: "POST",
    headers: outboundHeaders,
    body: outboundBody,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic error ${response.status}: ${text}`);
  }

  if (request.stream) {
    return parseAnthropicStream(response, request.model);
  }

  const data = (await response.json()) as AnthropicApiResponse;
  logger.info({
    debug: "anthropic_response",
    status: response.status,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    model: data.model,
    stop_reason: data.stop_reason,
    usage: data.usage,
    contentTypes: data.content?.map(b => b.type),
  }, "Anthropic response received");
  return buildOpenAIResponse(data, request.model);
}

async function* parseAnthropicStream(
  response: Response,
  requestModel: string,
): AsyncIterable<StreamChunk> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const id = `chatcmpl-anthropic-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  // State for collecting tool use blocks and thinking blocks
  const toolUseBlocks: Map<number, { id: string; name: string; inputJson: string }> = new Map();
  const thinkingBlocks: Set<number> = new Set();

  function processLine(line: string): StreamChunk | null {
    if (!line.startsWith("data: ")) return null;
    const data = line.slice(6).trim();
    try {
      const event = JSON.parse(data) as AnthropicStreamEvent;
      return convertAnthropicEventToChunk(event, id, created, requestModel, toolUseBlocks, thinkingBlocks);
    } catch {
      return null;
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
        const chunk = processLine(line);
        if (chunk) yield chunk;
      }
    }
    // Process any remaining content in buffer after stream ends
    if (buffer.trim()) {
      const chunk = processLine(buffer);
      if (chunk) yield chunk;
    }
  } catch (err) {
    throw new Error(`Anthropic stream error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    text?: string;
    thinking?: string;
  };
  message?: {
    stop_reason?: string;
  };
}

function convertAnthropicEventToChunk(
  event: AnthropicStreamEvent,
  id: string,
  created: number,
  model: string,
  toolUseBlocks: Map<number, { id: string; name: string; inputJson: string }>,
  thinkingBlocks: Set<number>,
): StreamChunk | null {
  const base = { id, object: "chat.completion.chunk" as const, created, model };

  if (event.type === "content_block_start") {
    const block = event.content_block;
    const index = event.index ?? 0;
    if (block?.type === "thinking") {
      thinkingBlocks.add(index);
      return {
        ...base,
        choices: [{ index: 0, delta: { role: "assistant", content: "<antml_thinking>\n" }, finish_reason: null }],
      };
    } else if (block?.type === "text") {
      return {
        ...base,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      };
    } else if (block?.type === "tool_use") {
      toolUseBlocks.set(index, { id: block.id ?? `tool_${index}`, name: block.name ?? "", inputJson: "" });
      return {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index,
                  id: block.id ?? `tool_${index}`,
                  type: "function",
                  function: { name: block.name ?? "", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
    }
  }

  if (event.type === "content_block_delta") {
    const delta = event.delta;
    const index = event.index ?? 0;
    if (delta?.type === "thinking_delta" && delta.thinking) {
      return {
        ...base,
        choices: [{ index: 0, delta: { content: delta.thinking }, finish_reason: null }],
      };
    } else if (delta?.type === "text_delta" && delta.text) {
      return {
        ...base,
        choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
      };
    } else if (delta?.type === "input_json_delta" && delta.partial_json !== undefined) {
      const block = toolUseBlocks.get(index);
      if (block) {
        block.inputJson += delta.partial_json;
        return {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index, function: { arguments: delta.partial_json } }],
              },
              finish_reason: null,
            },
          ],
        };
      }
    }
  }

  if (event.type === "content_block_stop") {
    const index = event.index ?? 0;
    if (thinkingBlocks.has(index)) {
      thinkingBlocks.delete(index);
      return {
        ...base,
        choices: [{ index: 0, delta: { content: "\n</antml_thinking>\n\n" }, finish_reason: null }],
      };
    }
  }

  if (event.type === "message_delta" && event.delta?.stop_reason) {
    const stopReason = event.delta.stop_reason;
    let finishReason = "stop";
    if (stopReason === "tool_use") finishReason = "tool_calls";
    else if (stopReason === "max_tokens") finishReason = "length";
    return {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    };
  }

  return null;
}
