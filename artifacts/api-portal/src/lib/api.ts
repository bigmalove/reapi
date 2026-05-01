const API_BASE = "/api";
const V1_BASE = "/v1";

export interface SetupStatus {
  configured: boolean;
  providers: {
    openai: boolean;
    anthropic: boolean;
    gemini: boolean;
    openrouter: boolean;
    proxyKey: boolean;
  };
}

export interface Settings {
  sillyTavernMode: boolean;
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
  const res = await fetch(`${API_BASE}/settings`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
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
