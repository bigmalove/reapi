import { Router } from "express";
import { getSettings, updateSettings, type ServerSettings } from "../lib/settings.js";
import { requireAuth } from "../lib/auth.js";

const router = Router();

interface PublicSettings {
  sillyTavernMode: boolean;
  reverseProxyEnabled: boolean;
  reverseProxyUrl: string;
  reverseProxyApiKeySet: boolean;
}

function toPublic(s: ServerSettings): PublicSettings {
  return {
    sillyTavernMode: s.sillyTavernMode,
    reverseProxyEnabled: s.reverseProxyEnabled,
    reverseProxyUrl: s.reverseProxyUrl,
    reverseProxyApiKeySet: !!s.reverseProxyApiKey,
  };
}

function validateUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("reverseProxyUrl must be a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("reverseProxyUrl must use http: or https:");
  }
  return trimmed;
}

router.get("/api/settings", requireAuth, (_req, res) => {
  res.json(toPublic(getSettings()));
});

router.post("/api/settings", requireAuth, (req, res) => {
  const body = (req.body ?? {}) as Partial<ServerSettings>;
  const patch: Partial<ServerSettings> = {};

  if (typeof body.sillyTavernMode === "boolean") {
    patch.sillyTavernMode = body.sillyTavernMode;
  }
  if (typeof body.reverseProxyEnabled === "boolean") {
    patch.reverseProxyEnabled = body.reverseProxyEnabled;
  }
  if (typeof body.reverseProxyUrl === "string") {
    try {
      patch.reverseProxyUrl = validateUrl(body.reverseProxyUrl);
    } catch (e) {
      res.status(400).json({ error: { message: (e as Error).message, type: "validation_error" } });
      return;
    }
  }
  // Only update the API key when a non-empty string is provided. Empty string
  // means "leave unchanged"; to clear it the client must send `null`.
  if (typeof body.reverseProxyApiKey === "string" && body.reverseProxyApiKey.length > 0) {
    patch.reverseProxyApiKey = body.reverseProxyApiKey;
  } else if (body.reverseProxyApiKey === null) {
    patch.reverseProxyApiKey = "";
  }

  // Reject enabling reverse-proxy mode without a valid upstream URL — avoids
  // silently falling back to local env when the user thought they had switched.
  const current = getSettings();
  const wantEnabled = patch.reverseProxyEnabled ?? current.reverseProxyEnabled;
  const nextUrl = patch.reverseProxyUrl ?? current.reverseProxyUrl;
  if (wantEnabled && !nextUrl) {
    res.status(400).json({
      error: {
        message: "reverseProxyUrl must be set before enabling reverse-proxy mode",
        type: "validation_error",
      },
    });
    return;
  }

  const updated = updateSettings(patch);
  res.json(toPublic(updated));
});

export default router;
