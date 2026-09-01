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
      if (typeof parsed.error?.message === "string" && parsed.error.message) {
        lastError = parsed.error.message.slice(0, 300);
      }
    } catch {
      // body is not JSON — keep defaults
    }
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
