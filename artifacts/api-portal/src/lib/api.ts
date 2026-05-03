const API_BASE = "/api";
const V1_BASE = "/v1";

export type ProviderName = "openai" | "anthropic" | "gemini" | "openrouter";

export type ProviderSource = "upstream" | "local-env" | "per-provider override";

export type ReverseProxyMode = "round-robin" | "sticky";

export interface SetupStatus {
  configured: boolean;
  providers: {
    openai: boolean;
    anthropic: boolean;
    gemini: boolean;
    openrouter: boolean;
    proxyKey: boolean;
  };
  providerSources?: Record<ProviderName, ProviderSource | null>;
  reverseProxy?: boolean;
  pool?: { size: number; mode: ReverseProxyMode };
}

export interface PublicProviderOverride {
  url: string;
  apiKeySet: boolean;
}

export interface PublicPoolEntry {
  url: string;
  apiKeySet: boolean;
}

export interface Settings {
  sillyTavernMode: boolean;
  reverseProxyEnabled: boolean;
  reverseProxyMode: ReverseProxyMode;
  reverseProxyPool: PublicPoolEntry[];
  providerOverrides: Record<ProviderName, PublicProviderOverride>;
}

export interface ProviderOverridePatch {
  url?: string;
  // Empty string = leave unchanged; null = clear the stored key.
  apiKey?: string | null;
}

export interface PoolEntryPatch {
  url: string;
  // Empty string / undefined = preserve existing key for this URL; null = clear.
  apiKey?: string | null;
}

export interface SettingsPatch {
  sillyTavernMode?: boolean;
  reverseProxyEnabled?: boolean;
  reverseProxyMode?: ReverseProxyMode;
  reverseProxyPool?: PoolEntryPatch[];
  providerOverrides?: Partial<Record<ProviderName, ProviderOverridePatch>>;
}

export interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  provider: string;
  disabled: boolean;
}

export interface ModelsResponse {
  object: string;
  data: ModelEntry[];
}

function getApiKey(): string {
  return localStorage.getItem("gateway_api_key") ?? "";
}

function authHeaders(): HeadersInit {
  const key = getApiKey();
  return key ? { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await fetch(`${API_BASE}/setup-status`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSettings(): Promise<Settings> {
  const res = await fetch(`${API_BASE}/settings`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const res = await fetch(`${API_BASE}/settings`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchAdminModels(): Promise<ModelsResponse> {
  const res = await fetch(`${V1_BASE}/admin/models`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function patchModel(id: string, disabled: boolean): Promise<void> {
  const res = await fetch(`${V1_BASE}/admin/models`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ id, disabled }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function patchProviderModels(provider: string, all_disabled: boolean): Promise<void> {
  const res = await fetch(`${V1_BASE}/admin/models`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ provider, all_disabled }),
  });
  if (!res.ok) throw new Error(await res.text());
}
