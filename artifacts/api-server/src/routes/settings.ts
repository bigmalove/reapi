import { Router } from "express";
import { getSettings, updateSettings, type ServerSettings } from "../lib/settings.js";

const router = Router();

router.get("/api/settings", (_req, res) => {
  res.json(getSettings());
});

router.post("/api/settings", (req, res) => {
  const body = (req.body ?? {}) as Partial<ServerSettings>;
  const patch: Partial<ServerSettings> = {};
  if (typeof body.sillyTavernMode === "boolean") patch.sillyTavernMode = body.sillyTavernMode;
  if (typeof body.reverseProxyEnabled === "boolean") patch.reverseProxyEnabled = body.reverseProxyEnabled;
  if (typeof body.reverseProxyUrl === "string") patch.reverseProxyUrl = body.reverseProxyUrl;
  if (typeof body.reverseProxyApiKey === "string") patch.reverseProxyApiKey = body.reverseProxyApiKey;
  const updated = updateSettings(patch);
  res.json(updated);
});

export default router;
