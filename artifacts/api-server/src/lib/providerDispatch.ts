import type { ChatCompletionRequest, ChatCompletionResponse, StreamChunk } from "../types.js";
import type { Provider } from "./models.js";
import { callOpenAI } from "../providers/openai.js";
import { callAnthropic } from "../providers/anthropic.js";
import { callGemini } from "../providers/gemini.js";
import { callOpenRouter } from "../providers/openrouter.js";

/**
 * Shared provider dispatch and retry policy, used by both the OpenAI-compatible
 * `/v1/chat/completions` route and the Anthropic-compatible `/v1/messages`
 * route so the two entry points cannot drift apart.
 */

export const MAX_ATTEMPTS = 3;

// A node-level 5xx (`<Provider> error 5xx: ...`) means "this node cannot serve
// right now", not "this request is wrong". The pool is heterogeneous — a large
// share of nodes answer 500 while their neighbours are healthy — and each such
// failure cools the node down and moves it to the tail of the pool, so extra
// attempts converge on a working node instead of repeating the same one. Keep
// the budget for every other error, where a retry would just resend the same
// rejected request.
export const MAX_ATTEMPTS_NODE_FAULT = 6;

/** Does this error come from an upstream node returning 5xx? */
export function isNodeFault(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\berror 5\d\d\b/.test(message);
}

export type ProviderResult = ChatCompletionResponse | AsyncIterable<StreamChunk>;

export function callProvider(
  provider: Provider,
  request: ChatCompletionRequest,
  clientHeaders: Record<string, string> = {},
): Promise<ProviderResult> {
  switch (provider) {
    case "openai":
      return callOpenAI(request, clientHeaders);
    case "anthropic":
      return callAnthropic(request, clientHeaders);
    case "gemini":
      return callGemini(request, clientHeaders);
    case "openrouter":
      return callOpenRouter(request, clientHeaders);
    default:
      return Promise.reject(new Error(`Unknown provider: ${String(provider)}`));
  }
}
