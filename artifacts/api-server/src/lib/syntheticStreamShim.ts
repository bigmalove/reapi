import { randomBytes } from "node:crypto";
import type { StreamChunk } from "../types.js";

/**
 * Synthetic stream shim for the Antigravity Gateway ("agw") anti-truncation
 * wrapper.
 *
 * Background
 * ----------
 * The wrapper injects a randomly-named transport tool and instructs the model
 * to put the entire user-visible answer into its `content` argument
 * (`SYNTHETIC_TOOL_DESCRIPTION` below is its fixed, unique anchor). On Google
 * models routed through OpenRouter the whole tool call is buffered upstream:
 * the function-call arguments arrive as ONE chunk at the very end, so a
 * wrapped answer reaches the client only once, no matter how slowly the model
 * actually wrote it. OpenRouter exposes no request-side switch to enable
 * incremental function arguments (`streamFunctionCallArguments` precedence),
 * and the deployment's node layer is a plain passthrough.
 *
 * What this module does
 * ---------------------
 * For such requests — and ONLY when the synthetic tool is the sole tool on a
 * streaming request — rewrite the upstream request so the model answers with
 * plain text, then re-encode the streamed text chunks into incremental
 * `tool_calls[0].function.arguments` deltas shaped exactly like the fragments
 * an upstream with incremental function arguments would emit:
 *
 *   {"content":"<fragment 1…>`  →  `…<fragment 2…>`  →  `…"}` (on clean stop)
 *
 * Semantics preserved for the wrapper:
 *  - the first fragment carries the synthetic tool name (the wrapper pairs by
 *    name/index exactly like it does for native tool streams);
 *  - a clean `stop` closes the JSON and maps to `finish_reason: "tool_calls"`;
 *  - a truncated stream (`length`, `content_filter`, mid-stream errors, …) is
 *    left UNTERMINATED (no closing quote/brace) so the wrapper keeps its
 *    truncation signal and can repair/retry as configured;
 *  - reasoning/role deltas pass through untouched.
 *
 * Control (most specific wins):
 *  1. per-request header `x-agw-stream-shim: on|off` — A/B tests, client control
 *  2. environment `SYNTHETIC_STREAM_SHIM=on|off` — deployment-level override
 *  3. server setting `syntheticStreamShim` — admin portal toggle (default on)
 */

import { getSettings } from "./settings.js";

/** Fixed description of the Antigravity Gateway synthetic transport tool. */
export const SYNTHETIC_TOOL_DESCRIPTION =
  "Use this transport tool exactly once for the final user-visible answer. Put the complete answer in content. Never wrap genuine tool calls in it.";

/**
 * Client-side transport tools. Presets running inside the client (e.g. the
 * SillyTavern "防截断" wrapper) inject their own single tool and ask the model
 * to write the whole answer into its `content` argument. Google models on
 * OpenRouter buffer those arguments to the very end of the generation exactly
 * like the gateway tool above, so the same request rewrite applies — the only
 * difference is on the response side: the client consumes the answer as plain
 * message text, so it wants the (now incremental) text stream untouched
 * instead of a re-encoded tool-call stream.
 */
const CLIENT_TRANSPORT_TOOL_NAME = "game_content";
const CLIENT_TRANSPORT_TOOL_HINT = "你的全部输出应当在此工具内";

/** tool_choice values that still leave the tool set optional. */
function isOptionalToolChoice(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && (value === "auto" || value === "none");
}

const OPEN_ARGS = '{"content":"';
const CLOSE_ARGS = '"}';
const REASONING_KEYS = ["reasoning_content", "reasoning"] as const;

const FLAG_TRUE = new Set(["on", "true", "1", "yes", "enabled"]);
const FLAG_FALSE = new Set(["off", "false", "0", "no", "disabled"]);

/** Parse an on/off style flag; null when absent or unrecognized. */
function parseFlag(raw: string | undefined | null): boolean | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  if (FLAG_TRUE.has(value)) return true;
  if (FLAG_FALSE.has(value)) return false;
  return null;
}

/**
 * Resolve whether the synthetic stream shim is enabled for a request.
 * Precedence: `x-agw-stream-shim` header > `SYNTHETIC_STREAM_SHIM` env >
 * server setting `syntheticStreamShim` (default on).
 */
export function resolveShimEnabled(headerValue?: string | null): boolean {
  const fromHeader = parseFlag(headerValue);
  if (fromHeader !== null) return fromHeader;
  const fromEnv = parseFlag(process.env["SYNTHETIC_STREAM_SHIM"]);
  if (fromEnv !== null) return fromEnv;
  return getSettings().syntheticStreamShim;
}

export interface SyntheticStreamPlan {
  /** Name of the synthetic tool that was stripped from the request. */
  toolName: string;
  /** Request body for upstream: synthetic tool removed, answer asked as text. */
  body: Record<string, unknown>;
  /**
   * Whether the upstream response must be re-encoded back into tool_call
   * argument deltas. The AGW wrapper needs its tool-call shape back; a
   * client-side transport preset (SillyTavern) wants the plain streamed text
   * untouched instead — re-encoding would only add buffering for it.
   */
  reencode: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Detect a pure-text synthetic-tool streaming request and build the rewritten
 * upstream body. Returns null when the request is not such a request (then the
 * caller keeps the original body and transport unchanged).
 *
 * Scope note: requests that also carry genuine downstream tools keep the
 * original transport — the model may need to call real tools, and rewriting
 * the tool set there is riskier than it is valuable.
 */
export function planSyntheticStreamShim(
  body: Record<string, unknown>,
): SyntheticStreamPlan | null {
  const tools = body["tools"];
  if (!Array.isArray(tools) || tools.length !== 1) return null;

  const tool = asRecord(tools[0]);
  const fn = tool ? asRecord(tool["function"]) : null;
  if (!tool || tool["type"] !== "function" || !fn) return null;
  if (typeof fn["name"] !== "string" || fn["name"].length === 0) return null;

  const isGatewayTool = fn["description"] === SYNTHETIC_TOOL_DESCRIPTION;
  const isClientTransportTool =
    fn["name"] === CLIENT_TRANSPORT_TOOL_NAME &&
    typeof fn["description"] === "string" &&
    fn["description"].includes(CLIENT_TRANSPORT_TOOL_HINT);
  if (!isGatewayTool && !isClientTransportTool) return null;

  // The client tool is only shimmed when the caller leaves the choice to the
  // model; a forced tool_choice demands this exact call and wins over the
  // rewrite. (The gateway tool has always been shimmed unconditionally.)
  if (isClientTransportTool && !isOptionalToolChoice(body["tool_choice"])) return null;

  const toolName = fn["name"];

  const clean: Record<string, unknown> = { ...body };
  delete clean["tools"];
  delete clean["tool_choice"];
  delete clean["parallel_tool_calls"];

  // Replace the injected control message(s) — they reference the (now removed)
  // transport tool — with an equivalent "answer as text" instruction. Other
  // messages are left untouched.
  const rawMessages = clean["messages"];
  if (Array.isArray(rawMessages)) {
    const messages = [...rawMessages];
    for (let i = 0; i < messages.length; i++) {
      const msg = asRecord(messages[i]);
      if (!msg || typeof msg["content"] !== "string") continue;
      if (!msg["content"].includes(toolName)) continue;
      const role = typeof msg["role"] === "string" ? msg["role"] : "";
      messages[i] = {
        ...msg,
        content:
          role === "system" || role === "developer"
            ? "Respond to the user directly with the final answer as plain text."
            : "Please reply with your final answer directly as plain text.",
      };
    }
    clean["messages"] = messages;
  }

  return { toolName, body: clean, reencode: isGatewayTool };
}

/**
 * Escape one content fragment for embedding inside a JSON string. JSON.stringify
 * escapes exactly what must be escaped (quotes, backslash, control characters,
 * and lone surrogates since ES2019 — so a surrogate pair split across upstream
 * chunks becomes `\ud83d` + `\ude00`, which the wrapper's incremental decoder
 * recombines), so we only strip the surrounding quotes it adds.
 */
function escapeFragment(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

function makeToolChunk(
  like: StreamChunk,
  args: string,
  first: boolean,
  callId: string,
  toolName: string,
): StreamChunk {
  const fn: Record<string, unknown> = { arguments: args };
  if (first) fn["name"] = toolName;
  const toolCall: Record<string, unknown> = { index: 0, function: fn };
  if (first) {
    toolCall["id"] = callId;
    toolCall["type"] = "function";
  }
  const chunk: Record<string, unknown> = {
    id: like.id,
    object: "chat.completion.chunk",
    created: like.created,
    model: like.model,
    choices: [
      {
        index: 0,
        delta: { tool_calls: [toolCall] },
        finish_reason: null,
      },
    ],
  };
  return chunk as unknown as StreamChunk;
}

/**
 * Wrap the upstream content stream and re-encode it into incremental
 * synthetic-tool argument deltas. See module docs for the exact semantics.
 */
export async function* wrapSyntheticToolStream(
  upstream: AsyncIterable<StreamChunk>,
  toolName: string,
): AsyncIterable<StreamChunk> {
  const callId = `call_agw_${randomBytes(6).toString("hex")}`;
  let started = false;
  let closed = false;

  for await (const chunk of upstream) {
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const first = choices[0];
    if (choices.length !== 1 || !first || first.index !== 0) {
      yield chunk;
      continue;
    }

    const delta = (first.delta ?? {}) as unknown as Record<string, unknown>;

    // An upstream tool call is never expected here (all tools were stripped).
    // Forward it untouched rather than guessing.
    if (Array.isArray(delta["tool_calls"]) && delta["tool_calls"].length > 0) {
      yield chunk;
      continue;
    }

    // Preserve non-answer deltas (role / reasoning) verbatim.
    const passthrough: Record<string, unknown> = {};
    if (typeof delta["role"] === "string") passthrough["role"] = delta["role"];
    for (const key of REASONING_KEYS) {
      if (typeof delta[key] === "string" && delta[key] !== "") passthrough[key] = delta[key];
    }
    if (Object.keys(passthrough).length > 0) {
      yield {
        id: chunk.id,
        object: "chat.completion.chunk",
        created: chunk.created,
        model: chunk.model,
        choices: [{ index: 0, delta: passthrough, finish_reason: null }],
      } as unknown as StreamChunk;
    }

    const content = typeof delta["content"] === "string" ? delta["content"] : "";
    if (content !== "") {
      const fragment = escapeFragment(content);
      if (!started) {
        started = true;
        yield makeToolChunk(chunk, OPEN_ARGS + fragment, true, callId, toolName);
      } else {
        yield makeToolChunk(chunk, fragment, false, callId, toolName);
      }
    }

    const finish = first.finish_reason ?? null;
    if (finish !== null) {
      // Only a clean stop closes the arguments JSON. Anything else (length,
      // content_filter, …) stays unterminated so the wrapper sees truncation.
      const cleanStop = started && (finish === "stop" || finish === "tool_calls");
      if (cleanStop && !closed) {
        yield makeToolChunk(chunk, CLOSE_ARGS, false, callId, toolName);
        closed = true;
      }
      const out: Record<string, unknown> = {
        id: chunk.id,
        object: "chat.completion.chunk",
        created: chunk.created,
        model: chunk.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: cleanStop ? "tool_calls" : finish,
          },
        ],
      };
      const usage = (chunk as unknown as Record<string, unknown>)["usage"];
      if (usage !== undefined) out["usage"] = usage;
      yield out as unknown as StreamChunk;
    }
  }
}
