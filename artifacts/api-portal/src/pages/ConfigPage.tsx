import { useEffect, useState } from "react";
import { fetchSetupStatus, type SetupStatus, type SegmentName } from "../lib/api";

const SEGMENT_LABEL: Record<SegmentName, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  openrouter: "OpenRouter",
};

function Badge({ ok, okText = "已配置", noText = "未设置" }: { ok: boolean; okText?: string; noText?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        ok ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
      }`}
    >
      <span className="size-1.5 rounded-full inline-block" style={{ background: ok ? "#4ade80" : "#f87171" }} />
      {ok ? okText : noText}
    </span>
  );
}

export default function StatusPage() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [err, setErr] = useState("");

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    fetchSetupStatus().then(setStatus).catch((e) => setErr(String(e)));
  }, []);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">节点状态</h2>
        <p className="text-sm text-muted-foreground">
          本节点是反向代理池中的一个上游成员，对外暴露{" "}
          <code className="bg-secondary/60 px-1 rounded">/modelfarm/&#123;openai,anthropic,google,openrouter&#125;</code>{" "}
          路径，并将请求透传到本机配置的 Replit AI 集成。
        </p>
      </div>

      {err && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {err}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h3 className="text-sm font-semibold text-foreground">节点基础地址</h3>
        <div className="flex items-center gap-2 rounded-md bg-secondary/50 px-3 py-2 font-mono text-sm text-foreground">
          {baseUrl}
        </div>
        <p className="text-xs text-muted-foreground">
          下游网关在配置代理池时，将此地址作为一条上游 URL 加入即可。
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h3 className="text-sm font-semibold text-foreground">访问认证</h3>
        {status ? (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">PROXY_API_KEY</span>
            <Badge ok={status.proxyKey} />
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">加载中…</div>
        )}
        <p className="text-xs text-muted-foreground">
          若设置了环境变量 <code className="bg-secondary/60 px-1 rounded">PROXY_API_KEY</code>，所有{" "}
          <code className="bg-secondary/60 px-1 rounded">/modelfarm/*</code> 请求都需通过{" "}
          <code className="bg-secondary/60 px-1 rounded">Authorization: Bearer …</code> 或{" "}
          <code className="bg-secondary/60 px-1 rounded">x-api-key: …</code> 携带该密钥；未设置时则节点开放访问。
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">上游通道状态</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            每条通道都依赖一对环境变量。任何一项缺失，对应的{" "}
            <code className="bg-secondary/60 px-1 rounded">/modelfarm/&lt;segment&gt;</code> 都会返回 503。
          </p>
        </div>
        {status ? (
          <div className="space-y-2">
            {status.segments.map((s) => (
              <div
                key={s.segment}
                className="rounded-md border border-border/60 bg-secondary/10 p-3 space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{SEGMENT_LABEL[s.segment]}</span>
                    <code className="text-[11px] text-muted-foreground bg-secondary/40 px-1.5 py-0.5 rounded">
                      /modelfarm/{s.segment}
                    </code>
                  </div>
                  <Badge ok={s.configured} okText="可用" noText="未配置" />
                </div>
                <div className="text-[11px] text-muted-foreground font-mono">
                  {s.baseUrlEnv} · {s.apiKeyEnv}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">加载中…</div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h3 className="text-sm font-semibold text-foreground">关于本节点</h3>
        <ul className="space-y-1.5 text-xs text-muted-foreground">
          <li>• 角色：反向代理池中的一个上游成员节点</li>
          <li>• 行为：透传请求到由 Replit AI 集成提供的实际后端</li>
          <li>• 不做任何模型路由、模型注册、请求改写或响应改写</li>
          <li>• 支持 SSE 流式响应；请求/响应字节按原样转发</li>
        </ul>
      </div>
    </div>
  );
}
