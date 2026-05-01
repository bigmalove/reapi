export default function DocsPage() {
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "<your-gateway-url>";

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">API Documentation</h2>
        <p className="text-sm text-muted-foreground">
          All endpoints follow the OpenAI API specification and are fully compatible with OpenAI-compatible clients.
        </p>
      </div>

      {/* Authentication */}
      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h3 className="text-base font-semibold text-foreground">Authentication</h3>
        <p className="text-sm text-muted-foreground">
          If <code className="bg-secondary/60 px-1 rounded">PROXY_API_KEY</code> is set, all{" "}
          <code className="bg-secondary/60 px-1 rounded">/v1/*</code> requests require authentication.
        </p>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Bearer token (recommended)</p>
          <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
            {`Authorization: Bearer <PROXY_API_KEY>`}
          </pre>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">API Key header</p>
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
          Returns the list of currently enabled models. Disabled models are excluded.
        </p>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Example</p>
          <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
            {`curl ${baseUrl}/v1/models \\
  -H "Authorization: Bearer <key>"`}
          </pre>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Response</p>
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
          Core gateway endpoint. Accepts OpenAI-compatible requests and routes to the correct provider automatically.
          Supports streaming SSE and tool calls.
        </p>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Model routing</p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[
              ["gpt-*", "OpenAI"],
              ["o1-*, o3-*, o4-*", "OpenAI"],
              ["claude-*", "Anthropic"],
              ["gemini-*", "Google Gemini"],
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
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Non-streaming example</p>
          <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
            {`curl ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer <key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4.1-mini",
    "messages": [
      { "role": "user", "content": "Hello!" }
    ]
  }'`}
          </pre>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Streaming SSE example</p>
          <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
            {`curl ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer <key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [
      { "role": "user", "content": "Tell me a story" }
    ],
    "stream": true
  }'`}
          </pre>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tool calling example</p>
          <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
            {`curl ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer <key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4.1-mini",
    "messages": [
      { "role": "user", "content": "What is the weather in Tokyo?" }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get current weather",
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
        <h3 className="text-base font-semibold text-foreground">Using the OpenAI Python SDK</h3>
        <pre className="rounded-md bg-secondary/40 p-3 text-xs text-foreground overflow-x-auto">
          {`from openai import OpenAI

client = OpenAI(
    api_key="<PROXY_API_KEY>",
    base_url="${baseUrl}/v1"
)

# Works with any supported model
response = client.chat.completions.create(
    model="gemini-2.0-flash",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="claude-3-5-sonnet-20241022",
    messages=[{"role": "user", "content": "Tell me a story"}],
    stream=True
)
for chunk in stream:
    print(chunk.choices[0].delta.content, end="")`}
        </pre>
      </section>

      {/* Endpoints table */}
      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h3 className="text-base font-semibold text-foreground">All Endpoints</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground uppercase">Method</th>
                <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground uppercase">Path</th>
                <th className="text-left py-2 text-xs font-medium text-muted-foreground uppercase">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[
                ["GET", "/healthz", "Health check"],
                ["GET", "/api/setup-status", "Provider configuration status"],
                ["GET", "/api/settings", "Get gateway settings"],
                ["POST", "/api/settings", "Update gateway settings"],
                ["GET", "/v1/models", "List enabled models"],
                ["POST", "/v1/chat/completions", "Chat completion (core endpoint)"],
                ["GET", "/v1/admin/models", "List all models with status"],
                ["PATCH", "/v1/admin/models", "Enable/disable models"],
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
