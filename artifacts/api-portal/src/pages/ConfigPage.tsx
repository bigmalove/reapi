import { useState, useEffect } from "react";
import {
  fetchSetupStatus,
  fetchSettings,
  updateSettings,
  type SetupStatus,
  type Settings,
  type ProviderName,
  type ProviderSource,
  type ReverseProxyMode,
  type SettingsPatch,
  type PoolEntryPatch,
} from "../lib/api";

const PROVIDERS: readonly ProviderName[] = ["openai", "anthropic", "gemini", "openrouter"];

const PROVIDER_LABEL: Record<ProviderName, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  openrouter: "OpenRouter",
};

function Badge({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        ok ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
      }`}
    >
      <span className="size-1.5 rounded-full inline-block" style={{ background: ok ? "#4ade80" : "#f87171" }} />
      {ok ? "Configured" : "Not set"}
    </span>
  );
}

function SourcePill({ source }: { source: ProviderSource | null | undefined }) {
  if (!source) return null;
  const styles: Record<ProviderSource, string> = {
    "upstream": "bg-blue-500/15 text-blue-400",
    "local-env": "bg-zinc-500/15 text-zinc-300",
    "per-provider override": "bg-purple-500/15 text-purple-400",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${styles[source]}`}>
      {source}
    </span>
  );
}

type PoolDraftEntry = { url: string; apiKey: string; apiKeyWasSet: boolean };
type OverrideDraft = { url: string; apiKey: string };

function emptyDraft(): OverrideDraft {
  return { url: "", apiKey: "" };
}

function emptyDrafts(): Record<ProviderName, OverrideDraft> {
  return {
    openai: emptyDraft(),
    anthropic: emptyDraft(),
    gemini: emptyDraft(),
    openrouter: emptyDraft(),
  };
}

export default function ConfigPage() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState(localStorage.getItem("gateway_api_key") ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadErr, setLoadErr] = useState("");

  // Pool editor state.
  const [poolDraft, setPoolDraft] = useState<PoolDraftEntry[]>([]);
  const [poolMode, setPoolMode] = useState<ReverseProxyMode>("sticky");
  const [rpSaving, setRpSaving] = useState(false);
  const [rpSaved, setRpSaved] = useState(false);
  const [rpErr, setRpErr] = useState("");

  // Per-provider override form state.
  const [overrideDrafts, setOverrideDrafts] = useState<Record<ProviderName, OverrideDraft>>(emptyDrafts());
  const [ovSavingProvider, setOvSavingProvider] = useState<ProviderName | null>(null);
  const [ovSavedProvider, setOvSavedProvider] = useState<ProviderName | null>(null);
  const [ovErr, setOvErr] = useState<Partial<Record<ProviderName, string>>>({});

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  function syncFormsFromSettings(cfg: Settings) {
    setPoolMode(cfg.reverseProxyMode);
    setPoolDraft(
      cfg.reverseProxyPool.map((e) => ({ url: e.url, apiKey: "", apiKeyWasSet: e.apiKeySet })),
    );
    const next: Record<ProviderName, OverrideDraft> = emptyDrafts();
    for (const p of PROVIDERS) {
      next[p] = { url: cfg.providerOverrides?.[p]?.url ?? "", apiKey: "" };
    }
    setOverrideDrafts(next);
  }

  useEffect(() => {
    fetchSetupStatus().then(setStatus).catch((e) => setLoadErr(String(e)));
    fetchSettings()
      .then((cfg) => {
        setSettings(cfg);
        syncFormsFromSettings(cfg);
      })
      .catch(() => {
        // Likely 401 — admin key not yet entered. Silent; user will save key.
      });
  }, []);

  async function refreshAll() {
    const [s, cfg] = await Promise.all([fetchSetupStatus(), fetchSettings()]);
    setStatus(s);
    setSettings(cfg);
    syncFormsFromSettings(cfg);
  }

  async function toggleReverseProxy() {
    if (!settings) return;
    setRpSaving(true);
    setRpErr("");
    try {
      const updated = await updateSettings({ reverseProxyEnabled: !settings.reverseProxyEnabled });
      setSettings(updated);
      const s = await fetchSetupStatus();
      setStatus(s);
    } catch (e) {
      setRpErr(String(e));
    } finally {
      setRpSaving(false);
    }
  }

  async function saveModeOnly(mode: ReverseProxyMode) {
    setPoolMode(mode);
    setRpErr("");
    try {
      const updated = await updateSettings({ reverseProxyMode: mode });
      setSettings(updated);
    } catch (e) {
      setRpErr(String(e));
    }
  }

  function addPoolRow() {
    setPoolDraft((prev) => [...prev, { url: "", apiKey: "", apiKeyWasSet: false }]);
  }

  function removePoolRow(i: number) {
    setPoolDraft((prev) => prev.filter((_, idx) => idx !== i));
  }

  function movePoolRow(i: number, dir: -1 | 1) {
    setPoolDraft((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  function clearPoolRowKey(i: number) {
    setPoolDraft((prev) =>
      prev.map((e, idx) => (idx === i ? { ...e, apiKey: "", apiKeyWasSet: false, _clear: true } as PoolDraftEntry & { _clear?: boolean } : e)),
    );
  }

  async function savePool() {
    setRpSaving(true);
    setRpErr("");
    try {
      const entries: PoolEntryPatch[] = [];
      for (let i = 0; i < poolDraft.length; i++) {
        const e = poolDraft[i]!;
        const url = e.url.trim().replace(/\/+$/, "");
        if (!url) throw new Error(`Pool entry #${i + 1}: URL is required`);
        if (!/^https?:\/\//i.test(url)) throw new Error(`Pool entry #${i + 1}: URL must start with http:// or https://`);
        const patch: PoolEntryPatch = { url };
        if (e.apiKey.length > 0) {
          patch.apiKey = e.apiKey;
        } else if ((e as PoolDraftEntry & { _clear?: boolean })._clear) {
          patch.apiKey = null;
        }
        // else: leave undefined → backend preserves existing key for this URL.
        entries.push(patch);
      }
      const updated = await updateSettings({ reverseProxyPool: entries, reverseProxyMode: poolMode });
      setSettings(updated);
      syncFormsFromSettings(updated);
      const s = await fetchSetupStatus();
      setStatus(s);
      setRpSaved(true);
      setTimeout(() => setRpSaved(false), 2000);
    } catch (e) {
      setRpErr(String(e));
    } finally {
      setRpSaving(false);
    }
  }

  async function saveOverride(provider: ProviderName) {
    setOvSavingProvider(provider);
    setOvErr((prev) => ({ ...prev, [provider]: "" }));
    try {
      const draft = overrideDrafts[provider];
      const url = draft.url.trim().replace(/\/+$/, "");
      if (url && !/^https?:\/\//i.test(url)) {
        throw new Error("URL must start with http:// or https://");
      }
      const patch: SettingsPatch = { providerOverrides: { [provider]: { url } } };
      if (draft.apiKey.length > 0) {
        patch.providerOverrides![provider]!.apiKey = draft.apiKey;
      }
      await updateSettings(patch);
      await refreshAll();
      setOvSavedProvider(provider);
      setTimeout(() => setOvSavedProvider((p) => (p === provider ? null : p)), 2000);
    } catch (e) {
      setOvErr((prev) => ({ ...prev, [provider]: String(e) }));
    } finally {
      setOvSavingProvider(null);
    }
  }

  async function clearOverrideKey(provider: ProviderName) {
    setOvSavingProvider(provider);
    setOvErr((prev) => ({ ...prev, [provider]: "" }));
    try {
      await updateSettings({ providerOverrides: { [provider]: { apiKey: null } } });
      await refreshAll();
    } catch (e) {
      setOvErr((prev) => ({ ...prev, [provider]: String(e) }));
    } finally {
      setOvSavingProvider(null);
    }
  }

  async function saveApiKey() {
    if (apiKey.trim()) {
      localStorage.setItem("gateway_api_key", apiKey.trim());
    } else {
      localStorage.removeItem("gateway_api_key");
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    try {
      await refreshAll();
    } catch (e) {
      setLoadErr(String(e));
    }
  }

  async function toggleSillyTavern() {
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await updateSettings({ sillyTavernMode: !settings.sillyTavernMode });
      setSettings(updated);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">Configuration</h2>
        <p className="text-sm text-muted-foreground">Manage gateway settings and API key authentication.</p>
      </div>

      {loadErr && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {loadErr}
        </div>
      )}

      {/* Base URL */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Gateway Base URL</h3>
        <div className="flex items-center gap-2 rounded-md bg-secondary/50 px-3 py-2 font-mono text-sm text-foreground">
          {baseUrl}
        </div>
        <p className="text-xs text-muted-foreground">
          Use this URL as the base for all API calls. For OpenAI-compatible clients, append <code className="bg-secondary/60 px-1 rounded">/v1</code>.
        </p>
      </div>

      {/* Gateway API Key */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Gateway API Key (for this browser)</h3>
        <p className="text-xs text-muted-foreground">
          If you set <code className="bg-secondary/60 px-1 rounded">PROXY_API_KEY</code> as an environment variable on the server, enter it here to authenticate admin requests. Stored in local storage only.
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="flex-1 rounded-md border border-input bg-secondary/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            onClick={saveApiKey}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
          >
            {saved ? "Saved!" : "Save"}
          </button>
        </div>
      </div>

      {/* Gateway Auth Status */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Gateway Auth Status</h3>
        {status ? (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">PROXY_API_KEY</span>
            <Badge ok={status.providers.proxyKey} />
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Loading...</div>
        )}
        <p className="text-xs text-muted-foreground">
          Set <code className="bg-secondary/60 px-1 rounded">PROXY_API_KEY</code> as an environment variable to require authentication on all <code className="bg-secondary/60 px-1 rounded">/v1/*</code> requests. If not set, the gateway is open.
        </p>
      </div>

      {/* Reverse Proxy Pool */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Upstream Reverse Proxy Pool</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Forward all 4 providers to a pool of one or more remote upstream gateways'{" "}
              <code className="bg-secondary/60 px-1 rounded">/modelfarm/&#123;openai,anthropic,google,openrouter&#125;</code> endpoints.
              Choose <strong>round-robin</strong> to rotate across the pool, or <strong>sticky</strong> to always use the first entry.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings?.reverseProxyEnabled ?? false}
            disabled={rpSaving || !settings}
            onClick={toggleReverseProxy}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background disabled:opacity-50 ${
              settings?.reverseProxyEnabled ? "bg-primary" : "bg-secondary"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                settings?.reverseProxyEnabled ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        {/* Mode selector */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Mode:</span>
          {(["round-robin", "sticky"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => saveModeOnly(m)}
              className={`rounded-md border px-3 py-1 transition-colors ${
                poolMode === m
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border bg-secondary/30 text-muted-foreground hover:bg-secondary/60"
              }`}
            >
              {m === "round-robin" ? "Round-robin" : "Sticky (use #1)"}
            </button>
          ))}
          <span className="ml-auto text-muted-foreground">
            Pool: {poolDraft.length} URL{poolDraft.length === 1 ? "" : "s"}
          </span>
        </div>

        {/* Pool editor */}
        <div className="space-y-3">
          {poolDraft.length === 0 && (
            <div className="rounded-md border border-dashed border-border/60 bg-secondary/10 p-3 text-xs text-muted-foreground">
              No upstream URLs yet. Click "Add upstream" to add one.
            </div>
          )}
          {poolDraft.map((entry, i) => (
            <div key={i} className="rounded-md border border-border/60 bg-secondary/10 p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground">
                  Upstream #{i + 1}
                  {i === 0 && <span className="ml-1 text-[10px] text-muted-foreground">(used in sticky mode)</span>}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() => movePoolRow(i, -1)}
                    className="rounded border border-border bg-secondary/30 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary/60 disabled:opacity-30"
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={i === poolDraft.length - 1}
                    onClick={() => movePoolRow(i, 1)}
                    className="rounded border border-border bg-secondary/30 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary/60 disabled:opacity-30"
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removePoolRow(i)}
                    className="rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/20"
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <input
                type="text"
                value={entry.url}
                onChange={(e) =>
                  setPoolDraft((prev) =>
                    prev.map((x, idx) => (idx === i ? { ...x, url: e.target.value } : x)),
                  )
                }
                placeholder="https://your-upstream.replit.dev"
                className="w-full rounded-md border border-input bg-secondary/30 px-3 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex gap-2">
                <input
                  type="password"
                  autoComplete="new-password"
                  value={entry.apiKey}
                  onChange={(e) =>
                    setPoolDraft((prev) =>
                      prev.map((x, idx) => (idx === i ? { ...x, apiKey: e.target.value } : x)),
                    )
                  }
                  placeholder={
                    entry.apiKeyWasSet
                      ? "•••••••• (saved — leave blank to keep)"
                      : i === 0
                      ? "(blank — no auth)"
                      : "(blank — falls back to #1's key)"
                  }
                  className="flex-1 rounded-md border border-input bg-secondary/30 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                {entry.apiKeyWasSet && (
                  <button
                    type="button"
                    onClick={() => clearPoolRowKey(i)}
                    className="rounded-md border border-border bg-secondary/30 px-2 py-1 text-[11px] text-muted-foreground hover:bg-secondary/60 transition-colors"
                  >
                    Clear key
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={addPoolRow}
            className="rounded-md border border-border bg-secondary/30 px-3 py-1.5 text-xs text-foreground hover:bg-secondary/60 transition-colors"
          >
            + Add upstream
          </button>
          <button
            onClick={savePool}
            disabled={rpSaving}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {rpSaved ? "Saved!" : rpSaving ? "Saving..." : "Save Pool"}
          </button>
          {settings?.reverseProxyEnabled && status?.reverseProxy && (
            <span className="text-xs text-green-400">
              Active — {status.pool?.size ?? 0} URL{(status.pool?.size ?? 0) === 1 ? "" : "s"}, {status.pool?.mode ?? "sticky"}
            </span>
          )}
          {!settings?.reverseProxyEnabled && (
            <span className="text-xs text-muted-foreground">Disabled — using local env keys</span>
          )}
        </div>

        {rpErr && <div className="text-xs text-destructive">{rpErr}</div>}
      </div>

      {/* Per-provider overrides */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Per-provider Overrides</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Optionally route individual providers to a different upstream URL or with a different API key. Overrides take precedence over the pool. Blank fields fall back to the pool; if the pool is also empty, the provider falls back to its local Replit AI Integration env vars.
          </p>
        </div>

        <div className="space-y-4">
          {PROVIDERS.map((provider) => {
            const draft = overrideDrafts[provider];
            const stored = settings?.providerOverrides?.[provider];
            const source = status?.providerSources?.[provider] ?? null;
            return (
              <div key={provider} className="rounded-md border border-border/60 bg-secondary/10 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{PROVIDER_LABEL[provider]}</span>
                    <SourcePill source={source} />
                  </div>
                  <Badge ok={!!status?.providers[provider]} />
                </div>
                <input
                  type="text"
                  value={draft.url}
                  onChange={(e) =>
                    setOverrideDrafts((prev) => ({ ...prev, [provider]: { ...prev[provider], url: e.target.value } }))
                  }
                  placeholder="(blank — use pool)"
                  className="w-full rounded-md border border-input bg-secondary/30 px-3 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="flex gap-2">
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={draft.apiKey}
                    onChange={(e) =>
                      setOverrideDrafts((prev) => ({ ...prev, [provider]: { ...prev[provider], apiKey: e.target.value } }))
                    }
                    placeholder={stored?.apiKeySet ? "•••••••• (saved — leave blank to keep)" : "(blank — use pool's key)"}
                    className="flex-1 rounded-md border border-input bg-secondary/30 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  {stored?.apiKeySet && (
                    <button
                      type="button"
                      onClick={() => clearOverrideKey(provider)}
                      disabled={ovSavingProvider === provider}
                      className="rounded-md border border-border bg-secondary/30 px-2 py-1 text-[11px] text-muted-foreground hover:bg-secondary/60 transition-colors disabled:opacity-50"
                    >
                      Clear key
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => saveOverride(provider)}
                    disabled={ovSavingProvider === provider}
                    className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {ovSavedProvider === provider
                      ? "Saved!"
                      : ovSavingProvider === provider
                        ? "Saving..."
                        : "Save"}
                  </button>
                </div>
                {ovErr[provider] && <div className="text-xs text-destructive">{ovErr[provider]}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Provider Status */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">AI Provider Status</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {status?.reverseProxy
              ? `Reverse-proxy mode active — pool of ${status.pool?.size ?? 0} URL${(status.pool?.size ?? 0) === 1 ? "" : "s"}, ${status.pool?.mode ?? "sticky"} mode.`
              : "All providers are connected via Replit AI Integrations — no external API keys required. Usage is billed to your Replit credits."}
          </p>
        </div>
        {status ? (
          <div className="space-y-2">
            {PROVIDERS.map((provider) => (
              <div key={provider} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{PROVIDER_LABEL[provider]}</span>
                <div className="flex items-center gap-2">
                  <SourcePill source={status.providerSources?.[provider] ?? null} />
                  <Badge ok={status.providers[provider]} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Loading...</div>
        )}
      </div>

      {/* SillyTavern Mode */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">SillyTavern Mode</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              When enabled, appends{" "}
              <code className="bg-secondary/60 px-1 rounded">{"{ role: \"user\", content: \"继续\" }"}</code> to
              Claude requests that have no tools. Useful for SillyTavern clients.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings?.sillyTavernMode ?? false}
            disabled={saving || !settings}
            onClick={toggleSillyTavern}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background disabled:opacity-50 ${
              settings?.sillyTavernMode ? "bg-primary" : "bg-secondary"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                settings?.sillyTavernMode ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>

      {/* System info */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h3 className="text-sm font-semibold text-foreground">About This Gateway</h3>
        <ul className="space-y-1.5 text-xs text-muted-foreground">
          <li>• Single-instance AI gateway — no clusters, no nodes</li>
          <li>• Unified OpenAI-compatible interface for 4 providers</li>
          <li>• Powered by Replit AI Integrations — no external API keys needed</li>
          <li>• Supports streaming SSE and tool calling</li>
          <li>• Default model: <code className="bg-secondary/60 px-1 rounded">gpt-4.1-mini</code></li>
        </ul>
      </div>
    </div>
  );
}
