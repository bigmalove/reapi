import { readJson, writeJson } from "./persist.js";

export interface ServerSettings {
  sillyTavernMode: boolean;
  reverseProxyEnabled: boolean;
  reverseProxyUrl: string;
  reverseProxyApiKey: string;
}

const DEFAULTS: ServerSettings = {
  sillyTavernMode: false,
  reverseProxyEnabled: false,
  reverseProxyUrl: "",
  reverseProxyApiKey: "",
};

let _settings: ServerSettings | null = null;

export function getSettings(): ServerSettings {
  if (_settings === null) {
    const loaded = readJson<Partial<ServerSettings>>("server_settings.json", DEFAULTS);
    _settings = { ...DEFAULTS, ...loaded };
  }
  return _settings;
}

export function updateSettings(patch: Partial<ServerSettings>): ServerSettings {
  const current = getSettings();
  const next = { ...current, ...patch };
  if (typeof next.reverseProxyUrl === "string") {
    next.reverseProxyUrl = next.reverseProxyUrl.trim().replace(/\/+$/, "");
  }
  _settings = next;
  writeJson("server_settings.json", _settings);
  return _settings;
}
