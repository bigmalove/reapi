import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ContentPart,
  Message,
  StreamChunk,
  Tool,
  ToolCall,
} from "../types.js";
import {
  budgetToEffort,
  clampIdentifier,
  clampIdentityFields,
  effortToBudget,
  sanitizeBetaList,
  splitThinkingSuffix,
  usesAdaptiveThinking,
} from "./claudeCode.js";
import { getModelRegistry, isModelDisabled, isThinkingVariantId } from "./models.js";

/**
 * Anthropic Messages API wire types and the conversions needed to serve them
 * from this gateway.
 *
 * Two paths exist:
 *   1. `claude-*` models on the direct Anthropic provider are proxied natively —
 *      the body is forwarded close to untouched so thinking blocks, cache
 *      breakpoints and tool_use ids survive the round trip.
 *   2. Every other provider goes through an Anthropic → OpenAI conversion and
 *      its stream is re-encoded as Anthropic SSE events here.
 */

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
    url?: string;
    content?: string | AnthropicContentBlock[];
  };
  is_error?: boolean;
  thinking?: string;
  signature?: string;
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string;
  [key: string]: unknown;
}

export interface AnthropicMessagesBody {
  model?: string;
  messages?: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: { type?: string; name?: string; disable_parallel_tool_use?: boolean };
  thinking?: { type?: string; budget_tokens?: number; display?: string };
  metadata?: Record<string, unknown>;
  output_config?: Record<string, unknown>;
  betas?: unknown;
  [key: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<Record<string, unknown>>;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

/** Anthropic error envelope: Claude Code reads `error.type` / `error.message`. */
export function anthropicError(
  type: string,
  message: string,
): { type: "error"; error: { type: string; message: string } } {
  return { type: "error", error: { type, message } };
}

/**
 * Turn an upstream error body into an Anthropic error envelope. Upstream bodies
 * are usually already in that shape; anything else is wrapped so Claude Code
 * still shows a useful message instead of a bare status code.
 */
export function parseAnthropicErrorBody(
  body: string,
  fallbackType = "api_error",
): { type: "error"; error: { type: string; message: string } } {
  try {
    const parsed = JSON.parse(body) as {
      type?: unknown;
      error?: { type?: unknown; message?: unknown } | string;
      message?: unknown;
    };
    if (parsed && parsed.type === "error" && parsed.error && typeof parsed.error === "object") {
      const type = typeof parsed.error.type === "string" ? parsed.error.type : fallbackType;
      const message = typeof parsed.error.message === "string" ? parsed.error.message : body;
      return anthropicError(type, message);
    }
    if (parsed && typeof parsed.error === "string" && parsed.error) {
      return anthropicError(fallbackType, parsed.error);
    }
    if (parsed && typeof parsed.message === "string" && parsed.message) {
      return anthropicError(fallbackType, parsed.message);
    }
  } catch {
    // not JSON
  }
  return anthropicError(fallbackType, body.slice(0, 2000) || "upstream request failed");
}

// ── Token estimation ────────────────────────────────────────────────────────

/** Rough token count: ASCII ≈ 4 chars/token, CJK ≈ 1.5 chars/token. */
function countTextTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  let other = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      ascii++;
    } else if (
      (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals … CJK unified
      (cp >= 0xac00 && cp <= 0xd7af) || // Hangul
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
      (cp >= 0xff00 && cp <= 0xffef) || // fullwidth forms
      (cp >= 0x20000 && cp <= 0x2fa1f) // CJK extension
    ) {
      wide++;
    } else {
      other++;
    }
  }
  return Math.ceil(ascii / 4) + Math.ceil(wide / 1.5) + Math.ceil(other / 2);
}

function estimateBlocks(blocks: AnthropicContentBlock[]): number {
  let tokens = 0;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") tokens += countTextTokens(block.text);
    if (block.type === "image") tokens += 1600;
    if (block.type === "document") {
      const source = block.source;
      if (source && typeof source.data === "string") tokens += Math.ceil(source.data.length / 8);
      else if (source && typeof source.content === "string") tokens += countTextTokens(source.content);
      else if (source && Array.isArray(source.content)) tokens += estimateBlocks(source.content);
    }
    if (block.type === "tool_use" && block.input !== undefined) {
      tokens += Math.ceil(JSON.stringify(block.input).length / 4);
    }
    if (block.type === "tool_result") {
      if (typeof block.content === "string") tokens += countTextTokens(block.content);
      else if (Array.isArray(block.content)) tokens += estimateBlocks(block.content);
    }
  }
  return tokens;
}

/**
 * Local input-token estimate. Used for `message_start.usage` on the converted
 * path and as the fallback for `/v1/messages/count_tokens` when no real
 * Anthropic endpoint can answer.
 */
export function estimateAnthropicInputTokens(body: AnthropicMessagesBody): number {
  let tokens = 3;

  if (typeof body.system === "string") {
    tokens += countTextTokens(body.system);
  } else if (Array.isArray(body.system)) {
    tokens += estimateBlocks(body.system);
  }

  for (const message of body.messages ?? []) {
    tokens += 4;
    if (typeof message.content === "string") {
      tokens += countTextTokens(message.content);
    } else if (Array.isArray(message.content)) {
      tokens += estimateBlocks(message.content);
    }
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      tokens += Math.ceil(JSON.stringify(tool ?? {}).length / 4);
    }
  }

  return Math.max(1, tokens);
}

// ── Native Anthropic request body ───────────────────────────────────────────

const NATIVE_FIELDS = [
  "messages",
  "system",
  "max_tokens",
  "metadata",
  "stop_sequences",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "context_management",
  "service_tier",
  "container",
  "mcp_servers",
] as const;

const COUNT_TOKENS_FIELDS = ["messages", "system", "tools", "thinking", "tool_choice"] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/**
 * Build the body sent to a real Anthropic Messages endpoint.
 *
 * Several Claude families (opus 4.6+, sonnet 5, fable 5, opus 5) only accept
 * adaptive thinking. Claude Code still sends the legacy
 * `thinking: {type:"enabled", budget_tokens}` shape, so it is translated to
 * `output_config.effort` for those families — and back the other way when an
 * old model receives an adaptive block.
 */
export function buildNativeAnthropicBody(
  body: AnthropicMessagesBody,
  model: string,
  opts: { thinkingLevel?: string | null; thinkingRequested?: boolean; forCountTokens?: boolean } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { model };

  for (const field of opts.forCountTokens ? COUNT_TOKENS_FIELDS : NATIVE_FIELDS) {
    if (body[field] !== undefined) out[field] = body[field];
  }

  const betas = sanitizeBetaList(body.betas);
  if (betas) out["betas"] = betas;

  const maxTokens = typeof out["max_tokens"] === "number" ? out["max_tokens"] : 8192;
  if (!opts.forCountTokens) out["max_tokens"] = maxTokens;

  const inbound = body.thinking;
  const adaptive = usesAdaptiveThinking(model);
  const requested =
    opts.thinkingRequested === true ||
    inbound?.type === "enabled" ||
    inbound?.type === "adaptive";
  const budget =
    typeof inbound?.budget_tokens === "number" ? inbound.budget_tokens : Math.floor(maxTokens * 0.8);
  const declaredEffort =
    typeof body.output_config?.["effort"] === "string" ? (body.output_config["effort"] as string) : null;
  const level = opts.thinkingLevel ?? declaredEffort ?? (requested ? budgetToEffort(budget) : null);

  if (adaptive) {
    if (requested) {
      out["thinking"] = { type: "adaptive", display: "summarized" };
      out["output_config"] = { ...asRecord(body.output_config), effort: level ?? "high" };
    } else {
      delete out["thinking"];
    }
    // These families reject sampling parameters outright.
    delete out["temperature"];
    delete out["top_p"];
    delete out["top_k"];
  } else if (requested) {
    if (inbound?.type === "adaptive") {
      const tokens = Math.max(
        1024,
        Math.min(Math.max(maxTokens - 1024, 1024), effortToBudget(level ?? "high", maxTokens)),
      );
      out["thinking"] = { type: "enabled", budget_tokens: tokens };
      out["max_tokens"] = Math.max(maxTokens, tokens + 1024);
    } else {
      const tokens = Math.max(1024, budget);
      out["thinking"] = { ...inbound, type: "enabled", budget_tokens: tokens };
      // Anthropic requires max_tokens to exceed the thinking budget.
      if (typeof out["max_tokens"] === "number" && out["max_tokens"] <= tokens) {
        out["max_tokens"] = tokens + 1024;
      }
    }
  } else {
    // `thinking` was copied through the field whitelist; drop anything that is
    // not an active thinking request (e.g. `{type:"disabled"}`).
    delete out["thinking"];
  }

  // Claude Code's `metadata.user_id` is longer than the 32-byte
  // `safety_identifier` some relays enforce; clamp before it leaves the gateway.
  clampIdentityFields(out);

  return out;
}

// ── Anthropic → OpenAI request conversion ───────────────────────────────────

function flattenSystem(system: AnthropicMessagesBody["system"]): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function flattenToolResultContent(content: AnthropicContentBlock["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[image omitted: tool result images are not forwarded]");
    else if (block.type === "document") parts.push("[document omitted]");
  }
  return parts.join("\n");
}

function imageContentPart(block: AnthropicContentBlock): ContentPart | null {
  const source = block.source;
  if (!source) return null;
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  if (source.type === "base64" && typeof source.data === "string") {
    const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
    return { type: "image_url", image_url: { url: `data:${mediaType};base64,${source.data}` } };
  }
  return null;
}

function convertToolChoice(
  choice: AnthropicMessagesBody["tool_choice"],
): ChatCompletionRequest["tool_choice"] | undefined {
  if (!choice || typeof choice !== "object") return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return choice.name ? { type: "function", function: { name: choice.name } } : undefined;
    default:
      return undefined;
  }
}

/**
 * Pick a thinking variant of the model when the client asked for thinking.
 * The gateway reads the effort level from the model id, not from a body-level
 * field, so the request is re-pointed at `<model>-thinking-<level>` when such
 * an entry exists.
 */
function withThinkingVariant(model: string, body: AnthropicMessagesBody): string {
  const requested = body.thinking?.type === "enabled" || body.thinking?.type === "adaptive";
  if (!requested || isThinkingVariantId(model)) return model;

  const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : 8192;
  const budget =
    typeof body.thinking?.budget_tokens === "number" ? body.thinking.budget_tokens : Math.floor(maxTokens * 0.8);
  const declared = body.output_config?.["effort"];
  const candidateLevels =
    typeof declared === "string"
      ? [declared, budgetToEffort(budget)]
      : [budgetToEffort(budget), "high"];

  const registry = getModelRegistry();
  for (const level of candidateLevels) {
    const candidate = `${model}-thinking-${level}`;
    if (registry.some((entry) => entry.id === candidate) && !isModelDisabled(candidate)) {
      return candidate;
    }
  }
  const plain = `${model}-thinking`;
  if (registry.some((entry) => entry.id === plain) && !isModelDisabled(plain)) return plain;
  return model;
}

/**
 * Convert an Anthropic Messages request into the gateway's internal
 * OpenAI-shaped request. Used for every non-Anthropic provider.
 */
export function anthropicToOpenAIRequest(
  body: AnthropicMessagesBody,
  model: string,
): ChatCompletionRequest {
  const messages: Message[] = [];

  const system = flattenSystem(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of body.messages ?? []) {
    if (!message || typeof message !== "object") continue;

    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) continue;

    if (message.role === "assistant") {
      const texts: string[] = [];
      const toolCalls: ToolCall[] = [];
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        if (typeof block.text === "string" && block.type !== "thinking") texts.push(block.text);
        if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id ?? `toolu_${toolCalls.length}`,
            type: "function",
            function: {
              name: block.name ?? "",
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
        // thinking / redacted_thinking blocks cannot be represented in the
        // OpenAI format and are dropped.
      }
      const text = texts.join("");
      const content = text.length > 0 ? text : toolCalls.length > 0 ? null : "";
      messages.push({
        role: "assistant",
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // user turn: tool_result blocks become `role: "tool"` messages and must be
    // emitted before any accompanying user text.
    const parts: ContentPart[] = [];
    const toolMessages: Message[] = [];
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_result") {
        toolMessages.push({
          role: "tool",
          tool_call_id: block.tool_use_id ?? "",
          content: flattenToolResultContent(block.content),
        });
      } else if (typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        const part = imageContentPart(block);
        if (part) parts.push(part);
      }
    }
    messages.push(...toolMessages);
    if (parts.length === 1 && parts[0].type === "text") {
      messages.push({ role: "user", content: parts[0].text ?? "" });
    } else if (parts.length > 0) {
      messages.push({ role: "user", content: parts });
    }
  }

  if (!messages.some((message) => message.role !== "system")) {
    messages.push({ role: "user", content: "" });
  }

  const routedModel = withThinkingVariant(model, body);
  const request: ChatCompletionRequest = { model: routedModel, messages };

  if (body.stream === true) request.stream = true;
  if (typeof body.max_tokens === "number") request.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.top_p === "number") request.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    request.stop = body.stop_sequences;
  }
  if (typeof body.metadata?.["user_id"] === "string") {
    request.user = clampIdentifier(body.metadata["user_id"]);
  }

  if (Array.isArray(body.tools)) {
    const tools: Tool[] = body.tools
      .filter((tool) => tool && typeof tool.name === "string" && tool.name.length > 0)
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema ?? { type: "object", properties: {} },
        },
      }));
    if (tools.length > 0) request.tools = tools;
  }

  const toolChoice = convertToolChoice(body.tool_choice);
  if (toolChoice !== undefined) request.tool_choice = toolChoice;

  return request;
}

// ── OpenAI → Anthropic response conversion ──────────────────────────────────

function safeParseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function mapFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    default:
      return "end_turn";
  }
}

function newMessageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function anthropicMessageFromOpenAI(
  response: ChatCompletionResponse,
  requestedModel: string,
): AnthropicMessageResponse {
  const choice = response.choices?.[0];
  const content: Array<Record<string, unknown>> = [];

  const text = choice?.message?.content;
  if (typeof text === "string" && text.length > 0) {
    content.push({ type: "text", text });
  }
  for (const call of choice?.message?.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id || `toolu_${content.length}`,
      name: call.function?.name ?? "",
      input: safeParseArguments(call.function?.arguments),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: newMessageId(),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Re-encode an OpenAI chat-completion stream as Anthropic Messages SSE events.
 *
 * Event order follows the Anthropic spec: `message_start`, `content_block_start`
 * / `content_block_delta` / `content_block_stop` per block, then `message_delta`
 * (stop reason + output tokens) and `message_stop`. Claude Code's streaming
 * parser rejects a reply that is missing `message_stop`, so the final events are
 * emitted even when the upstream stream ends abruptly.
 */
export async function writeOpenAIStreamAsAnthropic(
  stream: AsyncIterable<StreamChunk>,
  write: (chunk: string) => void,
  model: string,
  estimatedInputTokens: number,
): Promise<void> {
  let nextIndex = 0;
  let open: { index: number; kind: "text" | "tool"; openaiIndex?: number } | null = null;
  const toolBlocks = new Map<number, { index: number; id: string; name: string }>();
  let stopReason = "end_turn";
  let outputChars = 0;

  const send = (event: string, payload: Record<string, unknown>): void => {
    write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const closeOpen = (): void => {
    if (!open) return;
    send("content_block_stop", { type: "content_block_stop", index: open.index });
    open = null;
  };

  const openText = (): number => {
    if (!open || open.kind !== "text") {
      closeOpen();
      const index = nextIndex++;
      send("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      open = { index, kind: "text" };
    }
    return open.index;
  };

  send("message_start", {
    type: "message_start",
    message: {
      id: newMessageId(),
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
    },
  });

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      const index = openText();
      outputChars += delta.content.length;
      send("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    for (const call of delta.tool_calls ?? []) {
      const toolIndex = typeof call.index === "number" ? call.index : 0;
      let block = toolBlocks.get(toolIndex);
      if (!block) {
        closeOpen();
        const index = nextIndex++;
        block = {
          index,
          id: call.id || `toolu_${Date.now().toString(36)}${toolBlocks.size}`,
          name: call.function?.name ?? "",
        };
        toolBlocks.set(toolIndex, block);
        send("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        });
        open = { index, kind: "tool", openaiIndex: toolIndex };
      } else if (!open || open.kind !== "tool" || open.openaiIndex !== toolIndex) {
        // A tool block was already started and closed; Claude Code accumulates
        // argument deltas by index, so continuing to emit them is safe.
        closeOpen();
        open = { index: block.index, kind: "tool", openaiIndex: toolIndex };
      }
      if (!block.name && call.function?.name) block.name = call.function.name;
      if (typeof call.function?.arguments === "string" && call.function.arguments.length > 0) {
        send("content_block_delta", {
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: call.function.arguments },
        });
      }
    }

    if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason);
  }

  closeOpen();

  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: Math.max(1, Math.ceil(outputChars / 4)) },
  });
  send("message_stop", { type: "message_stop" });
}

/**
 * Strip a thinking suffix from a resolved registry id before it is sent
 * upstream, returning the level it encoded. Anthropic expects the bare model
 * plus a `thinking` object, not the gateway's variant id.
 */
export function stripThinkingForUpstream(model: string): {
  model: string;
  level: string | null;
  thinking: boolean;
} {
  const { base, level, thinking } = splitThinkingSuffix(model);
  return { model: base, level, thinking };
}
