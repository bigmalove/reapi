import { disableUpstreamNode, REPLIT_HOSTING_SHUTDOWN } from "./settings.js";
import { logger } from "./logger.js";
import { setNodeCooldown } from "./providerEndpoint.js";
import type { ProviderEndpoint } from "./providerEndpoint.js";

interface NodeDisableSignal {
  provider: string;
  reason: string;
  upstreamStatus?: number;
  message: string;
}

type NodeSignal =
  | ({ action: "disable" } & NodeDisableSignal)
  | { action: "cooldown"; upstreamStatus: number }
  | null;

export const FREE_TIER_BUDGET_EXCEEDED = "FREE_TIER_BUDGET_EXCEEDED";

const BUDGET_EXCEEDED_PATTERNS: RegExp[] = [
  /FREE_TIER_BUDGET_EXCEEDED/i,
  /spend limit exceeded/i,
  /spending limit exceeded/i,
  /budget (?:limit )?exceeded/i,
  /upgrade to a paid plan/i,
];

/** Pull `error.message` (or a top-level `message`) out of a JSON error body. */
function extractErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.error === "string" && parsed.error) return parsed.error.slice(0, 300);
    if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string" && parsed.error.message) {
      return parsed.error.message.slice(0, 300);
    }
    if (typeof parsed.message === "string" && parsed.message) return parsed.message.slice(0, 300);
  } catch {
    // not JSON
  }
  return undefined;
}

/**
 * Detect a free-tier budget/spend-limit error from the response body alone.
 * Returns the normalized reason code and a human-readable message, or null.
 */
export function detectBudgetExceeded(body: string): { code: string; message: string } | null {
  if (!body) return null;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    if (typeof parsed.error?.code === "string" && parsed.error.code) code = parsed.error.code;
  } catch {
    // not JSON — fall through to text matching
  }
  const matched = BUDGET_EXCEEDED_PATTERNS.some((re) => re.test(body));
  if (!matched) return null;
  return {
    code: code && /budget|spend|limit|tier/i.test(code) ? code : FREE_TIER_BUDGET_EXCEEDED,
    message: extractErrorMessage(body) ?? body.slice(0, 300),
  };
}

function parseNodeSignal(status: number, body: string): NodeSignal {
  if (status !== 502 && status !== 401) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const error = (parsed as {
    error?: {
      type?: unknown;
      provider?: unknown;
      reason?: unknown;
      upstreamStatus?: unknown;
      disabledCandidate?: unknown;
      retryable?: unknown;
      message?: unknown;
    };
  }).error;

  if (!error) return null;

  if (
    error.type !== "upstream_node_unavailable" ||
    error.disabledCandidate !== true ||
    error.retryable !== false
  ) {
    return null;
  }

  // 429 from upstream means rate-limiting — temporary, not a permanent failure.
  // Signal cooldown instead of disable.
  if (error.upstreamStatus === 429) {
    return { action: "cooldown", upstreamStatus: 429 };
  }

  return {
    action: "disable",
    provider: typeof error.provider === "string" ? error.provider : "unknown",
    reason: typeof error.reason === "string" ? error.reason : "unknown",
    upstreamStatus: typeof error.upstreamStatus === "number" ? error.upstreamStatus : undefined,
    message: typeof error.message === "string" ? error.message : "",
  };
}

export function maybeDisableSelectedNode(args: {
  endpoint: ProviderEndpoint;
  responseStatus: number;
  responseBody: string;
}): void {
  const { endpoint, responseStatus, responseBody } = args;

  if (endpoint.source !== "upstream") return;
  if (!endpoint.nodeUrl) return;

  // Replit hosting placeholder page ("This app isn't live yet"): the deployment
  // is stopped, undeployed, or was never deployed, so Replit's edge serves an
  // HTML page containing a hosting link in place of the node. This is NOT a
  // billing failure — an account over its budget stays deployed and answers with
  // a 403 carrying FREE_TIER_BUDGET_EXCEEDED, handled further down.
  // Replit serves the placeholder as a 404, and every caller invokes this only
  // for a non-ok response — but the status is not part of the match, since the
  // page is what identifies it, not the code it happens to arrive with.
  if (responseBody.includes("replit.com/site/hosting")) {
    logger.warn(
      {
        nodeUrl: endpoint.nodeUrl,
        upstreamStatus: responseStatus,
        message: "Replit hosting placeholder page detected",
      },
      "upstream node is not deployed — removing node from pool",
    );
    disableUpstreamNode({
      url: endpoint.nodeUrl,
      disabledReason: "upstream-node-unavailable",
      upstreamReason: REPLIT_HOSTING_SHUTDOWN,
      upstreamStatus: responseStatus,
      lastError: "Replit deployment is not live (hosting placeholder page returned)",
    });
    return;
  }

  // Free-tier budget exhausted. Replit's AI gateway has reported this in more
  // than one shape (403 + code FREE_TIER_BUDGET_EXCEEDED, and a plain
  // "Free tier monthly spend limit exceeded. Please upgrade to a paid plan..."
  // message that may arrive as 402/429/403). The status is not reliable, so
  // match on the body. This must run before the 429 cooldown branch: a budget
  // error is not a transient rate limit and a 60s cooldown would just let the
  // node rotate back in and fail again.
  const budget = detectBudgetExceeded(responseBody);
  if (budget) {
    logger.warn(
      {
        nodeUrl: endpoint.nodeUrl,
        upstreamStatus: responseStatus,
        upstreamReason: budget.code,
        message: budget.message,
      },
      "upstream node free-tier budget exceeded — removing node from pool",
    );
    disableUpstreamNode({
      url: endpoint.nodeUrl,
      disabledReason: "upstream-node-unavailable",
      upstreamReason: budget.code,
      upstreamStatus: responseStatus,
      lastError: budget.message,
    });
    return;
  }

  // 402 Payment Required is never transient — the account needs billing action.
  if (responseStatus === 402) {
    const lastError = extractErrorMessage(responseBody) ?? responseBody.slice(0, 300);
    logger.warn(
      { nodeUrl: endpoint.nodeUrl, upstreamStatus: 402, message: lastError },
      "upstream node returned 402 Payment Required — removing node from pool",
    );
    disableUpstreamNode({
      url: endpoint.nodeUrl,
      disabledReason: "upstream-node-unavailable",
      upstreamReason: "payment_required",
      upstreamStatus: 402,
      lastError,
    });
    return;
  }

  // A raw 429 from the upstream node means it is rate-limited — temporary.
  // Apply a cooldown so round-robin skips it for a while, but do not remove it.
  if (responseStatus === 429) {
    logger.warn(
      { nodeUrl: endpoint.nodeUrl },
      "upstream node returned 429 Too Many Requests — applying cooldown",
    );
    setNodeCooldown(endpoint.nodeUrl);
    return;
  }

  // A raw 403 from the upstream reverse proxy means access is forbidden.
  // Try to extract a specific error code from the JSON body (e.g.
  // FREE_TIER_BUDGET_EXCEEDED); fall back to generic "forbidden".
  if (responseStatus === 403) {
    let upstreamReason = "forbidden";
    let lastError = responseBody.slice(0, 300);
    try {
      const parsed = JSON.parse(responseBody) as {
        error?: { code?: unknown; message?: unknown };
      };
      if (typeof parsed.error?.code === "string" && parsed.error.code) {
        upstreamReason = parsed.error.code;
      }
    } catch {
      // body is not JSON — keep defaults
    }
    lastError = extractErrorMessage(responseBody) ?? lastError;
    logger.warn(
      {
        nodeUrl: endpoint.nodeUrl,
        upstreamStatus: 403,
        upstreamReason,
        message: lastError,
      },
      "upstream node returned 403 Forbidden — removing node from pool",
    );
    disableUpstreamNode({
      url: endpoint.nodeUrl,
      disabledReason: "upstream-node-unavailable",
      upstreamReason,
      upstreamStatus: 403,
      lastError,
    });
    return;
  }

  const signal = parseNodeSignal(responseStatus, responseBody);
  if (!signal) return;

  // Wrapped 429: the gateway returned 502 but the root cause is upstream rate-limiting.
  // Apply cooldown rather than permanently removing the node.
  if (signal.action === "cooldown") {
    logger.warn(
      { nodeUrl: endpoint.nodeUrl, upstreamStatus: signal.upstreamStatus },
      "upstream node rate-limited (wrapped 429) — applying cooldown",
    );
    setNodeCooldown(endpoint.nodeUrl);
    return;
  }

  logger.warn(
    {
      nodeUrl: endpoint.nodeUrl,
      provider: signal.provider,
      reason: signal.reason,
      upstreamStatus: signal.upstreamStatus,
      message: signal.message,
    },
    "upstream node disable signal received — removing node from pool",
  );

  disableUpstreamNode({
    url: endpoint.nodeUrl,
    disabledReason: "upstream-node-unavailable",
    provider: signal.provider,
    upstreamReason: signal.reason,
    upstreamStatus: signal.upstreamStatus,
    lastError: signal.message,
  });
}
