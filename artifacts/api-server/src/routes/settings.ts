import { Router } from "express";
import { getSettings, updateSettings } from "../lib/settings.js";

const router = Router();

router.get("/api/settings", (_req, res) => {
  res.json(getSettings());
});

router.post("/api/settings", (req, res) => {
  const body = req.body as Partial<{ sillyTavernMode: boolean }>;
  const updated = updateSettings(body);
  res.json(updated);
});

export default router;
