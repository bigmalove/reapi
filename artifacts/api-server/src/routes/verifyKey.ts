import { Router } from "express";
import { getProxyKey, extractProvidedKey } from "../lib/auth.js";

const router = Router();

router.get("/api/verify-key", (req, res) => {
  const proxyKey = getProxyKey();

  if (!proxyKey) {
    res.json({ valid: true, keyRequired: false });
    return;
  }

  const provided = extractProvidedKey(req);
  const valid = provided === proxyKey;
  res.json({ valid, keyRequired: true });
});

export default router;
