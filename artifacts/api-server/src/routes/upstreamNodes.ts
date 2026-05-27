import { Router } from "express";
import { getSettings, updateSettings, type DisabledUpstreamNode, type UpstreamNodeType } from "../lib/settings.js";
import { getActiveCooldowns } from "../lib/providerEndpoint.js";

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
    // undo the disable on every heartbeat cycle.
    const existingDisabled = settings.disabledUpstreamNodes.find((e) => e.url === rawUrl);
    if (existingDisabled?.disabledReason === "upstream-node-unavailable") {
      res.json({
        registered: true,
        type: "replit-app",
        enabled: false,
        disabledReason: "upstream-node-unavailable",
      });
      return;
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

  const type = classifyHost(rawUrl);
  if (type === "replit-dev") {
    res.status(400).json({ error: { message: "Dev nodes cannot be re-enabled manually — they require a wakeup", type: "validation_error" } });
    return;
  }

  const newDisabled = settings.disabledUpstreamNodes.filter((e) => e.url !== rawUrl);
  const alreadyInPool = settings.reverseProxyPool.some((e) => e.url === rawUrl);
  const newPool = alreadyInPool
    ? settings.reverseProxyPool
    : [...settings.reverseProxyPool, { url: rawUrl, apiKey: "" }];

  updateSettings({
    disabledUpstreamNodes: newDisabled,
    reverseProxyPool: newPool,
    reverseProxyEnabled: true,
  });

  res.json({ re_enabled: true, url: rawUrl });
});

export default router;
