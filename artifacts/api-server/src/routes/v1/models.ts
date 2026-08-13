import { Router } from "express";
import { requireAuth } from "../../lib/auth.js";
import {
  addCustomModels,
  getAllModelsWithStatus,
  getEnabledModels,
  getModelRegistry,
  patchModelDisabled,
  removeCustomModel,
} from "../../lib/models.js";
import { getOpenRouterCatalog } from "../../lib/openrouterCatalog.js";

const router = Router();

/** Max ids accepted in a single POST /v1/admin/models call. */
const MAX_ADD_BATCH = 500;

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
      custom: m.custom,
    })),
  });
});

/**
 * Remote OpenRouter catalog. `?refresh=1` bypasses the 5-minute cache.
 * `existing: true` marks models already present in this gateway's registry.
 */
router.get("/v1/admin/openrouter/models", requireAuth, async (req, res) => {
  const refresh = req.query["refresh"] === "1" || req.query["refresh"] === "true";
  try {
    const catalog = await getOpenRouterCatalog({ refresh });
    const known = new Set(getModelRegistry().map((m) => m.id));
    res.json({
      object: "list",
      source: catalog.source,
      fetched_at: catalog.fetchedAt,
      data: catalog.models.map((m) => ({ ...m, existing: known.has(m.id) })),
    });
  } catch (err) {
    res.status(502).json({
      error: { message: err instanceof Error ? err.message : String(err), type: "upstream_error" },
    });
  }
});

/** Add models to the registry (used by the portal's "add OpenRouter model" panel). */
router.post("/v1/admin/models", requireAuth, (req, res) => {
  const body = (req.body ?? {}) as {
    ids?: unknown;
    models?: unknown;
    provider?: unknown;
  };
  const fallbackProvider = typeof body.provider === "string" ? body.provider : "openrouter";

  const inputs: Array<{ id?: unknown; provider?: unknown; created?: unknown }> = [];

  if (Array.isArray(body.ids)) {
    for (const id of body.ids) {
      inputs.push({ id, provider: fallbackProvider });
    }
  }
  if (Array.isArray(body.models)) {
    for (const raw of body.models) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      inputs.push({
        id: entry["id"],
        provider: entry["provider"] ?? fallbackProvider,
        created: entry["created"],
      });
    }
  }

  if (inputs.length === 0) {
    res.status(400).json({ error: { message: "ids[] or models[] is required" } });
    return;
  }
  if (inputs.length > MAX_ADD_BATCH) {
    res.status(400).json({
      error: { message: `Too many models in one request (max ${MAX_ADD_BATCH})` },
    });
    return;
  }

  const result = addCustomModels(inputs);
  res.json({ ok: true, added: result.added, skipped: result.skipped });
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

/** Delete an operator-added model. Built-in models can only be disabled. */
router.delete("/v1/admin/models", requireAuth, (req, res) => {
  const fromBody = (req.body ?? {}) as { id?: unknown };
  const id =
    typeof fromBody.id === "string"
      ? fromBody.id.trim()
      : typeof req.query["id"] === "string"
        ? req.query["id"].trim()
        : "";

  if (!id) {
    res.status(400).json({ error: { message: "id is required" } });
    return;
  }
  if (!removeCustomModel(id)) {
    res.status(404).json({
      error: { message: `"${id}" is not an operator-added model and cannot be deleted` },
    });
    return;
  }
  res.json({ ok: true });
});

export default router;
