import { Router } from "express";
import {
  getSettings,
  updateSettings,
  disableUpstreamNode,
  restoreDisabledNodes,
  REPLIT_HOSTING_SHUTDOWN,
  NODE_PROBE_OFFLINE,
  NODE_SERVER_ERROR,
  FREE_TIER_RECOVERY_MS,
  type DisabledUpstreamNode,
  type UpstreamNodeType,
} from "../lib/settings.js";
import { getActiveCooldowns, setNodeCooldown, rotateNodeToEnd } from "../lib/providerEndpoint.js";
import { probeNodes, probeNodeLlm } from "../lib/nodeProbe.js";
import { detectBudgetExceeded, extractErrorCode, extractErrorMessage } from "../lib/upstreamNodeFailure.js";
import { requireAuth } from "../lib/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

function classifyHost(url: string): UpstreamNodeType | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith(".replit.app")) return "replit-app";
  if (hostname.endsWith(".replit.dev")) return "replit-dev";
  return null;
}

router.get("/api/upstream-nodes/cooldowns", (_req, res) => {
  const cooldowns = getActiveCooldowns();
  res.json({ cooldowns });
});

router.post("/api/upstream-nodes/register", (req, res) => {
  const body = (req.body ?? {}) as { url?: unknown };

  if (typeof body.url !== "string" || !body.url.trim()) {
    res.status(400).json({ error: { message: "url is required", type: "validation_error" } });
    return;
  }

  const rawUrl = body.url.trim().replace(/\/+$/, "");

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    res.status(400).json({ error: { message: "url must be a valid absolute URL", type: "validation_error" } });
    return;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    res.status(400).json({ error: { message: "url must use http: or https:", type: "validation_error" } });
    return;
  }

  const type = classifyHost(rawUrl);
  if (type === null) {
    res.status(400).json({ error: { message: "unsupported_node_host", type: "validation_error" } });
    return;
  }

  const settings = getSettings();

  if (type === "replit-app") {
    // If this node was previously disabled due to upstream failure, do not
    // re-add it to the pool — the reapi-node auto-registration would otherwise
    // undo the disable on every heartbeat cycle. Those nodes are still deployed
    // and running (e.g. a 403 FREE_TIER_BUDGET_EXCEEDED), so they keep sending
    // heartbeats while broken and a registration proves nothing.
    //
    // Exceptions that fall through and restore the node:
    //  - REPLIT_HOSTING_SHUTDOWN / NODE_PROBE_OFFLINE: the node had no process
    //    running (or did not answer at all), so it could not have sent this
    //    request. Receiving one means the deployment is live again.
    //  - `recoverAt` has passed: a time-boxed disable (free-tier monthly spend
    //    limit) whose window is over.
    const existingDisabled = settings.disabledUpstreamNodes.find((e) => e.url === rawUrl);
    const wasShutDown =
      existingDisabled?.upstreamReason === REPLIT_HOSTING_SHUTDOWN ||
      existingDisabled?.upstreamReason === NODE_PROBE_OFFLINE;
    const recovered =
      existingDisabled?.recoverAt !== undefined &&
      Date.parse(existingDisabled.recoverAt) <= Date.now();

    if (existingDisabled?.disabledReason === "upstream-node-unavailable" && !wasShutDown && !recovered) {
      res.json({
        registered: true,
        type: "replit-app",
        enabled: false,
        disabledReason: "upstream-node-unavailable",
      });
      return;
    }

    if (wasShutDown) {
      logger.info(
        { nodeUrl: rawUrl, disabledAt: existingDisabled?.disabledAt },
        "redeployed node re-registered after hosting shutdown — restoring to pool",
      );
    } else if (recovered) {
      logger.info(
        { nodeUrl: rawUrl, disabledAt: existingDisabled?.disabledAt, recoverAt: existingDisabled?.recoverAt },
        "node re-registered after its recovery time — restoring to pool",
      );
    }

    const alreadyInPool = settings.reverseProxyPool.some((e) => e.url === rawUrl);
    const pool = alreadyInPool
      ? settings.reverseProxyPool
      : [...settings.reverseProxyPool, { url: rawUrl, apiKey: "" }];

    const disabled = settings.disabledUpstreamNodes.filter((e) => e.url !== rawUrl);

    updateSettings({
      reverseProxyPool: pool,
      disabledUpstreamNodes: disabled,
      reverseProxyEnabled: true,
    });

    res.json({ registered: true, type: "replit-app", enabled: true });
    return;
  }

  if (type === "replit-dev") {
    const pool = settings.reverseProxyPool.filter((e) => e.url !== rawUrl);

    const disabledEntry: DisabledUpstreamNode = {
      url: rawUrl,
      type: "replit-dev",
      disabledReason: "requires-wakeup",
    };
    const disabled = settings.disabledUpstreamNodes.filter((e) => e.url !== rawUrl);
    disabled.push(disabledEntry);

    updateSettings({
      reverseProxyPool: pool,
      disabledUpstreamNodes: disabled,
    });

    res.json({ registered: true, type: "replit-dev", enabled: false, disabledReason: "requires-wakeup" });
    return;
  }
});

router.post("/api/upstream-nodes/copy-from", async (req, res) => {
  const body = (req.body ?? {}) as { url?: unknown; apiKey?: unknown };

  if (typeof body.url !== "string" || !body.url.trim()) {
    res.status(400).json({ error: { message: "url is required", type: "validation_error" } });
    return;
  }

  const rawUrl = body.url.trim().replace(/\/+$/, "");

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    res.status(400).json({ error: { message: "url must be a valid absolute URL", type: "validation_error" } });
    return;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    res.status(400).json({ error: { message: "url must use http: or https:", type: "validation_error" } });
    return;
  }

  const remoteApiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

  let remoteSettings: Record<string, unknown>;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (remoteApiKey) headers["Authorization"] = `Bearer ${remoteApiKey}`;
    const response = await fetch(`${rawUrl}/api/settings`, { headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      res.status(502).json({ error: { message: `远端节点返回 ${response.status}${text ? ": " + text.slice(0, 200) : ""}`, type: "upstream_error" } });
      return;
    }
    remoteSettings = (await response.json()) as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: { message: `无法连接远端节点: ${msg}`, type: "upstream_error" } });
    return;
  }

  const remotePool: Array<{ url: string }> = [];
  if (Array.isArray(remoteSettings["reverseProxyPool"])) {
    for (const entry of remoteSettings["reverseProxyPool"] as unknown[]) {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        const u = typeof e["url"] === "string" ? e["url"].trim().replace(/\/+$/, "") : "";
        if (u) remotePool.push({ url: u });
      }
    }
  }

  const remoteDisabled: DisabledUpstreamNode[] = [];
  if (Array.isArray(remoteSettings["disabledUpstreamNodes"])) {
    for (const entry of remoteSettings["disabledUpstreamNodes"] as unknown[]) {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        const u = typeof e["url"] === "string" ? e["url"].trim().replace(/\/+$/, "") : "";
        if (!u) continue;
        const rawType = e["type"];
        const nodeType: UpstreamNodeType =
          rawType === "replit-dev" ? "replit-dev" : "replit-app";
        const rawReason = e["disabledReason"];
        const disabledReason =
          rawReason === "upstream-node-unavailable"
            ? "upstream-node-unavailable" as const
            : "requires-wakeup" as const;
        const node: DisabledUpstreamNode = { url: u, type: nodeType, disabledReason };
        if (typeof e["disabledAt"] === "string") node.disabledAt = e["disabledAt"];
        if (typeof e["lastError"] === "string") node.lastError = e["lastError"];
        if (typeof e["upstreamReason"] === "string") node.upstreamReason = e["upstreamReason"];
        if (typeof e["upstreamStatus"] === "number") node.upstreamStatus = e["upstreamStatus"];
        if (typeof e["recoverAt"] === "string") node.recoverAt = e["recoverAt"];
        remoteDisabled.push(node);
      }
    }
  }

  // Merge remote disabled nodes into local disabledUpstreamNodes.
  // Only skip if already present in the local disabled list; nodes that are
  // currently in the local active pool are still added to the disabled list
  // so the user can see and manage them.
  const localSettings = getSettings();
  const localDisabledUrls = new Set(localSettings.disabledUpstreamNodes.map((e) => e.url));
  const toAddDisabled: DisabledUpstreamNode[] = [];
  for (const node of remoteDisabled) {
    if (!localDisabledUrls.has(node.url)) {
      toAddDisabled.push(node);
    }
  }
  if (toAddDisabled.length > 0) {
    updateSettings({
      disabledUpstreamNodes: [...localSettings.disabledUpstreamNodes, ...toAddDisabled],
    });
  }

  res.json({
    poolEntries: remotePool,
    disabledNodesImported: toAddDisabled.length,
  });
});

router.post("/api/upstream-nodes/re-enable", (req, res) => {
  const body = (req.body ?? {}) as { url?: unknown };

  if (typeof body.url !== "string" || !body.url.trim()) {
    res.status(400).json({ error: { message: "url is required", type: "validation_error" } });
    return;
  }

  const rawUrl = body.url.trim().replace(/\/+$/, "");
  const settings = getSettings();

  const disabledEntry = settings.disabledUpstreamNodes.find((e) => e.url === rawUrl);
  if (!disabledEntry) {
    res.status(404).json({ error: { message: "Node not found in disabled list", type: "not_found" } });
    return;
  }

  if (disabledEntry.type === "replit-dev") {
    res.status(400).json({ error: { message: "Dev nodes cannot be re-enabled manually — they require a wakeup", type: "validation_error" } });
    return;
  }

  restoreDisabledNodes([rawUrl]);

  res.json({ re_enabled: true, url: rawUrl });
});

// Probe every node in the active pool and disable the ones that are offline.
// Only "no process answering" counts as offline (see nodeProbe.ts); any other
// HTTP response leaves the node in the pool.
router.post("/api/upstream-nodes/check", requireAuth, async (_req, res) => {
  const urls = getSettings().reverseProxyPool.map((e) => e.url);
  const results = await probeNodes(urls);

  const disabled: string[] = [];
  for (const r of results) {
    if (r.online) continue;
    // The pool may have changed while probing (e.g. the node got disabled by
    // a failing request in the meantime) — only touch nodes still in it.
    if (!getSettings().reverseProxyPool.some((e) => e.url === r.url)) continue;
    logger.warn(
      { nodeUrl: r.url, upstreamStatus: r.status, reason: r.reason, message: r.error },
      "upstream node offline in status check — removing node from pool",
    );
    disableUpstreamNode({
      url: r.url,
      disabledReason: "upstream-node-unavailable",
      upstreamReason: r.reason,
      upstreamStatus: r.status,
      lastError: r.error,
    });
    disabled.push(r.url);
  }

  res.json({ results, disabled });
});

// Send a real (1-token) LLM call through every node in the active pool and
// disable the ones that answer HTTP 500.
//
// This is the companion to /check: that one probes whether a process is
// answering at all (a plain GET /healthz, no model quota), which cannot see a
// node whose Replit AI Integration stopped minting credentials. Such a node
// serves its homepage, /api/healthz and /api/setup-status normally — every
// provider still reports `configured: true` — yet every /modelfarm call comes
// back as HTTP 500 with an empty body, and only republishing the deployment
// fixes it. Since the pool is consumed through sticky pool[0], a node like that
// at the head breaks every request, and left in the pool it keeps coming back.
//
// Only an EMPTY 500 disables a node here. A 500 that carries a provider error
// body proves the credential was issued — the request reached upstream — so it
// is a transient upstream problem (e.g. Replit's own rate-limit lookup
// failing) and merely gets cooled down.
//
// Exhausted free-tier quota is disabled too, with the same 31-day recovery
// window the request path uses (see upstreamNodeFailure.ts): the limit resets
// monthly, and leaving such a node in the pool only makes it answer 403 to
// every request that lands on it.
//
// Any OTHER 403 that carries a body is disabled too, with no recovery window,
// because that is what the request path does for every 403
// (upstreamNodeFailure.ts): the node refuses the call whether the key was
// revoked, the deployment was suspended or the account lost access. Quota is
// the only 403 that heals on its own.
//
// A 403 with an EMPTY body is not evidence of anything and must not disable a
// node. Every refusal we can classify — quota, revoked key, suspended app —
// comes with a JSON body; an empty one is what the edge returns while an
// instance restarts or while it is being republished. Observed for real: a node
// was disabled permanently as `forbidden` on an empty 403, and by the time it
// was looked at again it answered 403 with a full FREE_TIER_BUDGET_EXCEEDED
// body — the right verdict was "quota, 31 days", not "forbidden, forever". It
// is also a dead end: `check-disabled` only restores nodes that answer 200, so
// nothing was ever going to undo the mistake. Ambiguous 403s are now retried
// once and then merely cooled down, which costs one round trip and leaves the
// node in the pool for the next request to judge.
router.post("/api/upstream-nodes/check-ai", requireAuth, async (_req, res) => {
  const settings = getSettings();
  const pool = settings.reverseProxyPool;
  const urls = pool.map((e) => e.url);
  // Per-entry key, falling back to pool[0]'s key — the same rule the request
  // path applies (providerEndpoint.ts). Probing everyone with pool[0]'s key
  // would make a node with its own key answer 401/403 and look broken.
  const defaultKey = pool[0]?.apiKey ?? "";
  const keyByUrl = new Map(pool.map((e) => [e.url, e.apiKey || defaultKey]));

  const results = await probeNodes(urls, (url) => probeNodeLlm(url, keyByUrl.get(url) ?? defaultKey));

  const disabled: string[] = [];
  const cooled: string[] = [];
  const annotated = [];

  for (const r of results) {
    let body = (r.bodyText ?? "").trim();
    let status = r.status;
    let online = r.online;
    // Confirm an empty 403 before believing it: see the note above.
    if (!online && status === 403 && !body) {
      const retry = await probeNodeLlm(r.url, keyByUrl.get(r.url) ?? defaultKey);
      if (retry.online) {
        online = true;
        status = retry.status;
      } else {
        body = (retry.bodyText ?? "").trim();
        status = retry.status ?? status;
      }
    }
    // Reuse the request path's detector so a budget error is recognised the
    // same way regardless of which status code carried it.
    const budget = detectBudgetExceeded(body);

    // Classify so the portal can explain every node instead of hiding the
    // remainder behind an "other" count.
    let kind: string;
    if (online) kind = "ok";
    else if (budget) kind = "quota";
    else if (status === 403 && body) kind = "forbidden";
    else if (status === 403) kind = "forbidden-unverified";
    else if (status === 500 && body) kind = "server-error-with-body";
    else if (status === 500) kind = "credential";
    else if (status === undefined) kind = "unreachable";
    else kind = "error";

    annotated.push({ ...r, status, online, bodyText: undefined, contentType: undefined, kind });

    // The pool may have changed while probing — only touch nodes still in it.
    if (!getSettings().reverseProxyPool.some((e) => e.url === r.url)) continue;

    if (kind === "credential") {
      logger.warn(
        { nodeUrl: r.url, upstreamStatus: r.status },
        "upstream node cannot obtain an AI credential in AI check — removing node from pool",
      );
      // No recoverAt: nodes re-register every 5 hours, so a time-boxed window
      // would let a still-broken node back in. See NODE_SERVER_ERROR.
      disableUpstreamNode({
        url: r.url,
        disabledReason: "upstream-node-unavailable",
        upstreamReason: NODE_SERVER_ERROR,
        upstreamStatus: r.status,
        lastError:
          "HTTP 500 with an empty response body — the node cannot obtain an AI credential; republish the Repl, then use 检测并恢复",
      });
      disabled.push(r.url);
    } else if (kind === "quota") {
      const recoverAt = new Date(Date.now() + FREE_TIER_RECOVERY_MS).toISOString();
      logger.warn(
        { nodeUrl: r.url, upstreamStatus: r.status, upstreamReason: budget?.code, recoverAt },
        "upstream node free-tier budget exceeded in AI check — removing node from pool for 31 days",
      );
      disableUpstreamNode({
        url: r.url,
        disabledReason: "upstream-node-unavailable",
        upstreamReason: budget?.code ?? "FREE_TIER_BUDGET_EXCEEDED",
        upstreamStatus: r.status,
        lastError: budget?.message ?? "Free tier monthly spend limit exceeded",
        recoverAfterMs: FREE_TIER_RECOVERY_MS,
      });
      disabled.push(r.url);
    } else if (kind === "forbidden") {
      // Same treatment as the request path's 403 branch: a plain 403 means the
      // node refuses the call and will keep refusing it, so it leaves the pool
      // with no recovery window. Only a quota 403 (matched above) is time-boxed.
      const upstreamReason = extractErrorCode(body) ?? "forbidden";
      const lastError = extractErrorMessage(body) ?? body.slice(0, 300);
      logger.warn(
        { nodeUrl: r.url, upstreamStatus: r.status, upstreamReason, message: lastError },
        "upstream node returned 403 in AI check — removing node from pool",
      );
      disableUpstreamNode({
        url: r.url,
        disabledReason: "upstream-node-unavailable",
        upstreamReason,
        upstreamStatus: r.status,
        lastError,
      });
      disabled.push(r.url);
    } else if (kind === "forbidden-unverified") {
      // Two probes, both 403 with no body — no verdict, so no eviction.
      logger.warn(
        { nodeUrl: r.url, upstreamStatus: status },
        "upstream node returned 403 with no body in AI check — cooling down without blocking",
      );
      setNodeCooldown(r.url);
      rotateNodeToEnd(r.url);
      cooled.push(r.url);
    } else if (kind === "server-error-with-body") {
      logger.warn(
        { nodeUrl: r.url, upstreamStatus: r.status, body: body.slice(0, 200) },
        "upstream node returned 500 with a body in AI check — cooling down",
      );
      setNodeCooldown(r.url);
      rotateNodeToEnd(r.url);
      cooled.push(r.url);
    }
  }

  const summary = {
    total: annotated.length,
    ok: annotated.filter((r) => r.kind === "ok").length,
    disabled: disabled.length,
    cooled: cooled.length,
    quota: annotated.filter((r) => r.kind === "quota").length,
    forbidden: annotated.filter((r) => r.kind === "forbidden").length,
    forbiddenUnverified: annotated.filter((r) => r.kind === "forbidden-unverified").length,
    unreachable: annotated.filter((r) => r.kind === "unreachable").length,
    error: annotated.filter((r) => r.kind === "error").length,
  };

  res.json({ results: annotated, disabled, cooled, summary });
});
// Send a real (1-token) LLM call through every disabled node and restore the
// ones that answer. Dev nodes are skipped — they are always kept disabled.
//
// It also repairs stale verdicts. Only `online` used to be acted on, so an
// entry blocked for the wrong reason stayed wrong forever: a node disabled as
// `forbidden` on an empty 403 (see check-ai) never returns 200 while its
// account is out of budget, so nothing would ever relabel it `quota` and give
// it the 31-day window it deserves. Every re-probe now refreshes the record:
// `quota` gets the monthly time box, a body-bearing 403 gets its reason
// rewritten, and only an unreadable answer leaves the entry untouched.
router.post("/api/upstream-nodes/check-disabled", requireAuth, async (_req, res) => {
  const settings = getSettings();
  const urls = settings.disabledUpstreamNodes
    .filter((e) => e.type !== "replit-dev")
    .map((e) => e.url);
  // Disabled entries carry no key of their own; once restored they inherit
  // pool[0]'s key, so test with that.
  const apiKey = settings.reverseProxyPool[0]?.apiKey ?? "";
  const results = await probeNodes(urls, (url) => probeNodeLlm(url, apiKey));

  const stillDisabled = new Set(getSettings().disabledUpstreamNodes.map((e) => e.url));
  const restored = results.filter((r) => r.online && stillDisabled.has(r.url)).map((r) => r.url);
  for (const url of restored) {
    logger.info({ nodeUrl: url }, "disabled upstream node passed LLM check — restoring to pool");
  }
  restoreDisabledNodes(restored);

  const relabeled: Array<{ url: string; from?: string; to: string }> = [];
  for (const r of results) {
    if (r.online || !stillDisabled.has(r.url)) continue;
    const body = (r.bodyText ?? "").trim();
    const budget = detectBudgetExceeded(body);
    const entry = getSettings().disabledUpstreamNodes.find((e) => e.url === r.url);
    if (!entry) continue;

    if (budget) {
      // Out of quota: keep it out of the pool but on the monthly clock, so it
      // comes back on its own instead of waiting for a manual re-enable.
      const alreadyRight =
        entry.upstreamReason === (budget.code) && entry.recoverAt !== undefined;
      if (alreadyRight) continue;
      logger.info(
        { nodeUrl: r.url, from: entry.upstreamReason ?? null, to: budget.code },
        "disabled node re-probed as budget-exhausted — relabelling with the monthly window",
      );
      disableUpstreamNode({
        url: r.url,
        disabledReason: "upstream-node-unavailable",
        upstreamReason: budget.code,
        upstreamStatus: r.status,
        lastError: budget.message,
        recoverAfterMs: FREE_TIER_RECOVERY_MS,
      });
      relabeled.push({ url: r.url, from: entry.upstreamReason, to: budget.code });
    } else if (r.status === 403 && body) {
      const reason = extractErrorCode(body) ?? "forbidden";
      const lastError = extractErrorMessage(body) ?? body.slice(0, 300);
      if (entry.upstreamReason === reason && entry.lastError === lastError) continue;
      disableUpstreamNode({
        url: r.url,
        disabledReason: "upstream-node-unavailable",
        upstreamReason: reason,
        upstreamStatus: r.status,
        lastError,
      });
      relabeled.push({ url: r.url, from: entry.upstreamReason, to: reason });
    }
  }

  res.json({ results, restored, relabeled });
});

export default router;
