import { readJson, writeJson } from "./persist.js";

export interface ServerSettings {
  sillyTavernMode: boolean;
}

const DEFAULTS: ServerSettings = {
  sillyTavernMode: false,
};

let _settings: ServerSettings | null = null;

export function getSettings(): ServerSettings {
  if (_settings === null) {
    _settings = readJson<ServerSettings>("server_settings.json", DEFAULTS);
  }
  return _settings;
}

export function updateSettings(patch: Partial<ServerSettings>): ServerSettings {
  const current = getSettings();
  _settings = { ...current, ...patch };
  writeJson("server_settings.json", _settings);
  return _settings;
}
