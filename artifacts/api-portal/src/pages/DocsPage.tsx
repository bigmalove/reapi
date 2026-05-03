export default function DocsPage() {
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "<your-gateway-url>";

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">API 文档</h2>
        <p className="text-sm text-muted-foreground">
          所有接口均遵循 OpenAI API 规范,完全兼容 OpenAI 客户端。
        </p>
      </div>

      {/* Authentication */}
      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h3 className="text-base font-semibold text-foreground">身份认证</h3>
        <p className="text-sm text-muted-foreground">
          若已设置 <code className="bg-secondary/60 px-1 rounded">PROXY_API_KEY</code>,则所有{" "}
          <code className="bg-secondary/60 px-1 rounded">/v1/*</code> 请求都需要进行身份认证。
        </p>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Bearer 令牌(推荐)</p>
          <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
            {`Authorization: Bearer <PROXY_API_KEY>`}
          </pre>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">API Key 请求头</p>
          <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
            {`x-api-key: <PROXY_API_KEY>`}
          </pre>
        </div>
      </section>

      {/* GET /v1/models */}
      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-3">
          <span className="rounded px-2 py-0.5 text-xs font-mono font-bold bg-blue-500/10 text-blue-400">GET</span>
          <code className="text-sm font-mono text-foreground">/v1/models</code>
        </div>
        <p className="text-sm text-muted-foreground">
          返回当前已启用的模型列表,已禁用的模型不会出现在结果中。
        </p>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">示例</p>
          <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
            {`curl ${baseUrl}/v1/models \\
  -H "Authorization: Bearer <key>"`}
          </pre>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">响应</p>
          <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
            {`{
  "object": "list",
  "data": [
    {
      "id": "gpt-4.1-mini",
      "object": "model",
      "created": 1706745600,
      "owned_by": "openai"
    }
  ]
}`}
          </pre>
        </div>
      </section>

      {/* POST /v1/chat/completions */}
      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-3">
          <span className="rounded px-2 py-0.5 text-xs font-mono font-bold bg-green-500/10 text-green-400">POST</span>
          <code className="text-sm font-mono text-foreground">/v1/chat/completions</code>
        </div>
        <p className="text-sm text-muted-foreground">
          网关核心接口。接收兼容 OpenAI 的请求,并自动路由到对应的服务提供商,支持 SSE 流式响应与工具调用。
        </p>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">模型路由规则</p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[
              ["gpt-*", "OpenAI"],
              ["o1-*, o3-*, o4-*", "OpenAI"],
              ["claude-*", "Anthropic"],
              ["gemini-*", "谷歌 Gemini"],
              ["provider/model", "OpenRouter"],
            ].map(([pattern, provider]) => (
              <div key={pattern} className="flex items-center justify-between rounded border border-border bg-secondary/20 px-2.5 py-1.5">
                <code className="text-foreground">{pattern}</code>
                <span className="text-muted-foreground">{provider}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">非流式调用示例</p>
          <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
            {`curl ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer <key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4.1-mini",
    "messages": [
      { "role": "user", "content": "你好!" }
    ]
  }'`}
          </pre>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">SSE 流式调用示例</p>
          <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
            {`curl ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer <key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [
      { "role": "user", "content": "给我讲个故事" }
    ],
    "stream": true
  }'`}
          </pre>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">工具调用示例</p>
          <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
            {`curl ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer <key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4.1-mini",
    "messages": [
      { "role": "user", "content": "东京现在的天气怎么样?" }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "获取当前天气",
          "parameters": {
            "type": "object",
            "properties": {
              "location": { "type": "string" }
            },
            "required": ["location"]
          }
        }
      }
    ]
  }'`}
          </pre>
        </div>
      </section>

      {/* OpenAI Client SDK */}
      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h3 className="text-base font-semibold text-foreground">使用 OpenAI Python SDK</h3>
        <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
          {`from openai import OpenAI

client = OpenAI(
    api_key="<PROXY_API_KEY>",
    base_url="${baseUrl}/v1"
)

# 适用于所有受支持的模型
response = client.chat.completions.create(
    model="gemini-2.0-flash",
    messages=[{"role": "user", "content": "你好!"}]
)
print(response.choices[0].message.content)

# 流式输出
stream = client.chat.completions.create(
    model="claude-3-5-sonnet-20241022",
    messages=[{"role": "user", "content": "给我讲个故事"}],
    stream=True
)
for chunk in stream:
    print(chunk.choices[0].delta.content, end="")`}
        </pre>
      </section>

      {/* Endpoints table */}
      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h3 className="text-base font-semibold text-foreground">全部接口</h3>
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
                ["GET", "/healthz", "健康检查"],
                ["GET", "/api/setup-status", "服务提供商配置状态"],
                ["GET", "/api/settings", "获取网关设置"],
                ["POST", "/api/settings", "更新网关设置"],
                ["GET", "/v1/models", "列出已启用的模型"],
                ["POST", "/v1/chat/completions", "对话补全(核心接口)"],
                ["GET", "/v1/admin/models", "列出全部模型及其状态"],
                ["PATCH", "/v1/admin/models", "启用/禁用模型"],
              ].map(([method, path, desc]) => (
                <tr key={path + method}>
                  <td className="py-2 pr-4">
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-xs font-mono font-bold ${
                        method === "GET"
                          ? "bg-blue-500/10 text-blue-400"
                          : method === "POST"
                          ? "bg-green-500/10 text-green-400"
                          : "bg-yellow-500/10 text-yellow-400"
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
