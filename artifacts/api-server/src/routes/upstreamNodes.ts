import { Router } from "express";
import {
  getSettings,
  updateSettings,
  disableUpstreamNode,
  restoreDisabledNodes,
  REPLIT_HOSTING_SHUTDOWN,
  NODE_PROBE_OFFLINE,
  type DisabledUpstreamNode,
  type UpstreamNodeType,
} from "../lib/settings.js";
import { getActiveCooldowns } from "../lib/providerEndpoint.js";
import { probeNodes, probeNodeLlm } from "../lib/nodeProbe.js";
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

// Send a real (1-token) LLM call through every disabled node and restore the
// ones that answer. Dev nodes are skipped — they are always kept disabled.
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

  res.json({ results, restored });
});

export default router;
