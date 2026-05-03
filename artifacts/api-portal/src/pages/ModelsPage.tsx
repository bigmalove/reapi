import { useState, useEffect, useCallback } from "react";
import { fetchAdminModels, patchModel, patchProviderModels, type ModelEntry } from "../lib/api";

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "谷歌 Gemini",
  openrouter: "OpenRouter",
};

const PROVIDER_COLORS: Record<string, string> = {
  openai: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  anthropic: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  gemini: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  openrouter: "bg-purple-500/10 text-purple-400 border-purple-500/20",
};

function Toggle({ enabled, onChange, disabled }: { enabled: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={enabled}
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background disabled:opacity-50 ${
        enabled ? "bg-primary" : "bg-secondary"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          enabled ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

interface ProviderGroup {
  provider: string;
  models: ModelEntry[];
}

export default function ModelsPage() {
  const [groups, setGroups] = useState<ProviderGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const res = await fetchAdminModels();
      const map = new Map<string, ModelEntry[]>();
      for (const m of res.data) {
        if (!map.has(m.provider)) map.set(m.provider, []);
        map.get(m.provider)!.push(m);
      }
      const g: ProviderGroup[] = [];
      for (const [provider, models] of map) {
        g.push({ provider, models });
      }
      setGroups(g);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleModel(id: string, currentlyDisabled: boolean) {
    setUpdating((s) => new Set(s).add(id));
    try {
      await patchModel(id, !currentlyDisabled);
      setGroups((prev) =>
        prev.map((g) => ({
          ...g,
          models: g.models.map((m) => (m.id === id ? { ...m, disabled: !currentlyDisabled } : m)),
        }))
      );
    } catch (e) {
      alert(String(e));
    } finally {
      setUpdating((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  async function toggleAllForProvider(provider: string, enableAll: boolean) {
    const key = `_provider_${provider}`;
    setUpdating((s) => new Set(s).add(key));
    try {
      await patchProviderModels(provider, !enableAll);
      setGroups((prev) =>
        prev.map((g) =>
          g.provider === provider
            ? { ...g, models: g.models.map((m) => ({ ...m, disabled: !enableAll })) }
            : g
        )
      );
    } catch (e) {
      alert(String(e));
    } finally {
      setUpdating((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        正在加载模型...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        {error}
        <button onClick={load} className="ml-3 underline text-xs">
          重试
        </button>
      </div>
    );
  }

  const totalEnabled = groups.reduce((acc, g) => acc + g.models.filter((m) => !m.disabled).length, 0);
  const totalModels = groups.reduce((acc, g) => acc + g.models.length, 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">模型管理</h2>
        <p className="text-sm text-muted-foreground">
          已启用 {totalEnabled} / {totalModels} 个模型。已禁用的模型不会出现在 <code className="bg-secondary/60 px-1 rounded">/v1/models</code> 中。
        </p>
      </div>

      {groups.map((group) => {
        const allEnabled = group.models.every((m) => !m.disabled);
        const allDisabled = group.models.every((m) => m.disabled);
        const providerKey = `_provider_${group.provider}`;
        const isUpdatingProvider = updating.has(providerKey);
        const enabledCount = group.models.filter((m) => !m.disabled).length;

        return (
          <div key={group.provider} className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-secondary/20">
              <div className="flex items-center gap-3">
                <span
                  className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${
                    PROVIDER_COLORS[group.provider] ?? "bg-secondary/50 text-foreground border-border"
                  }`}
                >
                  {PROVIDER_LABELS[group.provider] ?? group.provider}
                </span>
                <span className="text-xs text-muted-foreground">
                  已启用 {enabledCount}/{group.models.length}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  disabled={isUpdatingProvider || allEnabled}
                  onClick={() => toggleAllForProvider(group.provider, true)}
                  className="text-xs px-2.5 py-1 rounded border border-border hover:bg-accent transition-colors disabled:opacity-40"
                >
                  全部启用
                </button>
                <button
                  disabled={isUpdatingProvider || allDisabled}
                  onClick={() => toggleAllForProvider(group.provider, false)}
                  className="text-xs px-2.5 py-1 rounded border border-border hover:bg-accent transition-colors disabled:opacity-40"
                >
                  全部禁用
                </button>
              </div>
            </div>

            <div className="divide-y divide-border">
              {group.models.map((model) => (
                <div
                  key={model.id}
                  className={`flex items-center justify-between gap-4 px-5 py-3 transition-colors ${
                    model.disabled ? "opacity-50" : ""
                  }`}
                >
                  <span className="font-mono text-sm text-foreground truncate">{model.id}</span>
                  <Toggle
                    enabled={!model.disabled}
                    disabled={updating.has(model.id)}
                    onChange={() => toggleModel(model.id, model.disabled)}
                  />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
