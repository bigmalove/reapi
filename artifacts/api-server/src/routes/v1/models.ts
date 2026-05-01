import { Router } from "express";
import { requireAuth } from "../../lib/auth.js";
import { getEnabledModels, getAllModelsWithStatus, patchModelDisabled } from "../../lib/models.js";

const router = Router();

router.get("/v1/models", requireAuth, (_req, res) => {
  const models = getEnabledModels();
  res.json({
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: m.created,
      owned_by: m.provider,
    })),
  });
});

router.get("/v1/admin/models", requireAuth, (_req, res) => {
  const models = getAllModelsWithStatus();
  res.json({
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: m.created,
      owned_by: m.provider,
      provider: m.provider,
      disabled: m.disabled,
    })),
  });
});

router.patch("/v1/admin/models", requireAuth, (req, res) => {
  const body = req.body as { id?: string; disabled?: boolean; provider?: string; all_disabled?: boolean };

  if (body.provider !== undefined && body.all_disabled !== undefined) {
    const all = getAllModelsWithStatus();
    for (const m of all) {
      if (m.provider === body.provider) {
        patchModelDisabled(m.id, body.all_disabled);
      }
    }
    res.json({ ok: true });
    return;
  }

  if (!body.id || body.disabled === undefined) {
    res.status(400).json({ error: { message: "id and disabled are required" } });
    return;
  }
  patchModelDisabled(body.id, body.disabled);
  res.json({ ok: true });
});

export default router;
