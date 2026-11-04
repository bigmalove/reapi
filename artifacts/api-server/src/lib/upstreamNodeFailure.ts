import {
  disableUpstreamNode,
  getSettings,
  REPLIT_HOSTING_SHUTDOWN,
  FREE_TIER_RECOVERY_MS,
  NODE_SERVER_ERROR,
} from "./settings.js";
import { logger } from "./logger.js";
import {
  getActiveCooldowns,
  hasUsableUpstreamEndpoint,
  setNodeCooldown,
  rotateNodeToEnd,
} from "./providerEndpoint.js";
import type { ProviderEndpoint, ProviderName } from "./providerEndpoint.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { looksLikeHtmlDocument } from "./upstreamError.js";

interface NodeDisableSignal {
  provider: string;
  reason: string;
  upstreamStatus?: number;
  message: string;
  /** When set, the node comes back automatically once this window elapses. */
  recoverAfterMs?: number;
  /**
   * True when the quota verdict rests on a repeated signal rather than explicit
   * budget wording in the body. Recorded so the portal can tell a measured
   * verdict from an inferred one.
   */
  unverified?: boolean;
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
  // The same condition in other shapes: OpenAI-style quota errors relayed by a
  // node, and the localised body the Replit modelfarm returns to zh clients
  // ("当前请求的额度已用尽"). Without these the node still leaves the pool, but
  // as a generic "forbidden" with no recovery window.
  /insufficient[_ ]quota/i,
  /quota (?:has been )?(?:exceeded|exhausted|reached)/i,
  /out of (?:credits?|quota)/i,
  /credit balance/i,
  /额度(?:已|不足|用尽|耗尽)/,
  /配额(?:已|不足)?(?:用尽|耗尽)/,
  /余额不足/,
];

/**
 * Detect a Replit page served in place of a node whose process is not running:
 *  - the hosting placeholder ("This app isn't live yet") for a stopped or
 *    undeployed `.replit.app` deployment,
 *  - the "Run this app to see the results here." page for a `.replit.dev`
 *    workspace that is not running, and
 *  - the platform's generic 404 page for a Repl that no longer exists
 *    (deleted or renamed).
 * All three arrive as 404s that would otherwise look like an app without the
 * route. Returns a human-readable error, or null.
 */
export function detectReplitNotRunning(body: string): string | null {
  if (body.includes("replit.com/site/hosting")) {
    return "Replit deployment is not live (hosting placeholder page returned)";
  }
  if (body.includes("Run this app to see the results here")) {
    return "Replit dev workspace is not running (\"Run this app\" page returned)";
  }
  // Both the raw and the HTML-escaped apostrophe show up, depending on whether
  // the page came back through a JSON-encoding hop.
  if (
    body.includes("This project isn't available right now") ||
    body.includes("This project isn&#39;t available right now")
  ) {
    return "Replit project is not available right now (edge placeholder page returned)";
  }
  // A deleted or renamed Repl: Replit's edge never reaches an app at all, so it
  // answers with its own generic 404 page. Unlike the two placeholders above,
  // nothing on it marks the app as absent — it reads as a live app that merely
  // lacks the route, so the node is never cooled down or removed and in sticky
  // mode (pool[0] until a cooldown moves it) every request keeps going to it.
  // The platform page's heading is what tells it apart from the node app's own
  // Express 404, which renders `<pre>Cannot GET /path</pre>` instead.
  if (
    body.includes("Error: Page not found") &&
    !body.includes("Cannot GET") &&
    !body.includes("Cannot POST")
  ) {
    return "Replit Repl no longer exists (generic 404 page returned)";
  }

  // Last resort: any HTML document at all. The markers above are a moving
  // target — Replit ships new placeholder pages faster than this list grows,
  // and a miss leaves the dead node in rotation (observed 2026-11-04: "This
  // app isn't live yet" is only identifiable by a link near the end of an
  // ~8 KB page). Shape, not wording: every node route answers JSON, so a body
  // that starts with markup means the edge answered instead of the app.
  // The node app's own Express 404 (`Cannot GET`) is HTML too, but the app is
  // answering — that is a request problem, not a dead node.
  if (looksLikeHtmlDocument(body) && !body.includes("Cannot GET") && !body.includes("Cannot POST")) {
    return "Replit edge returned an HTML placeholder page instead of the node app";
  }
  return null;
}

/** Pull `error.message` (or a top-level `message`) out of a JSON error body. */
export function extractErrorMessage(body: string): string | undefined {
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

/** Pull `error.code` out of a JSON error body, e.g. `FREE_TIER_BUDGET_EXCEEDED`. */
export function extractErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    if (typeof parsed.error?.code === "string" && parsed.error.code) return parsed.error.code;
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
  const code = extractErrorCode(body);
  const matched = BUDGET_EXCEEDED_PATTERNS.some((re) => re.test(body));
  if (!matched) return null;
  return {
    code: code && /budget|spend|limit|tier/i.test(code) ? code : FREE_TIER_BUDGET_EXCEEDED,
    message: extractErrorMessage(body) ?? body.slice(0, 300),
  };
}

/**
 * How many *separate requests* a single node may fail with 429 inside the
 * strike window before the account is treated as spent.
 *
 * A throttled upstream channel and a spent account look identical on the wire
 * (the pool node collapses both into the same envelope), so the gateway cannot
 * tell them apart from one response. It can tell them apart from a series: a
 * rate limit clears, a spent account does not.
 *
 * The unit is deliberately the request, not the attempt. One request replays
 * across the pool up to six times (`MAX_ATTEMPTS_NODE_FAULT`), and in a
 * single-node pool all six land on the same node — that is one observation of
 * "this node is throttled", not six independent failures. Counting attempts
 * would evict a healthy account on the very first request.
 *
 * Measured reason for the threshold: a single long session lands on the sticky
 * pool head every turn, each 429 counts a strike, and at a low limit four
 * accounts were disabled within six seconds while all of them had answered 200
 * moments earlier. A burst of that shape needs more evidence before it costs an
 * account its place in the pool; a genuinely spent account still gets there
 * within minutes because every request fails.
 */
const QUOTA_STRIKE_LIMIT = 8;

/** How long a strike stays on the books. */
const QUOTA_STRIKE_WINDOW_MS = 10 * 60 * 1000;

/**
 * nodeUrl → { count, firstAt, lastRequestId }.
 *
 * `lastRequestId` makes the counter request-scoped: a replay inside the same
 * request does not add a strike, so one throttled request cannot evict a node
 * on its own.
 */
const quotaStrikes = new Map<
  string,
  { count: number; firstAt: number; lastRequestId: string }
>();

/**
 * Identifies the request a failure belongs to. Every attempt of one request
 * shares it, so the strike counter only advances once per request.
 *
 * The id lives in an AsyncLocalStorage rather than a module variable: the
 * gateway serves requests concurrently, so a shared "current request" would be
 * overwritten by the next request before the first one finishes, and the two
 * would share a strike count.
 */
const quotaStrikeScope = new AsyncLocalStorage<string>();

let requestCounter = 0;

/**
 * Run `fn` as one request for strike-counting purposes. Every upstream attempt
 * inside it shares a strike id, so a single throttled request cannot evict a
 * node no matter how many times the gateway replays it.
 */
export function runWithQuotaStrikeScope<T>(fn: () => T): T {
  requestCounter += 1;
  return quotaStrikeScope.run(`req-${requestCounter}`, fn);
}

/** The strike id of the request in flight, or "" outside a scoped request. */
export function currentQuotaStrikeRequestId(): string {
  return quotaStrikeScope.getStore() ?? "";
}

function recordQuotaStrike(nodeUrl: string | undefined, requestId: string): number {
  if (!nodeUrl) return QUOTA_STRIKE_LIMIT;
  const now = Date.now();
  const entry = quotaStrikes.get(nodeUrl);
  if (!entry || now - entry.firstAt > QUOTA_STRIKE_WINDOW_MS) {
    quotaStrikes.set(nodeUrl, { count: 1, firstAt: now, lastRequestId: requestId });
    return 1;
  }
  // Another attempt of the same request — not an independent observation.
  if (entry.lastRequestId === requestId) return entry.count;
  entry.count += 1;
  entry.lastRequestId = requestId;
  return entry.count;
}

function clearQuotaStrikes(nodeUrl: string | undefined): void {
  if (nodeUrl) quotaStrikes.delete(nodeUrl);
}

function parseNodeSignal(
  status: number,
  body: string,
  nodeUrl?: string,
  requestId?: string,
): NodeSignal {
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

  const reason = typeof error.reason === "string" ? error.reason : "unknown";
  const message = typeof error.message === "string" ? error.message : "";
  const providerName = typeof error.provider === "string" ? error.provider : "unknown";
  const upstreamStatus =
    typeof error.upstreamStatus === "number" ? error.upstreamStatus : undefined;

  // A wrapped 429 is the node's envelope for ANY upstream rate limit.
  //
  // The pool node maps every upstream 429 whose body mentions
  // quota/credit/rate limit to `reason: "quota-exhausted"` with
  // `disabledCandidate: true`, and it DISCARDS the original upstream body,
  // replacing it with one generic sentence. Inside a wrapped signal the only
  // trustworthy fields are `reason` and `upstreamStatus`; the wording can never
  // distinguish "account is spent" from "the provider throttled us".
  //
  // Evicting on that signal drains the whole pool in seconds: one throttled
  // channel makes every node answer 429 at the same moment, so a burst of
  // concurrent requests would park accounts that were healthy moments earlier.
  // A rate limit is transient by definition, so it earns a cooldown and a
  // rotation — the node stays in the pool and is retried after the window.
  //
  // A genuinely spent account still gets evicted, but only once it repeats:
  // strikes accumulate per node (one per request, not per attempt), and
  // `QUOTA_STRIKE_LIMIT` inside the strike window turns the signal into a
  // disable with the monthly recovery window.
  if (upstreamStatus === 429) {
    const strikes = recordQuotaStrike(nodeUrl, requestId ?? currentQuotaStrikeRequestId());
    if (strikes < QUOTA_STRIKE_LIMIT) {
      return { action: "cooldown", upstreamStatus: 429 };
    }
    clearQuotaStrikes(nodeUrl);
    logger.warn(
      { nodeUrl, strikes },
      "upstream node answered 429 repeatedly — treating the account as spent",
    );
    return {
      action: "disable",
      provider: providerName,
      reason,
      upstreamStatus: 429,
      message,
      recoverAfterMs: FREE_TIER_RECOVERY_MS,
      unverified: true,
    };
  }

  // Every other wrapped signal is a condition of the account itself: an invalid
  // key, a revoked account, an exhausted balance. The node recognised those by
  // their upstream status, so the verdict is the node's rather than an
  // inference from wording.
  return {
    action: "disable",
    provider: providerName,
    reason,
    upstreamStatus,
    message,
    ...(reason || message ? { recoverAfterMs: FREE_TIER_RECOVERY_MS } : {}),
  };
}

export type NodeFailureAction = "disabled" | "cooldown" | "none";

export interface NodeFailureOutcome {
  /** What the gateway did to the node that produced this response. */
  action: NodeFailureAction;
  /**
   * Whether replaying the same request can land on a different account: true
   * only when the node was actually taken out of rotation AND at least one
   * other upstream endpoint is still available to serve the retry.
   */
  retryElsewhere: boolean;
}

/**
 * Report a failed upstream response and take the failing node out of rotation.
 *
 * The old void signature made callers guess whether the failure was
 * node-attributable, and every route guessed "no" for a 403 — so a pool whose
 * account had run out of quota disabled that account and then handed the 403
 * straight back to the client instead of replaying the request on the next
 * account. Returning the outcome lets each route decide to retry with evidence
 * instead of hard-coded status codes.
 */
export function maybeDisableSelectedNode(args: {
  endpoint: ProviderEndpoint;
  provider: ProviderName;
  responseStatus: number;
  responseBody: string;
}): NodeFailureOutcome {
  const { endpoint, provider } = args;
  const url = endpoint.nodeUrl;
  const poolBefore = new Set(getSettings().reverseProxyPool.map((e) => e.url));
  const cooledForBefore = url ? (getActiveCooldowns()[url] ?? 0) : 0;

  applyNodeFailure(args);

  let action: NodeFailureAction = "none";
  if (url && endpoint.source === "upstream") {
    const stillInPool = getSettings().reverseProxyPool.some((e) => e.url === url);
    const cooledForAfter = getActiveCooldowns()[url] ?? 0;
    if (poolBefore.has(url) && !stillInPool) action = "disabled";
    else if (cooledForAfter > cooledForBefore) action = "cooldown";
  }

  const retryElsewhere = action !== "none" && hasUsableUpstreamEndpoint(provider);
  if (retryElsewhere) {
    logger.warn(
      { nodeUrl: url, provider, action },
      "upstream node left rotation — replaying the request on the next node",
    );
  }
  return { action, retryElsewhere };
}

function applyNodeFailure(args: {
  endpoint: ProviderEndpoint;
  responseStatus: number;
  responseBody: string;
}): void {
  const { endpoint, responseStatus, responseBody } = args;

  if (endpoint.source !== "upstream") return;
  if (!endpoint.nodeUrl) return;

  // Replit placeholder page (see detectReplitNotRunning): the deployment is
  // stopped/undeployed or the dev workspace is not running, so Replit's edge
  // serves an HTML page in place of the node. This is NOT a billing failure — an account over its budget stays deployed and answers with
  // a 403 carrying FREE_TIER_BUDGET_EXCEEDED, handled further down.
  // Replit serves the placeholder as a 404, and every caller invokes this only
  // for a non-ok response — but the status is not part of the match, since the
  // page is what identifies it, not the code it happens to arrive with.
  const notRunning = detectReplitNotRunning(responseBody);
  if (notRunning) {
    logger.warn(
      {
        nodeUrl: endpoint.nodeUrl,
        upstreamStatus: responseStatus,
        message: notRunning,
      },
      "upstream node is not running — removing node from pool",
    );
    disableUpstreamNode({
      url: endpoint.nodeUrl,
      disabledReason: "upstream-node-unavailable",
      upstreamReason: REPLIT_HOSTING_SHUTDOWN,
      upstreamStatus: responseStatus,
      lastError: notRunning,
    });
    return;
  }

  // Free-tier budget exhausted. Replit's AI gateway has reported this in more
  // than one shape (403 + code FREE_TIER_BUDGET_EXCEEDED, and a plain
  // "Free tier monthly spend limit exceeded. Please upgrade to a paid plan..."
  // message that may arrive as 402/429/403). The status is not reliable, so
  // match on the body. This must run before the 429 cooldown branch: a budget
  // error is not a transient rate limit and a 60s cooldown would just let the
  // node rotate back in and fail again. The limit is monthly, though, so the
  // node is scheduled to return to the pool after FREE_TIER_RECOVERY_MS.
  const budget = detectBudgetExceeded(responseBody);
  if (budget) {
    const recoverAt = new Date(Date.now() + FREE_TIER_RECOVERY_MS).toISOString();
    logger.warn(
      {
        nodeUrl: endpoint.nodeUrl,
        upstreamStatus: responseStatus,
        upstreamReason: budget.code,
        message: budget.message,
        recoverAt,
      },
      "upstream node free-tier budget exceeded — removing node from pool for 31 days",
    );
    disableUpstreamNode({
      url: endpoint.nodeUrl,
      disabledReason: "upstream-node-unavailable",
      upstreamReason: budget.code,
      upstreamStatus: responseStatus,
      lastError: budget.message,
      recoverAfterMs: FREE_TIER_RECOVERY_MS,
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
      rawUpstreamBody: responseBody,
    });
    return;
  }

  // A raw 429 from the upstream node means it is rate-limited — temporary.
  // Apply a cooldown and move the node to the end of the pool so the next
  // node takes over (in sticky mode the pool order is what selects the node),
  // but do not remove it.
  if (responseStatus === 429) {
    logger.warn(
      { nodeUrl: endpoint.nodeUrl },
      "upstream node returned 429 Too Many Requests — applying cooldown and moving to end of pool",
    );
    setNodeCooldown(endpoint.nodeUrl);
    rotateNodeToEnd(endpoint.nodeUrl);
    return;
  }

  // A raw 403 from the upstream reverse proxy means access is forbidden.
  // Try to extract a specific error code from the JSON body (e.g.
  // FREE_TIER_BUDGET_EXCEEDED); fall back to generic "forbidden".
  if (responseStatus === 403) {
    const upstreamReason = extractErrorCode(responseBody) ?? "forbidden";
    const lastError = extractErrorMessage(responseBody) ?? responseBody.slice(0, 300);
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
      rawUpstreamBody: responseBody,
    });
    return;
  }

  const signal = parseNodeSignal(responseStatus, responseBody, endpoint.nodeUrl);
  if (!signal) {
    // HTTP 500 with nothing but an empty body is the signature of a node whose
    // Replit AI Integration cannot mint a credential (`metasidecar: failed to
    // get modelfarm app credential`). The node process stays up and
    // /api/setup-status keeps reporting every provider `configured: true`, so
    // nothing else flags it — and the condition is permanent until the
    // deployment is republished.
    //
    // A 500 therefore goes straight to the disabled list on the first hit, with
    // NO recovery time: the fault only clears when the deployment is
    // republished, and nodes re-register every 5 hours, so any time-boxed
    // window would quietly return a still-broken node to the pool. Recovery is
    // an authenticated action — the portal's "重新启用", or "检测并恢复" which
    // probes every disabled node before restoring it.
    //
    // Only 500 is treated this way. Other 5xx codes are left on the existing
    // cooldown path: 502/503/504 usually mean the node or the edge is briefly
    // unwell, which the cooldown already covers without disabling the node.
    if (responseStatus === 500) {
      const lastError = responseBody.trim()
        ? `HTTP 500: ${responseBody.slice(0, 200)}`
        : "HTTP 500 with an empty response body (AI credential unavailable)";
      logger.warn(
        {
          nodeUrl: endpoint.nodeUrl,
          upstreamStatus: responseStatus,
          bodyLength: responseBody.length,
        },
        "upstream node returned 500 — removing node from pool",
      );
      disableUpstreamNode({
        url: endpoint.nodeUrl,
        disabledReason: "upstream-node-unavailable",
        upstreamReason: NODE_SERVER_ERROR,
        upstreamStatus: responseStatus,
        lastError,
        rawUpstreamBody: responseBody,
      });
      return;
    }

    // Other 5xx with no recognisable signal: cool the node down and move it to
    // the tail, which hands the caller's retry a different node without
    // permanently dropping it from the pool.
    if (responseStatus >= 500) {
      logger.warn(
        { nodeUrl: endpoint.nodeUrl, upstreamStatus: responseStatus, bodyLength: responseBody.length },
        "upstream node returned 5xx with no node signal — applying cooldown and moving to end of pool",
      );
      setNodeCooldown(endpoint.nodeUrl);
      rotateNodeToEnd(endpoint.nodeUrl);
    }
    return;
  }

  // Wrapped 429: the gateway returned 502 but the root cause is upstream rate-limiting.
  // Apply cooldown rather than permanently removing the node.
  if (signal.action === "cooldown") {
    logger.warn(
      { nodeUrl: endpoint.nodeUrl, upstreamStatus: signal.upstreamStatus },
      "upstream node rate-limited (wrapped 429) — applying cooldown and moving to end of pool",
    );
    setNodeCooldown(endpoint.nodeUrl);
    rotateNodeToEnd(endpoint.nodeUrl);
    return;
  }

  logger.warn(
    {
      nodeUrl: endpoint.nodeUrl,
      provider: signal.provider,
      reason: signal.reason,
      upstreamStatus: signal.upstreamStatus,
      message: signal.message,
      recoverAfterMs: signal.recoverAfterMs,
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
    rawUpstreamBody: responseBody,
    ...(signal.unverified ? { quotaSignalUnverified: true } : {}),
    ...(signal.recoverAfterMs !== undefined ? { recoverAfterMs: signal.recoverAfterMs } : {}),
  });
}

/**
 * A streaming response that ends without emitting a single chunk (not even a
 * role delta) is the signature of an upstream relay giving up before the
 * model produced its first byte: the request comes back as HTTP 200 with an
 * empty placeholder body (observed as `text/plain` containing just a newline,
 * or a whitespace-only body) after roughly 10 seconds of silence. The node
 * relays it verbatim and the gateway forwards it as an empty stream, which
 * reaches the client as a silent blank reply.
 *
 * Treat it like a transient node failure: apply the usual cooldown so the
 * caller's retry loop picks a different pool entry instead of hammering the
 * same node (which may be pointed at a slow upstream right now).
 */
export function handleEmptyUpstreamStream(endpoint: ProviderEndpoint): void {
  if (endpoint.source !== "upstream" || !endpoint.nodeUrl) return;
  logger.warn(
    { nodeUrl: endpoint.nodeUrl },
    "upstream stream produced no chunks — applying cooldown so the retry uses another node",
  );
  setNodeCooldown(endpoint.nodeUrl);
}
