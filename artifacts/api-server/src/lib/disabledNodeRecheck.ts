import { getSettings, disableUpstreamNode, FREE_TIER_RECOVERY_MS } from "./settings.js";
import { probeNodeLlm } from "./nodeProbe.js";
import { detectBudgetExceeded, extractErrorCode, extractErrorMessage } from "./upstreamNodeFailure.js";
import { logger } from "./logger.js";

/** How many entries to re-probe on boot, and how many at a time. */
const MAX_RECHECK = 50;
const CONCURRENCY = 4;

/**
 * Repair entries that were blocked on an unreadable answer.
 *
 * A 403 with an empty body used to be recorded as `forbidden` — permanently.
 * That verdict is not just wrong for nodes that were merely restarting; it is
 * unrecoverable, because `check-disabled` only restores nodes that answer 200
 * and a quota-exhausted node never will. The node then sits in the panel
 * labelled "forbidden" while it is really out of free-tier budget, and the
 * operator has no way to see that or to give it the monthly window it deserves.
 *
 * So on boot, every questionable entry gets one more real probe. If it now
 * carries a budget body it is relabelled `FREE_TIER_BUDGET_EXCEEDED` with the
 * 31-day window (and will return to the pool by itself when the month rolls
 * over); if it carries a readable error its reason is refreshed. Nothing is
 * restored here — that stays a deliberate action via 检测并恢复.
 *
 * Runs after settings load, unawaited: a slow or offline node must not delay
 * the server coming up. Failures are per-entry and non-fatal.
 */
export async function recheckQuestionableDisabledNodes(): Promise<void> {
  const all = getSettings().disabledUpstreamNodes
    .filter((e) => e.type !== "replit-dev")
    // The signature of the old bug is narrow, so the sweep stays narrow: an
    // entry recorded as `forbidden`, or one whose error text says the response
    // body was empty. Matching every entry with a blank `upstreamReason` would
    // burn a token on hundreds of legacy rows that are not in question.
    .filter(
      (e) =>
        e.upstreamReason === "forbidden" ||
        /empty response body/i.test(e.lastError ?? ""),
    );
  const candidates = all.slice(0, MAX_RECHECK);

  if (candidates.length === 0) return;
  if (all.length > candidates.length) {
    logger.warn(
      { total: all.length, probing: candidates.length },
      "more mislabelled disabled nodes than one boot sweep covers — the rest will be relabelled by the next 检测并恢复",
    );
  }
  logger.info({ count: candidates.length }, "re-probing disabled nodes recorded on an unreadable answer");

  const apiKey = getSettings().reverseProxyPool[0]?.apiKey ?? "";
  let index = 0;
  async function worker(): Promise<void> {
    while (index < candidates.length) {
      const entry = candidates[index++]!;
      try {
        const r = await probeNodeLlm(entry.url, apiKey);
        if (r.online) continue; // leave it disabled; 检测并恢复 is the way back
        const body = (r.bodyText ?? "").trim();
        const budget = detectBudgetExceeded(body);
        if (budget) {
          logger.info(
            { nodeUrl: entry.url, from: entry.upstreamReason ?? null, to: budget.code },
            "disabled node re-probed as budget-exhausted — relabelling with the monthly window",
          );
          disableUpstreamNode({
            url: entry.url,
            disabledReason: "upstream-node-unavailable",
            upstreamReason: budget.code,
            upstreamStatus: r.status,
            lastError: budget.message,
            recoverAfterMs: FREE_TIER_RECOVERY_MS,
          });
        } else if (r.status === 403 && body) {
          const reason = extractErrorCode(body) ?? "forbidden";
          const lastError = extractErrorMessage(body) ?? body.slice(0, 300);
          if (entry.upstreamReason === reason && entry.lastError === lastError) continue;
          disableUpstreamNode({
            url: entry.url,
            disabledReason: "upstream-node-unavailable",
            upstreamReason: reason,
            upstreamStatus: r.status,
            lastError,
          });
        }
      } catch (err) {
        logger.debug({ err, nodeUrl: entry.url }, "re-probe of a disabled node failed");
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));
}
