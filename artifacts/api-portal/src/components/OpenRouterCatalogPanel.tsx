import { useCallback, useMemo, useState } from "react";
import {
  addModels,
  fetchOpenRouterCatalog,
  type AddModelSkipReason,
  type OpenRouterCatalogEntry,
  type OpenRouterCatalogResponse,
} from "../lib/api";

const SOURCE_LABELS: Record<string, string> = {
  "openrouter-public": "openrouter.ai 官方目录",
  "gateway-upstream": "网关上游 /models",
};

const SKIP_LABELS: Record<AddModelSkipReason, string> = {
  "invalid-id": "ID 无效",
  builtin: "已内置",
  "already-added": "已添加过",
  "limit-reached": "已达自定义模型上限",
};

/** Stay under the server's 500-per-request cap when adding a large selection. */
const ADD_CHUNK_SIZE = 400;

function formatContext(n: number | null): string | null {
  if (n === null || n <= 0) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** OpenRouter prices are per token; show them per million tokens. */
function formatPrice(raw: string | null): string | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return "免费";
  const perMillion = n * 1e6;
  const digits = perMillion >= 10 ? 0 : perMillion >= 1 ? 2 : 3;
  return `$${perMillion.toFixed(digits)}`;
}

function summarizeSkipped(skipped: Array<{ id: string; reason: AddModelSkipReason }>): string {
  const counts = new Map<AddModelSkipReason, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return Array.from(counts)
    .map(([reason, count]) => `${SKIP_LABELS[reason]} ${count} 个`)
    .join("、");
}

export default function OpenRouterCatalogPanel({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<OpenRouterCatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [hideExisting, setHideExisting] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await fetchOpenRouterCatalog(refresh);
      setCatalog(res);
      // Drop selections that no longer exist / were added meanwhile.
      const addable = new Set(res.data.filter((m) => !m.existing).map((m) => m.id));
      setSelected((prev) => new Set(Array.from(prev).filter((id) => addable.has(id))));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && catalog === null && !loading) void load(false);
  }

  const visible = useMemo<OpenRouterCatalogEntry[]>(() => {
    if (catalog === null) return [];
    const q = query.trim().toLowerCase();
    return catalog.data.filter((m) => {
      if (hideExisting && m.existing) return false;
      if (!q) return true;
      return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
    });
  }, [catalog, query, hideExisting]);

  const selectableVisible = useMemo(() => visible.filter((m) => !m.existing), [visible]);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of selectableVisible) next.add(m.id);
      return next;
    });
  }

  async function addSelected() {
    if (catalog === null || selected.size === 0) return;
    const picked = catalog.data.filter((m) => selected.has(m.id) && !m.existing);
    if (picked.length === 0) return;

    setAdding(true);
    setNotice("");
    setError("");
    try {
      const added: Array<{ id: string }> = [];
      const skipped: Array<{ id: string; reason: AddModelSkipReason }> = [];
      for (let i = 0; i < picked.length; i += ADD_CHUNK_SIZE) {
        const batch = picked.slice(i, i + ADD_CHUNK_SIZE);
        const result = await addModels(batch.map((m) => ({ id: m.id, created: m.created })));
        added.push(...result.added);
        skipped.push(...result.skipped);
      }

      const addedIds = new Set(added.map((m) => m.id));
      setCatalog((prev) =>
        prev === null
          ? prev
          : { ...prev, data: prev.data.map((m) => (addedIds.has(m.id) ? { ...m, existing: true } : m)) },
      );
      setSelected(new Set());
      const parts = [`已添加 ${added.length} 个模型`];
      if (skipped.length > 0) parts.push(`跳过 ${summarizeSkipped(skipped)}`);
      setNotice(parts.join("，"));
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <button
        onClick={toggleOpen}
        className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-accent/40 transition-colors"
      >
        <span
          className={`text-muted-foreground text-xs transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          ▶
        </span>
        <span className="text-sm font-medium text-foreground">添加 OpenRouter 模型</span>
        <span className="text-xs text-muted-foreground">
          从 OpenRouter 远程拉取最新模型列表，自行勾选加入模型列表
        </span>
        {catalog !== null && (
          <span className="ml-auto text-xs text-muted-foreground">
            远程 {catalog.data.length} 个
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-border px-5 py-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型 ID 或名称，例如 grok、qwen、gpt"
              className="flex-1 min-w-52 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground select-none">
              <input
                type="checkbox"
                checked={hideExisting}
                onChange={(e) => setHideExisting(e.target.checked)}
                className="size-3.5 accent-primary"
              />
              隐藏已在列表中的
            </label>
            <button
              onClick={() => void load(true)}
              disabled={loading}
              className="text-xs px-2.5 py-1 rounded border border-border hover:bg-accent transition-colors disabled:opacity-40"
            >
              {loading ? "拉取中..." : catalog === null ? "拉取列表" : "重新拉取"}
            </button>
          </div>

          {catalog !== null && (
            <p className="text-xs text-muted-foreground">
              来源：{SOURCE_LABELS[catalog.source] ?? catalog.source} · 更新于{" "}
              {new Date(catalog.fetched_at).toLocaleTimeString("zh-CN")} · 当前显示{" "}
              {visible.length} 个
            </p>
          )}

          {error !== "" && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {notice !== "" && (
            <div className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground">
              {notice}
            </div>
          )}

          {loading && catalog === null ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              正在从 OpenRouter 拉取模型列表...
            </div>
          ) : catalog === null ? null : visible.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">没有匹配的模型。</p>
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-md border border-border divide-y divide-border">
              {visible.map((model) => {
                const context = formatContext(model.contextLength);
                const promptPrice = formatPrice(model.promptPrice);
                const completionPrice = formatPrice(model.completionPrice);
                return (
                  <label
                    key={model.id}
                    className={`flex items-center gap-3 px-3 py-2 text-sm ${
                      model.existing ? "opacity-50" : "cursor-pointer hover:bg-accent/40"
                    }`}
                  >
                    <input
                      type="checkbox"
                      disabled={model.existing}
                      checked={selected.has(model.id)}
                      onChange={() => toggleOne(model.id)}
                      className="size-3.5 shrink-0 accent-primary"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-xs text-foreground truncate">
                        {model.id}
                      </span>
                      <span className="block text-xs text-muted-foreground truncate">
                        {model.name}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                      {context !== null && <span className="block">{context} ctx</span>}
                      {promptPrice !== null && (
                        <span className="block">
                          {promptPrice}
                          {completionPrice !== null ? ` / ${completionPrice}` : ""}
                        </span>
                      )}
                    </span>
                    {model.existing && (
                      <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                        已在列表
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          {catalog !== null && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">已选 {selected.size} 个</span>
              <button
                onClick={selectAllVisible}
                disabled={selectableVisible.length === 0}
                className="text-xs px-2.5 py-1 rounded border border-border hover:bg-accent transition-colors disabled:opacity-40"
              >
                全选当前 {selectableVisible.length} 个
              </button>
              <button
                onClick={() => setSelected(new Set())}
                disabled={selected.size === 0}
                className="text-xs px-2.5 py-1 rounded border border-border hover:bg-accent transition-colors disabled:opacity-40"
              >
                清空选择
              </button>
              <button
                onClick={() => void addSelected()}
                disabled={adding || selected.size === 0}
                className="ml-auto text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                {adding ? "添加中..." : `添加选中的 ${selected.size} 个`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
