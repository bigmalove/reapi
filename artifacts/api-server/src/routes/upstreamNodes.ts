import { Router } from "express";
import { getSettings, updateSettings, type DisabledUpstreamNode, type UpstreamNodeType } from "../lib/settings.js";

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

    const pool = settings.reverseProxyPool.filter((e) => e.url !== rawUrl);
    pool.push({ url: rawUrl, apiKey: "" });

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

export default router;
