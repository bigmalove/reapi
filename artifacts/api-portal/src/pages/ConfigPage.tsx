import { useState, useEffect } from "react";
import { fetchSetupStatus, fetchSettings, updateSettings, type SetupStatus, type Settings } from "../lib/api";

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

export default function ConfigPage() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState(localStorage.getItem("gateway_api_key") ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadErr, setLoadErr] = useState("");

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    Promise.all([fetchSetupStatus(), fetchSettings()])
      .then(([s, cfg]) => {
        setStatus(s);
        setSettings(cfg);
      })
      .catch((e) => setLoadErr(String(e)));
  }, []);

  function saveApiKey() {
    if (apiKey.trim()) {
      localStorage.setItem("gateway_api_key", apiKey.trim());
    } else {
      localStorage.removeItem("gateway_api_key");
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
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

      {/* Provider Status */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">AI Provider Status</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            All providers are connected via Replit AI Integrations — no external API keys required. Usage is billed to your Replit credits.
          </p>
        </div>
        {status ? (
          <div className="space-y-2">
            {(["openai", "anthropic", "gemini", "openrouter"] as const).map((provider) => (
              <div key={provider} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground capitalize">{provider === "openrouter" ? "OpenRouter" : provider.charAt(0).toUpperCase() + provider.slice(1)}</span>
                <Badge ok={status.providers[provider]} />
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
