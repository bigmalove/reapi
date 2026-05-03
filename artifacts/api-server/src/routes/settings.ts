import { Router } from "express";
import {
  getSettings,
  updateSettings,
  type ServerSettings,
  type ProviderName,
  type ProviderOverrides,
  type PoolEntry,
  type ReverseProxyMode,
} from "../lib/settings.js";
import { requireAuth } from "../lib/auth.js";

const router = Router();

const PROVIDERS: readonly ProviderName[] = ["openai", "anthropic", "gemini", "openrouter"];

interface PublicPoolEntry {
  url: string;
  apiKeySet: boolean;
}

interface PublicProviderOverride {
  url: string;
  apiKeySet: boolean;
}

interface PublicSettings {
  sillyTavernMode: boolean;
  reverseProxyEnabled: boolean;
  reverseProxyMode: ReverseProxyMode;
  reverseProxyPool: PublicPoolEntry[];
  providerOverrides: Record<ProviderName, PublicProviderOverride>;
}

function toPublic(s: ServerSettings): PublicSettings {
  const overrides = {} as Record<ProviderName, PublicProviderOverride>;
  for (const p of PROVIDERS) {
    overrides[p] = {
      url: s.providerOverrides[p].url,
      apiKeySet: !!s.providerOverrides[p].apiKey,
    };
  }
  return {
    sillyTavernMode: s.sillyTavernMode,
    reverseProxyEnabled: s.reverseProxyEnabled,
    reverseProxyMode: s.reverseProxyMode,
    reverseProxyPool: s.reverseProxyPool.map((e) => ({ url: e.url, apiKeySet: !!e.apiKey })),
    providerOverrides: overrides,
  };
}

function validateUrl(url: string, fieldName: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${fieldName} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${fieldName} must use http: or https:`);
  }
  return trimmed;
}

router.get("/api/settings", requireAuth, (_req, res) => {
  res.json(toPublic(getSettings()));
});

router.post("/api/settings", requireAuth, (req, res) => {
  const body = (req.body ?? {}) as {
    sillyTavernMode?: boolean;
    reverseProxyEnabled?: boolean;
    reverseProxyMode?: ReverseProxyMode;
    reverseProxyPool?: Array<{ url?: string; apiKey?: string | null }>;
    // Legacy back-compat fields (mapped onto pool[0]).
    reverseProxyUrl?: string;
    reverseProxyApiKey?: string | null;
    providerOverrides?: Partial<
      Record<ProviderName, { url?: string; apiKey?: string | null }>
    >;
  };
  const patch: Partial<ServerSettings> = {};
  const current = getSettings();

  if (typeof body.sillyTavernMode === "boolean") {
    patch.sillyTavernMode = body.sillyTavernMode;
  }
  if (typeof body.reverseProxyEnabled === "boolean") {
    patch.reverseProxyEnabled = body.reverseProxyEnabled;
  }
  if (body.reverseProxyMode !== undefined) {
    if (body.reverseProxyMode !== "round-robin" && body.reverseProxyMode !== "sticky") {
      res.status(400).json({
        error: { message: 'reverseProxyMode must be "round-robin" or "sticky"', type: "validation_error" },
      });
      return;
    }
    patch.reverseProxyMode = body.reverseProxyMode;
  }

  // Pool replacement (preferred path).
  if (Array.isArray(body.reverseProxyPool)) {
    const cleaned: PoolEntry[] = [];
    const seen = new Set<string>();
    // Build a lookup of existing keys keyed by URL so we can preserve them
    // when client sends back the same URL with blank apiKey ("leave unchanged").
    const existingKeyByUrl = new Map<string, string>();
    for (const e of current.reverseProxyPool) existingKeyByUrl.set(e.url, e.apiKey);

    for (let i = 0; i < body.reverseProxyPool.length; i++) {
      const incoming = body.reverseProxyPool[i] ?? {};
      let url: string;
      try {
        url = validateUrl(incoming.url ?? "", `reverseProxyPool[${i}].url`);
      } catch (e) {
        res.status(400).json({ error: { message: (e as Error).message, type: "validation_error" } });
        return;
      }
      if (!url) {
        res.status(400).json({
          error: { message: `reverseProxyPool[${i}].url is required`, type: "validation_error" },
        });
        return;
      }
      if (seen.has(url)) continue;
      seen.add(url);

      let apiKey: string;
      const incomingKey = incoming.apiKey;
      if (typeof incomingKey === "string" && incomingKey.length > 0) {
        apiKey = incomingKey;
      } else if (incomingKey === null) {
        apiKey = "";
      } else {
        // undefined or empty string → preserve existing key for this URL
        apiKey = existingKeyByUrl.get(url) ?? "";
      }
      cleaned.push({ url, apiKey });
    }
    patch.reverseProxyPool = cleaned;
  } else {
    // Legacy back-compat: reverseProxyUrl + reverseProxyApiKey map onto pool[0].
    if (typeof body.reverseProxyUrl === "string") {
      let legacyUrl: string;
      try {
        legacyUrl = validateUrl(body.reverseProxyUrl, "reverseProxyUrl");
      } catch (e) {
        res.status(400).json({ error: { message: (e as Error).message, type: "validation_error" } });
        return;
      }
      const existingFirst = current.reverseProxyPool[0];
      let legacyKey = existingFirst?.apiKey ?? "";
      if (typeof body.reverseProxyApiKey === "string" && body.reverseProxyApiKey.length > 0) {
        legacyKey = body.reverseProxyApiKey;
      } else if (body.reverseProxyApiKey === null) {
        legacyKey = "";
      }
      if (legacyUrl) {
        // Replace pool[0] (or insert), keep the rest.
        const rest = current.reverseProxyPool.slice(1).filter((e) => e.url !== legacyUrl);
        patch.reverseProxyPool = [{ url: legacyUrl, apiKey: legacyKey }, ...rest];
      } else {
        // Legacy clear: drop pool[0] but keep the rest. (Unlikely path.)
        patch.reverseProxyPool = current.reverseProxyPool.slice(1);
      }
    } else if (body.reverseProxyApiKey !== undefined) {
      // Legacy key-only update applies to pool[0].
      const first = current.reverseProxyPool[0];
      if (first) {
        let nextKey = first.apiKey;
        if (typeof body.reverseProxyApiKey === "string" && body.reverseProxyApiKey.length > 0) {
          nextKey = body.reverseProxyApiKey;
        } else if (body.reverseProxyApiKey === null) {
          nextKey = "";
        }
        patch.reverseProxyPool = [{ url: first.url, apiKey: nextKey }, ...current.reverseProxyPool.slice(1)];
      }
    }
  }

  if (body.providerOverrides && typeof body.providerOverrides === "object") {
    const merged: ProviderOverrides = {
      openai: { ...current.providerOverrides.openai },
      anthropic: { ...current.providerOverrides.anthropic },
      gemini: { ...current.providerOverrides.gemini },
      openrouter: { ...current.providerOverrides.openrouter },
    };
    for (const p of PROVIDERS) {
      const incoming = body.providerOverrides[p];
      if (!incoming) continue;
      if (typeof incoming.url === "string") {
        try {
          merged[p].url = validateUrl(incoming.url, `providerOverrides.${p}.url`);
        } catch (e) {
          res.status(400).json({ error: { message: (e as Error).message, type: "validation_error" } });
          return;
        }
      }
      if (typeof incoming.apiKey === "string" && incoming.apiKey.length > 0) {
        merged[p].apiKey = incoming.apiKey;
      } else if (incoming.apiKey === null) {
        merged[p].apiKey = "";
      }
    }
    patch.providerOverrides = merged;
  }

  // Reject enabling reverse-proxy mode without any usable upstream URL.
  const wantEnabled = patch.reverseProxyEnabled ?? current.reverseProxyEnabled;
  const nextPool = patch.reverseProxyPool ?? current.reverseProxyPool;
  const nextOverrides = patch.providerOverrides ?? current.providerOverrides;
  const anyOverrideUrl = Object.values(nextOverrides).some((o) => !!o.url);
  if (wantEnabled && nextPool.length === 0 && !anyOverrideUrl) {
    res.status(400).json({
      error: {
        message:
          "reverseProxyPool (or at least one providerOverrides.<provider>.url) must be set before enabling reverse-proxy mode",
        type: "validation_error",
      },
    });
    return;
  }

  const updated = updateSettings(patch);
  res.json(toPublic(updated));
});

export default router;
