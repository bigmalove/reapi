import { Router } from "express";
import { requireAuth } from "../lib/auth.js";
import {
  buildUsageReport,
  parseUsageWindow,
  refreshPrices,
  resetUsage,
} from "../lib/usageLedger.js";

const router = Router();

/**
 * Usage report: totals, per-account consumption, per-model cost (OpenRouter
 * prices from the public catalog), daily series, recent requests, and the
 * blocked-pool view (including quota 403s).
 */
router.get("/api/usage", requireAuth, (req, res) => {
  const window = parseUsageWindow(req.query["window"]);
  // Refresh prices in the background (throttled) so the next poll has current
  // numbers without making every report wait on a network round-trip.
  void refreshPrices().catch(() => {});
  res.json(buildUsageReport(window));
});

router.post("/api/usage/refresh-prices", requireAuth, async (_req, res) => {
  const snapshot = await refreshPrices(true).catch(() => null);
  res.json({
    refreshed: snapshot !== null,
    source: snapshot?.source ?? null,
    fetchedAt: snapshot?.fetchedAt ?? null,
    models: snapshot ? Object.keys(snapshot.prices).length : 0,
  });
});

router.post("/api/usage/reset", requireAuth, async (_req, res) => {
  await resetUsage();
  res.json({ reset: true });
});

export default router;
