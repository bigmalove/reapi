import { Router, type Request, type Response as ExpressResponse } from "express";
import { extractProvidedKey, getProxyKey, requireAuth } from "../../lib/auth.js";
import { getDefaultModel, isModelDisabled, resolveProvider } from "../../lib/models.js";
import { getSettings } from "../../lib/settings.js";
import { resolveProviderEndpoint } from "../../lib/providerEndpoint.js";
import {
  MAX_ATTEMPTS,
  MAX_ATTEMPTS_NODE_FAULT,
  callProvider,
  isNodeFault,
} from "../../lib/providerDispatch.js";
import {
  handleEmptyUpstreamStream,
  maybeDisableSelectedNode,
} from "../../lib/upstreamNodeFailure.js";
import { asUpstreamHttpError, looksLikeUnknownModel } from "../../lib/upstreamError.js";
import {
  getModelObservations,
  recordModelObservation,
  routeClaudeCodeModel,
  sanitizeAnthropicBeta,
} from "../../lib/claudeCode.js";
import {
  anthropicError,
  anthropicMessageFromOpenAI,
  anthropicToOpenAIRequest,
  buildNativeAnthropicBody,
  estimateAnthropicInputTokens,
  parseAnthropicErrorBody,
  stripThinkingForUpstream,
  writeOpenAIStreamAsAnthropic,
  type AnthropicMessageResponse,
  type AnthropicMessagesBody,
} from "../../lib/anthropicInbound.js";
import { logger } from "../../lib/logger.js";
import type { ChatCompletionResponse, StreamChunk } from "../../types.js";

/**
 * Anthropic Messages API entry point, so Claude Code can use this gateway by
 * pointing `ANTHROPIC_BASE_URL` at it.
 *
 * Claude models are proxied natively to an Anthropic upstream (thinking blocks,
 * cache_control breakpoints and tool_use ids survive untouched). Every other
 * model is converted to the gateway's OpenAI-shaped request and the reply is
 * re-encoded as Anthropic SSE events.
 */

const router = Router();

function anthropicAuth(req: Request, res: ExpressResponse, next: () => void): void {
  const proxyKey = getProxyKey();
  if (!proxyKey) {
    next();
    return;
  }
  if (extractProvidedKey(req) !== proxyKey) {
    // Claude Code reads the Anthropic error envelope, not OpenAI's.
    res.status(401).json(anthropicError("authentication_error", "invalid x-api-key"));
    return;
  }
  next();
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function statusToErrorType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

function setSseHeaders(res: ExpressResponse): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

// ── Native Anthropic relay ──────────────────────────────────────────────────

interface RelayOutcome {
  /** True once the first event reached the client. */
  started: boolean;
  events: number;
}

/**
 * Relay an upstream Anthropic SSE stream verbatim, rewriting only the `model`
 * echoed in `message_start` so the client sees the id it asked for.
 *
 * Headers are withheld until the first event arrives: an upstream that answers
 * 200 and then closes without a single event can still be retried on another
 * pool node.
 */
async function relayAnthropicStream(
  upstream: Response,
  res: ExpressResponse,
  requestedModel: string,
): Promise<RelayOutcome> {
  if (!upstream.body) return { started: false, events: 0 };

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let started = false;
  let events = 0;
  let aborted = false;

  const writeBlock = (raw: string): "ok" | "retry" => {
    if (aborted) return "ok";
    const dataLines: string[] = [];
    let eventName = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) {
      if (started && raw.trim()) {
        try {
          res.write(`${raw}\n\n`);
        } catch {
          aborted = true;
        }
      }
      return "ok";
    }

    const dataText = dataLines.join("\n");
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(dataText) as Record<string, unknown>;
    } catch {
      parsed = null;
    }

    const type = typeof parsed?.["type"] === "string" ? (parsed["type"] as string) : eventName;

    // An in-band error before any content is a node-level failure: let the
    // caller cool the node down and retry instead of surfacing it.
    if (type === "error" && !started) return "retry";

    if (type === "message_start" && parsed) {
      const message = parsed["message"];
      if (message && typeof message === "object") {
        (message as Record<string, unknown>)["model"] = requestedModel;
      }
    }

    if (!started) {
      setSseHeaders(res);
      started = true;
    }

    try {
      res.write(`event: ${type || "message"}\n`);
      res.write(`data: ${parsed ? JSON.stringify(parsed) : dataText}\n\n`);
    } catch {
      aborted = true;
      return "ok";
    }
    if (type !== "ping") events++;
    return "ok";
  };

  try {
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (writeBlock(block) === "retry") {
          await reader.cancel().catch(() => {});
          return { started: false, events: 0 };
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (!aborted && buffer.trim()) writeBlock(buffer);
  } finally {
    reader.releaseLock();
  }

  if (aborted) return { started, events };
  if (started) res.end();
  return { started, events };
}

/** Re-encode a complete Anthropic message as an SSE stream. */
function writeMessageAsStream(
  res: ExpressResponse,
  message: AnthropicMessageResponse,
  requestedModel: string,
): void {
  setSseHeaders(res);
  const write = (event: string, payload: Record<string, unknown>): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  write("message_start", {
    type: "message_start",
    message: { ...message, model: requestedModel, content: [], stop_reason: null },
  });

  message.content.forEach((block, index) => {
    if (block["type"] === "tool_use") {
      write("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block["id"], name: block["name"], input: {} },
      });
      write("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block["input"] ?? {}) },
      });
    } else if (block["type"] === "thinking") {
      write("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      });
      write("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: String(block["thinking"] ?? "") },
      });
    } else {
      write("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      write("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: String(block["text"] ?? "") },
      });
    }
    write("content_block_stop", { type: "content_block_stop", index });
  });

  write("message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens },
  });
  write("message_stop", { type: "message_stop" });
  res.end();
}

interface NativeAttempt {
  /** The response was fully handled (or relayed): stop retrying. */
  done: boolean;
  /** The failure is a node-level fault, so a retry may land on a good node. */
  nodeFault: boolean;
  error?: Error;
}

/**
 * Body fields that must never be dropped: removing one would silently change
 * what the model sees (system prompt, history) or invalidate the request.
 */
const CORE_NATIVE_FIELDS = new Set(["model", "messages", "system", "max_tokens", "stream"]);

/**
 * Anthropic gates several body fields behind betas — `context_management`,
 * `container`, `mcp_servers`, `service_tier`, and whatever Claude Code adds
 * next — and an endpoint that does not implement one rejects the whole request
 * with `"<field>: Extra inputs are not permitted"`. Intermediaries (Replit's
 * modelfarm proxy, older pool nodes) do exactly that, and Claude Code sends
 * `context_management` on every single request, so proxying it blindly turns
 * every call into a 400.
 *
 * Instead of maintaining a field blacklist that goes stale, the offending field
 * is read out of the error and stripped, then the request is retried once. What
 * was learned is remembered per upstream URL, so only the first request to a
 * given endpoint pays the extra round trip.
 */
const learnedUnsupportedFields = new Map<string, Set<string>>();
const MAX_LEARNED_UPSTREAMS = 32;
const MAX_STRIP_ROUNDS = 4;

function learnedFieldsFor(baseUrl: string): Set<string> {
  let fields = learnedUnsupportedFields.get(baseUrl);
  if (!fields) {
    if (learnedUnsupportedFields.size >= MAX_LEARNED_UPSTREAMS) learnedUnsupportedFields.clear();
    fields = new Set();
    learnedUnsupportedFields.set(baseUrl, fields);
  }
  return fields;
}

function rememberUnsupportedField(baseUrl: string, field: string): void {
  learnedFieldsFor(baseUrl).add(field);
}

/** `"context_management: Extra inputs are not permitted"` → `context_management`. */
function extractExtraInputField(text: string): string | null {
  const match = text.match(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*Extra inputs are not permitted/i);
  return match ? match[1]! : null;
}

async function forwardNativeOnce(args: {
  res: ExpressResponse;
  body: AnthropicMessagesBody;
  model: string;
  requestedModel: string;
  stream: boolean;
  clientHeaders: Record<string, string>;
}): Promise<NativeAttempt> {
  const { res, body, model, requestedModel, stream, clientHeaders } = args;
  const endpoint = resolveProviderEndpoint("anthropic");

  const { model: upstreamModel, level, thinking } = stripThinkingForUpstream(model);
  const outbound = buildNativeAnthropicBody(body, upstreamModel, {
    thinkingLevel: level,
    thinkingRequested: thinking,
  });

  const outboundHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": endpoint.apiKey,
    "anthropic-version": clientHeaders["anthropic-version"] ?? "2023-06-01",
    // Pool nodes gate their SSE path on this header; without it a streaming
    // request takes the node's keep-alive heartbeat path (empty placeholder).
    ...(stream ? { Accept: "text/event-stream" } : {}),
    ...(clientHeaders["anthropic-beta"]
      ? { "anthropic-beta": clientHeaders["anthropic-beta"] }
      : {}),
  };

  const url = `${endpoint.baseUrl}/v1/messages`;

  // Drop fields this endpoint already rejected once, so later requests do not
  // pay for the discovery round trip again.
  for (const field of learnedFieldsFor(endpoint.baseUrl)) delete outbound[field];

  let response: Response | null = null;
  let failure: { status: number; text: string } | null = null;

  for (let round = 0; ; round++) {
    try {
      response = await fetch(url, {
        method: "POST",
        headers: outboundHeaders,
        body: JSON.stringify(outbound),
      });
    } catch (err) {
      return {
        done: false,
        nodeFault: true,
        error: new Error(
          `Anthropic request failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      };
    }
    if (response.ok) break;

    const text = await response.text();
    const field = response.status === 400 ? extractExtraInputField(text) : null;
    if (field && !CORE_NATIVE_FIELDS.has(field) && field in outbound && round < MAX_STRIP_ROUNDS) {
      delete outbound[field];
      rememberUnsupportedField(endpoint.baseUrl, field);
      logger.warn(
        { field, url, round: round + 1 },
        "upstream rejected an optional Anthropic body field — dropping it and retrying",
      );
      continue;
    }

    // `safety_identifier is too long. Maximum length: 32 bytes.` A relay ahead
    // of Anthropic maps `metadata.user_id` onto OpenAI's safety_identifier; the
    // gateway already clamps it to 32 bytes, so a remaining rejection means
    // this upstream wants it shorter still (or rejects the field outright).
    // Identity metadata is only used for abuse grouping — drop it and retry.
    const identifierTooLong =
      response.status === 400 &&
      /safety_identifier|(?:user_?id).{0,40}too long|too long.{0,40}(?:user_?id)/i.test(text);
    if (identifierTooLong && ("metadata" in outbound || "safety_identifier" in outbound) && round < MAX_STRIP_ROUNDS) {
      delete outbound["metadata"];
      delete outbound["safety_identifier"];
      logger.warn(
        { url, round: round + 1 },
        "upstream rejected the identity metadata — dropping it and retrying",
      );
      continue;
    }

    failure = { status: response.status, text };
    break;
  }

  if (failure) {
    maybeDisableSelectedNode({
      endpoint,
      responseStatus: failure.status,
      responseBody: failure.text,
    });
    const nodeFault = failure.status === 429 || failure.status >= 500;
    if (nodeFault) {
      return {
        done: false,
        nodeFault: true,
        error: new Error(`Anthropic error ${failure.status}: ${failure.text.slice(0, 2000)}`),
      };
    }
    // A genuine client-side error (bad request, unknown model, auth) is relayed
    // untouched so Claude Code can show the upstream message.
    res
      .status(failure.status)
      .json(parseAnthropicErrorBody(failure.text, statusToErrorType(failure.status)));
    return { done: true, nodeFault: false };
  }

  const ok = response as Response;
  const contentType = ok.headers.get("content-type") ?? "";

  if (!stream) {
    const text = await ok.text();
    try {
      const parsed = JSON.parse(text) as AnthropicMessageResponse;
      parsed.model = requestedModel;
      res.json(parsed);
    } catch {
      return {
        done: false,
        nodeFault: true,
        error: new Error(`Anthropic returned non-JSON body: ${text.slice(0, 500)}`),
      };
    }
    return { done: true, nodeFault: false };
  }

  // Streaming was requested but the node ignored it and answered with a whole
  // message. Re-encode it as SSE so Claude Code's stream parser still gets a
  // complete, well-formed event sequence.
  if (!contentType.includes("text/event-stream")) {
    const text = await ok.text();
    let parsed: (AnthropicMessageResponse & { type?: string; error?: unknown }) | null = null;
    try {
      parsed = JSON.parse(text) as AnthropicMessageResponse & { type?: string; error?: unknown };
    } catch {
      parsed = null;
    }
    if (parsed && parsed.type === "message" && Array.isArray(parsed.content)) {
      writeMessageAsStream(res, parsed, requestedModel);
      return { done: true, nodeFault: false };
    }
    return {
      done: false,
      nodeFault: true,
      error: new Error(
        `Anthropic stream request returned ${contentType || "an unknown content type"}: ${text.slice(0, 500)}`,
      ),
    };
  }

  const outcome = await relayAnthropicStream(ok, res, requestedModel);
  if (!outcome.started) {
    handleEmptyUpstreamStream(endpoint);
    return {
      done: false,
      nodeFault: true,
      error: new Error("Anthropic upstream returned an empty stream"),
    };
  }
  return { done: true, nodeFault: false };
}

async function proxyAnthropicNative(args: {
  res: ExpressResponse;
  body: AnthropicMessagesBody;
  model: string;
  requestedModel: string;
  stream: boolean;
  clientHeaders: Record<string, string>;
}): Promise<void> {
  let last: NativeAttempt | null = null;

  for (let attempt = 1; ; attempt++) {
    const result = await forwardNativeOnce(args);
    if (result.done) return;
    last = result;

    const limit = result.nodeFault ? MAX_ATTEMPTS_NODE_FAULT : MAX_ATTEMPTS;
    if (attempt >= limit) break;
    logger.warn(
      { err: result.error, attempt, limit, model: args.model },
      "claude code upstream attempt failed, retrying",
    );
  }

  const message = last?.error?.message ?? "Anthropic upstream failed";
  if (!args.res.headersSent) {
    args.res.status(502).json(anthropicError("api_error", message));
  } else {
    args.res.end();
  }
}

// ── Converted path (any non-Anthropic provider) ─────────────────────────────

/**
 * Report a failed converted request with the upstream's own status and message.
 *
 * A mapped id such as `anthropic/claude-opus-5.5` is routed to OpenRouter; when
 * OpenRouter rejects it (unknown slug, no endpoint for the requested channel,
 * quota), the client needs that answer, not a generic 502. A 404 also carries
 * the fix: the id is not in the gateway registry, so it must be added or mapped.
 */
function relayConvertedFailure(
  res: ExpressResponse,
  err: unknown,
  model: string,
  requestedModel: string,
  provider: string,
): void {
  const upstream = asUpstreamHttpError(err);
  const rawBody = upstream?.body ?? (err instanceof Error ? err.message : String(err));

  let message = rawBody;
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof parsed.error === "string") message = parsed.error;
    else if (parsed.error && typeof parsed.error.message === "string") message = parsed.error.message;
    else if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // not JSON — keep the raw text
  }
  message = message.slice(0, 2000);

  const status = upstream?.status ?? 502;
  const unknownModel = upstream?.status === 404 || looksLikeUnknownModel(rawBody);

  if (unknownModel) {
    const hint = ` ${provider} has no such model id. Add it in 模型管理, or map "${requestedModel}" to an existing model in 配置 → Claude Code 模型映射.`;
    logger.warn(
      { model, requestedModel, provider, upstreamStatus: upstream?.status ?? null, message },
      "claude code upstream rejected the model id",
    );
    res.status(404).json(
      anthropicError(
        "not_found_error",
        (model === requestedModel
          ? `model: ${requestedModel}.${hint}`
          : `model ${requestedModel} is mapped to ${model}.${hint}`) + ` Upstream said: ${message}`,
      ),
    );
    return;
  }

  if (upstream?.isClientError) {
    res.status(upstream.status).json(anthropicError(statusToErrorType(upstream.status), message));
    return;
  }

  if (status === 429) {
    res.status(429).json(anthropicError("rate_limit_error", message));
    return;
  }

  res.status(502).json(anthropicError("api_error", message));
}

async function proxyConverted(args: {
  res: ExpressResponse;
  body: AnthropicMessagesBody;
  model: string;
  requestedModel: string;
  stream: boolean;
  clientHeaders: Record<string, string>;
}): Promise<void> {
  const { res, body, model, requestedModel, stream, clientHeaders } = args;
  const provider = resolveProvider(model);
  if (!provider) {
    res.status(404).json(anthropicError("not_found_error", `model: ${requestedModel}`));
    return;
  }

  const request = anthropicToOpenAIRequest(body, model);
  let result: Awaited<ReturnType<typeof callProvider>> | undefined;
  let lastErr: unknown;

  for (let attempt = 1; ; attempt++) {
    try {
      result = await callProvider(provider, request, clientHeaders);
      break;
    } catch (err) {
      lastErr = err;
      // A 4xx (other than 429) names something only the caller can fix — an
      // unknown model id, a rejected parameter. Retrying sends the same
      // request to the same rejection, and reporting 502 would hide the reason.
      if (asUpstreamHttpError(err)?.isClientError) break;
      const limit = isNodeFault(err) ? MAX_ATTEMPTS_NODE_FAULT : MAX_ATTEMPTS;
      if (attempt >= limit) {
        logger.error({ err, attempt, limit, provider }, "claude code conversion attempts exhausted");
        break;
      }
      logger.warn({ err, attempt, limit, provider }, "claude code conversion attempt failed, retrying");
    }
  }

  if (result === undefined) {
    relayConvertedFailure(res, lastErr, model, requestedModel, provider);
    return;
  }

  if (!stream) {
    res.json(anthropicMessageFromOpenAI(result as ChatCompletionResponse, requestedModel));
    return;
  }

  setSseHeaders(res);
  try {
    await writeOpenAIStreamAsAnthropic(
      result as AsyncIterable<StreamChunk>,
      (chunk) => res.write(chunk),
      requestedModel,
      estimateAnthropicInputTokens(body),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stream error";
    logger.error({ err, provider }, "claude code stream error");
    res.write(`event: error\ndata: ${JSON.stringify(anthropicError("api_error", message))}\n\n`);
  } finally {
    res.end();
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

router.post("/v1/messages", anthropicAuth, async (req: Request, res: ExpressResponse) => {
  res.setTimeout(600_000);
  req.socket.setTimeout(600_000);

  const body = req.body as AnthropicMessagesBody;
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    res.status(400).json(anthropicError("invalid_request_error", "messages: field required"));
    return;
  }

  const requestedModel =
    typeof body.model === "string" && body.model.length > 0 ? body.model : getDefaultModel();
  const isUsable = (id: string) => !isModelDisabled(id);
  const route = routeClaudeCodeModel(requestedModel, getSettings().claudeCodeModelMap, isUsable);
  const model = route.model;
  const modelDisabled = route.disabled;
  recordModelObservation(requestedModel, model, route.match, modelDisabled);

  if (modelDisabled) {
    // Say which model actually failed and how to fix it: the client only knows
    // the id it sent, which may be an alias that maps elsewhere.
    const hint =
      route.match === "mapped"
        ? ` Check 配置 → Claude Code 模型映射.`
        : ` Enable it in 模型管理, or add a mapping (or a "*" fallback) in 配置 → Claude Code 模型映射.`;
    res.status(400).json(
      anthropicError(
        "invalid_request_error",
        route.match === "mapped"
          ? `model ${requestedModel} is mapped to ${model}, which is disabled.${hint}`
          : `model ${requestedModel} resolves to ${model}, which is disabled.${hint}`,
      ),
    );
    return;
  }

  const provider = resolveProvider(model);
  if (!provider) {
    res.status(404).json(anthropicError("not_found_error", `model: ${requestedModel}`));
    return;
  }

  const stream = body.stream === true;
  const clientHeaders: Record<string, string> = {
    "anthropic-version": headerValue(req, "anthropic-version") ?? "2023-06-01",
  };
  const beta = sanitizeAnthropicBeta(headerValue(req, "anthropic-beta"));
  if (beta) clientHeaders["anthropic-beta"] = beta;

  logger.info(
    {
      requestedModel,
      model,
      match: route.match,
      provider,
      stream,
      messages: body.messages.length,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      thinking: body.thinking?.type ?? null,
      beta: beta ?? null,
    },
    "claude code request",
  );

  try {
    if (provider === "anthropic") {
      await proxyAnthropicNative({ res, body, model, requestedModel, stream, clientHeaders });
    } else {
      await proxyConverted({ res, body, model, requestedModel, stream, clientHeaders });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    logger.error({ err, model }, "claude code request failed");
    if (!res.headersSent) {
      res.status(502).json(anthropicError("api_error", message));
    } else {
      res.end();
    }
  }
});

/**
 * Model ids Claude Code has actually sent, with where they were routed. The
 * portal uses this to offer one-click mappings for unknown or falling-back ids.
 * In-memory only: it is a debugging aid, not state worth persisting.
 */
router.get("/v1/admin/claude-code/models", requireAuth, (_req: Request, res: ExpressResponse) => {
  const map = getSettings().claudeCodeModelMap;
  const data = getModelObservations().map((entry) => ({
    ...entry,
    mapped: Object.prototype.hasOwnProperty.call(map, entry.requested),
    target: map[entry.requested] ?? null,
  }));
  res.json({ object: "list", count: data.length, data });
});

router.post("/v1/messages/count_tokens", anthropicAuth, async (req: Request, res: ExpressResponse) => {
  const body = req.body as AnthropicMessagesBody;
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    res.status(400).json(anthropicError("invalid_request_error", "messages: field required"));
    return;
  }

  const requestedModel =
    typeof body.model === "string" && body.model.length > 0 ? body.model : getDefaultModel();
  const { model } = routeClaudeCodeModel(
    requestedModel,
    getSettings().claudeCodeModelMap,
    (id) => !isModelDisabled(id),
  );
  const estimate = estimateAnthropicInputTokens(body);

  // Claude Code uses this endpoint for context accounting. Proxy the real
  // Anthropic counter when the model is served by Anthropic; fall back to the
  // local estimate for other providers (or when the upstream lacks the route).
  if (resolveProvider(model) === "anthropic") {
    try {
      const endpoint = resolveProviderEndpoint("anthropic");
      const { model: upstreamModel, level, thinking } = stripThinkingForUpstream(model);
      const upstreamBody = buildNativeAnthropicBody(body, upstreamModel, {
        thinkingLevel: level,
        thinkingRequested: thinking,
        forCountTokens: true,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`${endpoint.baseUrl}/v1/messages/count_tokens`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": endpoint.apiKey,
            "anthropic-version": headerValue(req, "anthropic-version") ?? "2023-06-01",
          },
          body: JSON.stringify(upstreamBody),
          signal: controller.signal,
        });
        if (response.ok) {
          const data = (await response.json()) as { input_tokens?: unknown };
          if (typeof data.input_tokens === "number") {
            res.json({ input_tokens: data.input_tokens });
            return;
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      logger.warn({ err, model }, "upstream count_tokens failed, using local estimate");
    }
  }

  res.json({ input_tokens: estimate });
});

export default router;
