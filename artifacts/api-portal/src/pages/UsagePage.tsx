import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  fetchUsageReport,
  refreshUsagePrices,
  resetUsageLedger,
  type UsageAccountRow,
  type UsageChannelRow,
  type UsageRecentEvent,
  type UsageReport,
  type UsageWindow,
} from "../lib/api";

/**
 * 用量统计页。
 *
 * 数据全部来自 `GET /api/usage`（`lib/usageLedger.ts`）：总量、按 provider /
 * 按账户 / 按模型（含 OpenRouter 渠道拆解）、每日序列、最近调用、屏蔽池状态
 * 与价格快照信息。页面自身只保留视图状态（时间窗、展开的卡片、轮询），所有
 * 金额都是后端按 OpenRouter 目录价或上游自报成本算好的，前端不做二次换算。
 *
 * 依赖：只用 React + ../lib/api。
 */

const WINDOWS: Array<{ id: UsageWindow; label: string }> = [
  { id: "24h", label: "24 小时" },
  { id: "7d", label: "7 天" },
  { id: "30d", label: "30 天" },
  { id: "all", label: "全部" },
];

/** 最近调用区展示的条数。 */
const RECENT_LIMIT = 5;

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  openrouter: "OpenRouter",
};

/**
 * 供应商 = OpenRouter 背后的实际渠道商。
 *
 * 账本里的 `provider` 只是本网关的通道（openrouter / openai / anthropic /
 * gemini），一列全是 “OpenRouter”，没有信息量。真正是谁在服务请求，要看
 * OpenRouter 响应里每帧都带的 `provider` 字段（"Wafer"、"DeepSeek"、
 * "StreamLake"…），后端已把它记成 `upstreamProvider` / `channels`。
 */
function channelLabel(name: string | undefined): { text: string; muted: boolean; hint: string } {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) {
    return { text: "未上报", muted: true, hint: "旧账本或直连渠道没有渠道商字段" };
  }
  return { text: trimmed, muted: false, hint: `OpenRouter 渠道商：${trimmed}` };
}

/**
 * 模型行的渠道商摘要：一行的流量常常分给好几个渠道商，这里列前两个，
 * 其余折叠成 “+N”，完整清单放 tooltip。
 */
function channelSummary(channels: UsageChannelRow[]): { text: string; extra: number; hint: string } {
  if (channels.length === 0) {
    return { text: "未上报", extra: 0, hint: "该模型还没有记录到渠道商" };
  }
  const hint = channels
    .map(
      (channel) =>
        `${channel.name} · ${channel.requests.toLocaleString("zh-CN")} 次 · ${(
          channel.totalTokens / 1_000_000
        ).toFixed(2)}M tokens · ${channel.sharePct.toFixed(1)}%`,
    )
    .join("\n");
  const shown = channels.slice(0, 2).map((channel) => channel.name);
  return { text: shown.join(" / "), extra: Math.max(0, channels.length - 2), hint };
}

const STATUS_STYLES: Record<UsageAccountRow["status"], { label: string; className: string }> = {
  active: { label: "在池", className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  "blocked-quota": { label: "403 额度耗尽", className: "bg-red-500/10 text-red-400 border-red-500/20" },
  "blocked-suspect": {
    label: "疑似限流",
    className: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  },
  blocked: { label: "已屏蔽", className: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  // `requires-wakeup` rows carry no recovery window: nothing times them out, so
  // an operator has to act. Labelled by what it means here, not by the reason name.
  wakeup: { label: "待恢复", className: "bg-slate-500/10 text-slate-300 border-slate-500/20" },
  inactive: { label: "未使用", className: "bg-slate-500/10 text-slate-400 border-slate-500/20" },
};

/**
 * Human label for the 屏蔽池 badge.
 *
 * The raw `upstreamReason` used to be printed verbatim, so a pool node's
 * `quota-exhausted` envelope — emitted for every upstream 429 — sat next to a
 * real `FREE_TIER_BUDGET_EXCEEDED` and both read as "quota gone". They are not
 * the same verdict: one is a confirmed 403 budget body on a 31-day window, the
 * other a five-minute guess awaiting a probe.
 */
function blockedBadge(blocked: NonNullable<UsageAccountRow["blocked"]>): {
  label: string;
  className: string;
} {
  // Manual-recovery class: no `recoverAt`, so it never expires by itself.
  if (blocked.disabledReason === "requires-wakeup") {
    return {
      label: "待恢复 · 需人工处理",
      className: "border-slate-500/20 bg-slate-500/10 text-slate-300",
    };
  }

  // Confirmed spend: 403 + explicit budget wording + no inference marker.
  if (blocked.upstreamStatus === 403 && blocked.quotaSignalUnverified !== true) {
    if (blocked.upstreamReason === "FREE_TIER_BUDGET_EXCEEDED") {
      return { label: "额度耗尽 · 403", className: "border-red-500/20 bg-red-500/10 text-red-400" };
    }
    return {
      label: blocked.upstreamReason || blocked.disabledReason,
      className: "border-red-500/20 bg-red-500/10 text-red-400",
    };
  }

  // Only an inferred quota signal (the gateway folding every upstream 429 into
  // `quota-exhausted`) earns a probe window, and the window is read from
  // `recoverAt` rather than assumed. A row without that field was never
  // scheduled for a re-check, so it must not claim to be one.
  if (blocked.quotaSignalUnverified === true || blocked.upstreamStatus === 429) {
    return {
      label: blocked.recoverAt ? "疑似限流 · 5 分钟复核" : "疑似限流 · 无复核窗口",
      className: "border-orange-500/20 bg-orange-500/10 text-orange-400",
    };
  }

  // Everything else (402, empty-body 500, a row with no recorded reason) is
  // reported as what it is instead of borrowing the rate-limit wording.
  return {
    label: blocked.upstreamReason || blocked.disabledReason || "原因未记录",
    className: "border-amber-500/20 bg-amber-500/10 text-amber-400",
  };
}

function fmtInt(n: number): string {
  return n.toLocaleString("zh-CN");
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(6)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function fmtPrice(perM: number | null): string {
  if (perM === null) return "—";
  if (perM === 0) return "免费";
  return `$${perM < 0.01 ? perM.toFixed(4) : perM.toFixed(2)}`;
}

function fmtTime(ts?: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

/** Clock-only stamp for the recent-calls list: the day is in the tooltip. */
function fmtClock(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * Account cell for the 最近调用 table.
 *
 * `recordUsage` falls back to the upstream node URL when the pool entry carries
 * no account, so a bare `http://…` here means "attributed to a node, not to an
 * account" — worth saying explicitly instead of printing a URL in the 账户
 * column and letting it read as an account id.
 */
function recentAccount(event: UsageRecentEvent): { text: string; hint: string; muted: boolean } {
  const raw = event.account?.trim() ?? "";
  if (!raw) return { text: "—", hint: "上游未回传账户标识", muted: true };
  if (/^https?:\/\//i.test(raw)) {
    return { text: "未归属账户", hint: `仅记录了节点地址：${raw}`, muted: true };
  }
  return { text: raw, hint: raw, muted: false };
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/60 p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">{value}</div>
      {hint ? <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/**
 * Collapsible panel used by the 账户额度消耗 / 屏蔽池 blocks.
 *
 * Both blocks are long tables that bury the four summary cards, so they start
 * folded: the header alone carries the digest (counts, tokens, cost), and the
 * full table only mounts after an explicit click.
 */
function CollapsibleSection({
  title,
  titleHint,
  badges,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  titleHint?: string;
  badges?: ReactNode;
  summary: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card/40">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={`${titleHint ? `${titleHint}\n` : ""}${open ? "点击收起" : "点击展开"}`}
        className={`flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-secondary/30 ${
          open ? "border-b border-border" : ""
        }`}
      >
        <span
          className={`w-2 shrink-0 text-[10px] text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        >
          ▶
        </span>
        <span className="text-xs font-semibold text-foreground">{title}</span>
        {badges}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground [&>span:not(:first-child)]:before:mr-2 [&>span:not(:first-child)]:before:text-muted-foreground/50 [&>span:not(:first-child)]:before:content-['·']">
          {summary}
        </span>
        <span className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {open ? "收起" : "展开"}
        </span>
      </button>
      {open ? children : null}
    </section>
  );
}

export default function UsagePage() {
  const [range, setRange] = useState<UsageWindow>("7d");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // 默认折叠：两个明细块只先亮出摘要。
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [blockedOpen, setBlockedOpen] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const data = await fetchUsageReport(range);
        setReport(data);
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [range],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => void load(true), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  const blocked = useMemo(
    () => (report?.byAccount ?? []).filter((row) => row.blocked),
    [report],
  );

  // 在池账户排到最前面，其余账户保持原来的消耗量排序。
  const accounts = useMemo(() => {
    const rows = report?.byAccount ?? [];
    return [...rows].sort((a, b) => {
      const rank = (row: UsageAccountRow) => (row.status === "active" ? 0 : 1);
      return rank(a) - rank(b) || b.totalTokens - a.totalTokens;
    });
  }, [report]);

  const maxDaily = useMemo(() => {
    const rows = report?.daily ?? [];
    return rows.reduce((max, row) => Math.max(max, row.totalTokens), 0);
  }, [report]);

  // 最近调用：服务端已按时间倒序返回（最多 50 条），这里只取最新 5 笔。
  // 它是实时流水，不受上方时间窗筛选影响——切到「24 小时」也照常显示刚发生的请求。
  const recentCalls = useMemo(() => (report?.recent ?? []).slice(0, RECENT_LIMIT), [report]);
  const recentTotal = report?.recent.length ?? 0;

  // 折叠态摘要：账户块与屏蔽池块各算一份，展开后表格仍用原始行数据。
  const accountDigest = useMemo(() => {
    const requests = accounts.reduce((sum, row) => sum + row.requests, 0);
    const tokens = accounts.reduce((sum, row) => sum + row.totalTokens, 0);
    const cost = accounts.reduce((sum, row) => sum + row.costUsd, 0);
    const active = accounts.filter((row) => row.status === "active").length;
    return { count: accounts.length, requests, tokens, cost, active, blocked: blocked.length };
  }, [accounts, blocked]);

  const blockedDigest = useMemo(() => {
    const quota = blocked.filter((row) => row.status === "blocked-quota").length;
    const suspect = blocked.filter((row) => row.status === "blocked-suspect").length;
    const wakeup = blocked.filter((row) => row.status === "wakeup").length;
    const tokens = blocked.reduce((sum, row) => sum + row.totalTokens, 0);
    const cost = blocked.reduce((sum, row) => sum + row.costUsd, 0);
    // Rows with no `recoverAt` are not waiting on a clock — only an operator can
    // clear them. Counting them separately keeps 「最近恢复」 from implying the
    // whole pool drains.
    const dormant = blocked.filter((row) => row.blocked !== undefined && !row.blocked.recoverAt).length;
    const nextRecover = blocked
      .map((row) => row.blocked?.recoverAt)
      .filter((iso): iso is string => Boolean(iso))
      .sort()[0];
    return { count: blocked.length, quota, suspect, wakeup, dormant, tokens, cost, nextRecover };
  }, [blocked]);

  async function handleRefreshPrices() {
    setBusy(true);
    setNotice("");
    try {
      const result = await refreshUsagePrices();
      setNotice(
        result.refreshed
          ? `价格已更新（${result.models} 个模型，来源 ${result.source ?? "unknown"}）`
          : "价格刷新失败，沿用上一份快照",
      );
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    if (!window.confirm("清空本地用量账本？该操作只影响统计，不影响上游账户额度。")) return;
    setBusy(true);
    try {
      await resetUsageLedger();
      setNotice("用量账本已清空");
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">用量统计</h2>
          <p className="text-xs text-muted-foreground">
            按账户统计额度消耗，OpenRouter 渠道优先采用上游实际计费，缺失时才按目录价格折算
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-border overflow-hidden">
            {WINDOWS.map((item) => (
              <button
                key={item.id}
                onClick={() => setRange(item.id)}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  range === item.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-secondary/50 disabled:opacity-50"
          >
            刷新
          </button>
          <button
            onClick={() => void handleRefreshPrices()}
            disabled={busy}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-secondary/50 disabled:opacity-50"
          >
            更新价格
          </button>
          <button
            onClick={() => void handleReset()}
            disabled={busy}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-red-400 hover:border-red-500/40 disabled:opacity-50"
          >
            清空
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          {notice}
        </div>
      ) : null}

      {!report && loading ? (
        <div className="py-16 text-center text-xs text-muted-foreground">加载中…</div>
      ) : null}

      {report ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Card
              label="请求数"
              value={fmtInt(report.totals.requests)}
              hint={`计入账本 ${fmtInt(report.coverage.measuredRequests)}`}
            />
            <Card label="输入 tokens" value={fmtCompact(report.totals.promptTokens)} />
            <Card label="输出 tokens" value={fmtCompact(report.totals.completionTokens)} />
            <Card
              label="花费"
              value={fmtCost(report.totals.costUsd)}
              hint={
                report.totals.upstreamCostRequests > 0
                  ? `上游实报 ${fmtInt(report.totals.upstreamCostRequests)} 笔${
                      report.totals.estimatedCostUsd > 0
                        ? ` · 目录价折算 ${fmtCost(report.totals.estimatedCostUsd)}`
                        : ""
                    }`
                  : `已定价 ${fmtInt(report.totals.pricedRequests)} / 未定价 ${fmtInt(report.totals.unpricedRequests)}`
              }
            />
            <Card
              label="账户"
              value={fmtInt(report.byAccount.length)}
              hint={`在池 ${fmtInt(report.pool.size)} · 屏蔽池 ${report.pool.blockedTotal}（额度403 ${report.pool.blockedQuota}）`}
            />
          </div>

          {/* Accounts */}
          <CollapsibleSection
            title="账户额度消耗"
            titleHint="请求按所属账户归档；在池账户已排在表格前列，额度 403 的账户会同时出现在屏蔽池"
            open={accountsOpen}
            onToggle={() => setAccountsOpen((open) => !open)}
            badges={
              <span
                className="inline-flex items-center rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400"
                title="当前反代池中可用于服务的上游节点数量"
              >
                在池 {fmtInt(report.pool.size)}
              </span>
            }
            summary={
              <>
                <span className="text-foreground/90">{fmtInt(accountDigest.count)} 个账户</span>
                {/* Fleet-level inventory (total / queued / managed accounts) is
                    not part of this build's report (`fleet` is always null), so
                    the summary row is derived from the account rows below. */}
                <span>在池 {fmtInt(accountDigest.active)}</span>
                <span>请求 {fmtInt(accountDigest.requests)}</span>
                <span>{fmtCompact(accountDigest.tokens)} tokens</span>
                <span>{fmtCost(accountDigest.cost)}</span>
                {accountDigest.blocked > 0 ? (
                  <span className="text-amber-400/90">屏蔽 {fmtInt(accountDigest.blocked)}</span>
                ) : null}
              </>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[11px] text-muted-foreground">
                  <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                    <th>状态</th>
                    <th>账户</th>
                    <th className="text-right">请求</th>
                    <th className="text-right">输入</th>
                    <th className="text-right">输出</th>
                    <th className="text-right">花费</th>
                    <th className="text-right">占比</th>
                    <th>最近使用</th>
                    <th>屏蔽信息</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                        该时间窗内还没有请求记账
                      </td>
                    </tr>
                  ) : (
                    accounts.map((row) => {
                      const status = STATUS_STYLES[row.status];
                      const blockedInfo = row.blocked;
                      return (
                        <tr key={row.key} className="border-t border-border/70 [&>td]:px-3 [&>td]:py-2">
                          <td>
                            <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] ${status.className}`}>
                              {status.label}
                            </span>
                          </td>
                          <td className="max-w-[220px] truncate font-medium text-foreground" title={row.account ?? row.key}>
                            {row.account ?? row.key}
                          </td>
                          <td className="text-right tabular-nums">{fmtInt(row.requests)}</td>
                          <td className="text-right tabular-nums">{fmtInt(row.promptTokens)}</td>
                          <td className="text-right tabular-nums">{fmtInt(row.completionTokens)}</td>
                          <td className="text-right tabular-nums">{fmtCost(row.costUsd)}</td>
                          <td className="text-right tabular-nums text-muted-foreground">{row.sharePct.toFixed(1)}%</td>
                          <td className="whitespace-nowrap text-muted-foreground">{fmtTime(row.lastUsedAt)}</td>
                          <td className="max-w-[260px] text-[11px] text-muted-foreground">
                            {blockedInfo ? (
                              <div className="space-y-0.5">
                                <div className="text-amber-400/90">
                                  {blockedInfo.upstreamReason ?? blockedInfo.disabledReason}
                                  {blockedInfo.upstreamStatus ? ` · HTTP ${blockedInfo.upstreamStatus}` : ""}
                                </div>
                                {blockedInfo.recoverAt ? (
                                  <div>恢复：{fmtDate(blockedInfo.recoverAt)}</div>
                                ) : null}
                                {blockedInfo.lastError ? (
                                  <div className="truncate" title={blockedInfo.lastError}>
                                    {blockedInfo.lastError}
                                  </div>
                                ) : null}
                              </div>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </CollapsibleSection>

          {/* Recent calls — newest 5 requests: model, model vendor, channel, account */}
          <section className="rounded-lg border border-border bg-card/40">
            <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
              <h3 className="text-xs font-semibold text-foreground">最近调用</h3>
              <span className="text-[11px] text-muted-foreground">
                最新 {RECENT_LIMIT} 笔请求：供应商是 OpenRouter 实际渠道商（响应里的 provider），渠道是本网关转发通道（按时间倒序；实时流水，不受上方时间窗影响）
              </span>
              <span
                className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                title="本网关账本里保留的最近请求条数；列表随后台 20 秒轮询刷新"
              >
                {recentTotal === 0 ? "无记录" : `可回溯 ${fmtInt(recentTotal)} 条`}
              </span>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[11px] text-muted-foreground">
                  <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                    <th>时间</th>
                    <th>模型</th>
                    <th>供应商</th>
                    <th>渠道</th>
                    <th>调用账户</th>
                    <th className="text-right">输入</th>
                    <th className="text-right">输出</th>
                    <th className="text-right">花费</th>
                  </tr>
                </thead>
                <tbody>
                  {recentCalls.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                        还没有调用记录（只统计上游回传了 usage 的请求）
                      </td>
                    </tr>
                  ) : (
                    recentCalls.map((call, index) => {
                      const account = recentAccount(call);
                      const channel = channelLabel(call.upstreamProvider);
                      return (
                        <tr
                          key={`${call.ts}-${call.provider}-${call.model}-${index}`}
                          className="border-t border-border/70 [&>td]:px-3 [&>td]:py-2"
                        >
                          <td className="whitespace-nowrap tabular-nums text-muted-foreground" title={fmtTime(call.ts)}>
                            {fmtClock(call.ts)}
                          </td>
                          <td className="max-w-[240px] truncate font-medium text-foreground" title={call.model}>
                            {call.model}
                          </td>
                          <td
                            className={`whitespace-nowrap ${channel.muted ? "text-muted-foreground" : "font-medium text-foreground"}`}
                            title={`${channel.hint}\n网关通道：${PROVIDER_LABELS[call.provider] ?? call.provider}`}
                          >
                            {channel.text}
                          </td>
                          <td
                            className="whitespace-nowrap text-muted-foreground"
                            title="本网关的转发通道（OpenRouter 池里恒为 OpenRouter）"
                          >
                            {PROVIDER_LABELS[call.provider] ?? call.provider}
                          </td>
                          <td
                            className={`max-w-[200px] truncate ${account.muted ? "text-muted-foreground" : "text-foreground"}`}
                            title={account.hint}
                          >
                            {account.text}
                          </td>
                          <td className="text-right tabular-nums">{fmtInt(call.promptTokens)}</td>
                          <td className="text-right tabular-nums">{fmtInt(call.completionTokens)}</td>
                          <td className="text-right tabular-nums">
                            {call.costUsd === null ? (
                              <span className="text-muted-foreground">未定价</span>
                            ) : (
                              fmtCost(call.costUsd)
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Models / OpenRouter pricing */}
          <section className="rounded-lg border border-border bg-card/40">
            <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
              <h3 className="text-xs font-semibold text-foreground">模型消耗与价格</h3>
              <span className="text-[11px] text-muted-foreground">
                供应商按 OpenRouter 返回的渠道商聚合（一个模型可能被多家渠道承接），单价来自公开目录快照
                {report.pricing.fetchedAt ? `（${fmtTime(report.pricing.fetchedAt)}，${report.pricing.models} 个模型）` : "（尚未获取）"}
              </span>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[11px] text-muted-foreground">
                  <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                    <th>模型</th>
                    <th>供应商</th>
                    <th>渠道</th>
                    <th className="text-right">输入 / 1M</th>
                    <th className="text-right">输出 / 1M</th>
                    <th className="text-right">请求</th>
                    <th className="text-right">输入 tokens</th>
                    <th className="text-right">输出 tokens</th>
                    <th className="text-right">花费</th>
                    <th className="text-right">占比</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byModel.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">
                        还没有模型用量
                      </td>
                    </tr>
                  ) : (
                    report.byModel.map((row) => {
                      const channels = channelSummary(row.channels ?? []);
                      return (
                        <tr
                          key={`${row.provider}:${row.model}`}
                          className="border-t border-border/70 [&>td]:px-3 [&>td]:py-2"
                        >
                          <td className="max-w-[240px] truncate font-medium text-foreground" title={row.model}>
                            {row.model}
                          </td>
                          <td
                            className={`max-w-[220px] truncate ${channels.extra === 0 && channels.text !== "未上报" ? "text-foreground" : "text-muted-foreground"}`}
                            title={channels.hint}
                          >
                            {channels.text}
                            {channels.extra > 0 ? (
                              <span className="ml-1 text-muted-foreground">+{channels.extra}</span>
                            ) : null}
                          </td>
                          <td className="whitespace-nowrap text-muted-foreground">
                            {PROVIDER_LABELS[row.provider] ?? row.provider}
                          </td>
                          <td className="text-right tabular-nums">{fmtPrice(row.promptPricePerM)}</td>
                          <td className="text-right tabular-nums">{fmtPrice(row.completionPricePerM)}</td>
                          <td className="text-right tabular-nums">{fmtInt(row.requests)}</td>
                          <td className="text-right tabular-nums">{fmtInt(row.promptTokens)}</td>
                          <td className="text-right tabular-nums">{fmtInt(row.completionTokens)}</td>
                          <td className="text-right tabular-nums">
                            {row.priced ? fmtCost(row.costUsd) : <span className="text-muted-foreground">未定价</span>}
                          </td>
                          <td className="text-right tabular-nums text-muted-foreground">{row.sharePct.toFixed(1)}%</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Blocked pool */}
          <CollapsibleSection
            title="屏蔽池"
            titleHint="额度 403 的节点按上游给出的重置日恢复（无配额快照时 31 天）；「疑似限流 · 5 分钟复核」只给上游 429 推断出来的额度信号，探针复核后回池；「待恢复」没有到期时间，需要在配置页重新探测或手动重新启用"
            open={blockedOpen}
            onToggle={() => setBlockedOpen((open) => !open)}
            badges={
              blockedDigest.count > 0 ? (
                <span className="inline-flex items-center rounded border border-red-500/20 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">
                  已屏蔽 {fmtInt(blockedDigest.count)}
                </span>
              ) : (
                <span className="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  空
                </span>
              )
            }
            summary={
              blockedDigest.count === 0 ? (
                <span>当前没有节点被屏蔽</span>
              ) : (
                <>
                  <span>额度 403 {fmtInt(blockedDigest.quota)}</span>
                  {blockedDigest.suspect > 0 ? <span>疑似限流 {fmtInt(blockedDigest.suspect)}</span> : null}
                  {blockedDigest.wakeup > 0 ? <span>待恢复 {fmtInt(blockedDigest.wakeup)}</span> : null}
                  {blockedDigest.dormant > 0 ? <span>无到期 {fmtInt(blockedDigest.dormant)}</span> : null}
                  <span>屏蔽前 {fmtCompact(blockedDigest.tokens)} tokens</span>
                  <span>{fmtCost(blockedDigest.cost)}</span>
                  {blockedDigest.nextRecover ? <span>最近恢复 {fmtDate(blockedDigest.nextRecover)}</span> : null}
                </>
              )
            }
          >
            <div className="divide-y divide-border/70">
              {blocked.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">屏蔽池为空</div>
              ) : (
                blocked.map((row) => {
                  const badge = row.blocked ? blockedBadge(row.blocked) : null;
                  return (
                  <div key={row.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-xs">
                    <span className="font-medium text-foreground">{row.account ?? row.key}</span>
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] ${badge?.className ?? ""}`}>
                      {badge?.label ?? row.blocked?.disabledReason}
                    </span>
                    <span className="text-muted-foreground">
                      屏蔽前消耗 {fmtInt(row.promptTokens + row.completionTokens)} tokens · {fmtCost(row.costUsd)}
                    </span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {row.blocked?.disabledAt ? `屏蔽于 ${fmtDate(row.blocked.disabledAt)}` : ""}
                      {row.blocked?.recoverAt ? (
                        ` · 恢复 ${fmtDate(row.blocked.recoverAt)}`
                      ) : row.blocked ? (
                        <span title="该行没有到期时间：不会自己消失，需要在配置页「检测已屏蔽节点」重新探测，或手动重新启用">
                          {" · 无到期时间"}
                        </span>
                      ) : (
                        ""
                      )}
                    </span>
                  </div>
                  );
                })
              )}
            </div>
          </CollapsibleSection>

          {/* Daily */}
          <section className="rounded-lg border border-border bg-card/40">
            <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <h3 className="text-xs font-semibold text-foreground">每日 token 消耗</h3>
            </header>
            <div className="px-4 py-3">
              {report.daily.length === 0 ? (
                <div className="py-4 text-center text-xs text-muted-foreground">暂无数据</div>
              ) : (
                <div className="space-y-1.5">
                  {report.daily.map((row) => (
                    <div key={row.date} className="flex items-center gap-3 text-[11px]">
                      <span className="w-20 shrink-0 text-muted-foreground">{row.date}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary/60">
                        <div
                          className="h-full rounded-full bg-primary/70"
                          style={{ width: `${maxDaily > 0 ? Math.max(2, (row.totalTokens / maxDaily) * 100) : 0}%` }}
                        />
                      </div>
                      <span className="w-16 shrink-0 text-right tabular-nums text-foreground">
                        {fmtCompact(row.totalTokens)}
                      </span>
                      <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
                        {fmtCost(row.costUsd)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <p className="text-[11px] leading-5 text-muted-foreground">
            记账说明：token 数来自上游返回的 usage；流式请求在最后一帧带上 usage 时同样计入，
            未上报的请求按次数统计在「未定价」里，不估算 token。
            价格来自 OpenRouter 公开模型目录，仅 OpenRouter 渠道折算成本，其他渠道只统计 token。
            统计只代表本网关看到的流量，不含账户在其他地方消耗的额度。
          </p>
        </>
      ) : null}
    </div>
  );
}
