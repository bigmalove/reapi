import { readJson, writeJson } from "./persist.js";

export type ProviderName = "openai" | "anthropic" | "gemini" | "openrouter";

export interface ProviderOverride {
  url: string;
  apiKey: string;
}

export type ProviderOverrides = Record<ProviderName, ProviderOverride>;

export type ReverseProxyMode = "round-robin" | "sticky";

export interface PoolEntry {
  url: string;
  apiKey: string;
}

export interface ServerSettings {
  sillyTavernMode: boolean;
  reverseProxyEnabled: boolean;
  reverseProxyMode: ReverseProxyMode;
  reverseProxyPool: PoolEntry[];
  providerOverrides: ProviderOverrides;
}

const EMPTY_OVERRIDE: ProviderOverride = { url: "", apiKey: "" };

const EMPTY_OVERRIDES: ProviderOverrides = {
  openai: { ...EMPTY_OVERRIDE },
  anthropic: { ...EMPTY_OVERRIDE },
  gemini: { ...EMPTY_OVERRIDE },
  openrouter: { ...EMPTY_OVERRIDE },
};

const DEFAULTS: ServerSettings = {
  sillyTavernMode: false,
  reverseProxyEnabled: false,
  reverseProxyMode: "sticky",
  reverseProxyPool: [],
  providerOverrides: EMPTY_OVERRIDES,
};

let _settings: ServerSettings | null = null;

function normalizeOverrides(raw: unknown): ProviderOverrides {
  const out: ProviderOverrides = {
    openai: { ...EMPTY_OVERRIDE },
    anthropic: { ...EMPTY_OVERRIDE },
    gemini: { ...EMPTY_OVERRIDE },
    openrouter: { ...EMPTY_OVERRIDE },
  };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const p of ["openai", "anthropic", "gemini", "openrouter"] as const) {
    const v = r[p];
    if (v && typeof v === "object") {
      const vo = v as Record<string, unknown>;
      out[p] = {
        url: typeof vo["url"] === "string" ? vo["url"] : "",
        apiKey: typeof vo["apiKey"] === "string" ? vo["apiKey"] : "",
      };
    }
  }
  return out;
}

function normalizePool(raw: unknown): PoolEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PoolEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    const url = typeof v["url"] === "string" ? v["url"].trim().replace(/\/+$/, "") : "";
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      apiKey: typeof v["apiKey"] === "string" ? v["apiKey"] : "",
    });
  }
  return out;
}

function normalizeMode(raw: unknown): ReverseProxyMode {
  return raw === "round-robin" ? "round-robin" : "sticky";
}

export function getSettings(): ServerSettings {
  if (_settings === null) {
    const loaded = readJson<Record<string, unknown>>("server_settings.json", {});
    let pool = normalizePool(loaded["reverseProxyPool"]);
    // Legacy migration: if no pool but old scalar URL exists, seed it.
    if (pool.length === 0 && typeof loaded["reverseProxyUrl"] === "string") {
      const legacyUrl = (loaded["reverseProxyUrl"] as string).trim().replace(/\/+$/, "");
      if (legacyUrl) {
        const legacyKey = typeof loaded["reverseProxyApiKey"] === "string" ? (loaded["reverseProxyApiKey"] as string) : "";
        pool = [{ url: legacyUrl, apiKey: legacyKey }];
      }
    }
    _settings = {
      ...DEFAULTS,
      sillyTavernMode: typeof loaded["sillyTavernMode"] === "boolean" ? loaded["sillyTavernMode"] : DEFAULTS.sillyTavernMode,
      reverseProxyEnabled: typeof loaded["reverseProxyEnabled"] === "boolean" ? loaded["reverseProxyEnabled"] : DEFAULTS.reverseProxyEnabled,
      reverseProxyMode: normalizeMode(loaded["reverseProxyMode"]),
      reverseProxyPool: pool,
      providerOverrides: normalizeOverrides(loaded["providerOverrides"]),
    };
  }
  return _settings;
}

export function updateSettings(patch: Partial<ServerSettings>): ServerSettings {
  const current = getSettings();
  const next: ServerSettings = { ...current, ...patch };

  if (patch.reverseProxyPool) {
    // Pool is replaced atomically; preserve existing keys when an entry with
    // the same URL is resubmitted with a blank apiKey (the route layer also
    // applies null-vs-empty semantics before we get here).
    const seen = new Set<string>();
    const cleaned: PoolEntry[] = [];
    for (const e of patch.reverseProxyPool) {
      const url = (e.url ?? "").trim().replace(/\/+$/, "");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      cleaned.push({ url, apiKey: e.apiKey ?? "" });
    }
    next.reverseProxyPool = cleaned;
  }

  if (patch.providerOverrides) {
    const merged: ProviderOverrides = { ...current.providerOverrides };
    for (const p of ["openai", "anthropic", "gemini", "openrouter"] as const) {
      const incoming = patch.providerOverrides[p];
      if (incoming) {
        merged[p] = {
          url: (incoming.url ?? current.providerOverrides[p].url).trim().replace(/\/+$/, ""),
          apiKey: incoming.apiKey ?? current.providerOverrides[p].apiKey,
        };
      }
    }
    next.providerOverrides = merged;
  }

  if (patch.reverseProxyMode !== undefined) {
    next.reverseProxyMode = normalizeMode(patch.reverseProxyMode);
  }

  _settings = next;
  writeJson("server_settings.json", _settings);
  return _settings;
}
