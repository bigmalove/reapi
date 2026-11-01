/**
 * Output budget used whenever the client does not send `max_tokens`.
 *
 * Deliberately "as large as the upstream allows" instead of a conservative
 * 4k/8k/16k default. On thinking models the reasoning tokens are billed against
 * this very budget, so a small default is what silently produces a zero-content
 * answer with `finish_reason: "length"` — the client renders that as "已达到输出
 * token 上限，回答被截断" over an empty reply. The budget only caps an answer; it
 * does not force the model to use it.
 *
 * An explicit `max_tokens` from the client always wins: this is a default, not a
 * clamp. Override the default with `MAX_OUTPUT_TOKENS` when a specific upstream
 * rejects the value (some small models cap output far below their context
 * window, e.g. legacy haiku/gpt-4o at 8k/16k).
 */
const FALLBACK_MAX_OUTPUT_TOKENS = 64_000;

function readOverride(): number | null {
  const raw = process.env["MAX_OUTPUT_TOKENS"]?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export const DEFAULT_MAX_OUTPUT_TOKENS: number = readOverride() ?? FALLBACK_MAX_OUTPUT_TOKENS;

/** The client's budget when it sent a usable one, otherwise the maximum. */
export function resolveMaxOutputTokens(requested: unknown): number {
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * Does this rejection mean "the budget you asked for is larger than I accept"?
 *
 * The maximum default is only correct for models that actually allow it; a few
 * small ones (legacy haiku, gpt-4o, some third-party relays) answer 400/422
 * instead. Those requests must not fail — they should be replayed with a
 * smaller budget, which `shrinkOutputBudget()` provides.
 */
export function looksLikeOutputLimitRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const namesBudget = /max[_ ]?(?:output|completion)?[_ ]?tokens|maxOutputTokens/i.test(body);
  const rejectsSize = /too (?:large|many|high|long)|exceed(?:s|ed)?|maximum|greater than|must be (?:less|lower|smaller)/i.test(body);
  return namesBudget && rejectsSize;
}

/**
 * Halve a request's output budget in place so a rejected "too large" request can
 * be retried. Returns the new budget, or null when there is nothing left to cut.
 */
export function shrinkOutputBudget(request: { max_tokens?: number }): number | null {
  const current = resolveMaxOutputTokens(request.max_tokens);
  const next = Math.max(1024, Math.floor(current / 2));
  if (next >= current) return null;
  request.max_tokens = next;
  return next;
}
