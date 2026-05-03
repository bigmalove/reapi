export default function DocsPage() {
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "<节点地址>";

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">接入文档</h2>
        <p className="text-sm text-muted-foreground">
          本节点是反向代理池的上游成员。下游网关把它作为代理池中的一条 URL，转发到对应的{" "}
          <code className="bg-secondary/60 px-1 rounded">/modelfarm/*</code> 路径即可。
        </p>
      </div>

      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h3 className="text-base font-semibold text-foreground">认证</h3>
        <p className="text-sm text-muted-foreground">
          若已设置 <code className="bg-secondary/60 px-1 rounded">PROXY_API_KEY</code>，所有{" "}
          <code className="bg-secondary/60 px-1 rounded">/modelfarm/*</code> 请求都需通过下列任一请求头携带该密钥：
        </p>
        <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
          {`Authorization: Bearer <PROXY_API_KEY>
x-api-key: <PROXY_API_KEY>`}
        </pre>
        <p className="text-xs text-muted-foreground">
          未设置该环境变量时节点开放访问。注意：节点会用本机的真实上游密钥替换该请求头后再转发。
        </p>
      </section>

      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h3 className="text-base font-semibold text-foreground">上游通道与转发规则</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground uppercase">外部路径</th>
                <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground uppercase">转发到</th>
                <th className="text-left py-2 text-xs font-medium text-muted-foreground uppercase">注入认证头</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[
                ["/modelfarm/openai/*", "AI_INTEGRATIONS_OPENAI_BASE_URL", "Authorization: Bearer …"],
                ["/modelfarm/anthropic/*", "AI_INTEGRATIONS_ANTHROPIC_BASE_URL", "x-api-key + anthropic-version"],
                ["/modelfarm/google/*", "AI_INTEGRATIONS_GEMINI_BASE_URL", "x-goog-api-key"],
                ["/modelfarm/openrouter/*", "AI_INTEGRATIONS_OPENROUTER_BASE_URL", "Authorization: Bearer …"],
              ].map(([path, target, auth]) => (
                <tr key={path}>
                  <td className="py-2 pr-4 font-mono text-xs text-foreground">{path}</td>
                  <td className="py-2 pr-4 font-mono text-[11px] text-muted-foreground">{target}</td>
                  <td className="py-2 text-xs text-muted-foreground">{auth}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          请求方法、查询字符串、请求体（原始字节）与流式响应均按原样转发。
        </p>
      </section>

      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h3 className="text-base font-semibold text-foreground">在下游网关中加入本节点</h3>
        <p className="text-sm text-muted-foreground">
          在下游网关的"反向代理池"中新增一条上游：
        </p>
        <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
          {`URL:    ${baseUrl}
API Key: <本节点的 PROXY_API_KEY，留空则不认证>`}
        </pre>
        <p className="text-xs text-muted-foreground">
          下游会把请求转发到形如{" "}
          <code className="bg-secondary/60 px-1 rounded">{baseUrl}/modelfarm/openai/chat/completions</code>{" "}
          的地址。
        </p>
      </section>

      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h3 className="text-base font-semibold text-foreground">直接调用示例</h3>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">OpenAI 兼容</p>
          <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
            {`curl ${baseUrl}/modelfarm/openai/chat/completions \\
  -H "Authorization: Bearer <PROXY_API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4.1-mini",
    "messages": [{"role":"user","content":"你好"}]
  }'`}
          </pre>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Anthropic 原生</p>
          <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
            {`curl ${baseUrl}/modelfarm/anthropic/v1/messages \\
  -H "x-api-key: <PROXY_API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "messages": [{"role":"user","content":"你好"}]
  }'`}
          </pre>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h3 className="text-base font-semibold text-foreground">管理接口</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground uppercase">方法</th>
                <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground uppercase">路径</th>
                <th className="text-left py-2 text-xs font-medium text-muted-foreground uppercase">说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[
                ["GET", "/api/healthz", "健康检查"],
                ["GET", "/api/setup-status", "节点角色与各通道环境变量配置状态"],
                ["ANY", "/modelfarm/<segment>/<path>", "透传到对应上游"],
              ].map(([method, path, desc]) => (
                <tr key={path}>
                  <td className="py-2 pr-4">
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-xs font-mono font-bold ${
                        method === "GET"
                          ? "bg-blue-500/10 text-blue-400"
                          : "bg-zinc-500/15 text-zinc-300"
                      }`}
                    >
                      {method}
                    </span>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-foreground">{path}</td>
                  <td className="py-2 text-xs text-muted-foreground">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
