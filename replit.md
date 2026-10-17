# AI Gateway

## Overview

A single-instance AI gateway deployed on Replit that unifies OpenAI, Anthropic, Google Gemini, and OpenRouter behind a single OpenAI-compatible API interface. Uses Replit AI Integrations for all model calls — no user API keys required.

## Architecture

Two artifacts in a pnpm monorepo:

- **`artifacts/api-server`** — Express + TypeScript backend gateway (serves at `/api` and `/v1`)
- **`artifacts/api-portal`** — React + Vite admin portal frontend (serves at `/`)

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **API framework**: Express 5
- **Frontend**: React + Vite + TypeScript + Tailwind CSS v4
- **Build**: esbuild (ESM bundle)
- **AI**: Replit AI Integrations (OpenAI, Anthropic, Gemini, OpenRouter)
- **Database**: PostgreSQL 16 (Replit managed, via `pg` driver)

## Key Commands

- `pnpm --filter @workspace/api-server run dev` — run API server
- `pnpm --filter @workspace/api-portal run dev` — run admin portal
- `pnpm --filter @workspace/api-server run build` — build API server

## API Server Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /healthz | Health check |
| GET | /api/setup-status | Provider config status |
| GET | /api/settings | Get gateway settings |
| POST | /api/settings | Update gateway settings |
| POST | /api/upstream-nodes/register | Register an upstream node |
| POST | /api/upstream-nodes/re-enable | Re-enable a disabled upstream node |
| GET | /v1/models | List enabled models (OpenAI compatible) |
| POST | /v1/chat/completions | Chat completion (core endpoint) |
| POST | /v1/messages | Anthropic Messages API (Claude Code entry point) |
| POST | /v1/messages/count_tokens | Anthropic token counting (proxied / estimated) |
| GET | /v1/admin/claude-code/models | Model ids Claude Code recently sent + how they resolved |
| GET | /v1/admin/models | List all models with status (`custom: true` = operator-added) |
| PATCH | /v1/admin/models | Enable/disable models |
| GET | /v1/admin/openrouter/models | Remote OpenRouter catalog (`?refresh=1` bypasses cache) |
| POST | /v1/admin/models | Add models to the registry (`{ids: []}` or `{models: [{id, created}]}`) |
| DELETE | /v1/admin/models | Remove an operator-added model (`{id}`) |

## Environment Variables (Replit AI Integrations — auto-provisioned)

- `AI_INTEGRATIONS_OPENAI_BASE_URL` + `AI_INTEGRATIONS_OPENAI_API_KEY`
- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` + `AI_INTEGRATIONS_ANTHROPIC_API_KEY`
- `AI_INTEGRATIONS_GEMINI_BASE_URL` + `AI_INTEGRATIONS_GEMINI_API_KEY`
- `AI_INTEGRATIONS_OPENROUTER_BASE_URL` + `AI_INTEGRATIONS_OPENROUTER_API_KEY`

Optional:
- `PROXY_API_KEY` — gateway auth key (if set, required for all /v1/* requests)

Database (auto-provisioned by Replit PostgreSQL 16):
- `DATABASE_URL` — full connection string
- `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`

## Model Routing

- `gpt-*`, `o1-*`, `o3-*`, `o4-*` → OpenAI (via Replit AI Integrations, backed by Azure)
- `claude-*` → Anthropic (via Replit AI Integrations)
- `gemini-*` → Google Gemini (via Replit AI Integrations)
- `provider/model` format (e.g. `meta-llama/llama-3.3-70b-instruct`) → OpenRouter (via Replit AI Integrations)

### Reasoning models / thinking levels

OpenAI reasoning models (`gpt-5.5`, `o*`, and OpenRouter `openai/gpt-5.5*`) accept thinking-level suffixes that map to `reasoning_effort`:
- `-thinking-low` → `low`
- `-thinking-medium` → `medium`
- `-thinking-high` → `high`
- `-thinking-xhigh` → `xhigh` (OpenAI's true highest)
- `-thinking-max` → `xhigh` (alias for highest)

Provider also strips unsupported params (`temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `logprobs`, `top_logprobs`) and converts `max_tokens` → `max_completion_tokens` for reasoning models.

Claude adaptive-thinking families (`claude-opus-5`, `claude-opus-4-7`/`4.8`, `claude-fable-5`, `claude-sonnet-5`, and via OpenRouter also `anthropic/claude-fable-latest`) are matched by **family prefix**, so point releases and dated ids (`claude-fable-5.1`, `anthropic/claude-fable-5.1`, `claude-opus-4-7-20250514`) are covered automatically — including `anthropic/*` ids added at runtime from the OpenRouter catalog. The same `-thinking-{level}` suffix works on them (e.g. `anthropic/claude-fable-5.1-thinking-low`). On the direct Anthropic path it is sent as `thinking: {type: "adaptive"}` + `output_config.effort`. On the OpenRouter path it is sent as OpenRouter's unified `reasoning: {effort}` (legacy models: `reasoning: {max_tokens}`), because OpenRouter's Chat Completions endpoint ignores Anthropic-native `thinking`/`output_config` and would leave the model at its default effort. `temperature`/`top_p`/`top_k` are stripped because these models reject them. Note the gateway only reads the thinking level from the model-name suffix, not from a body-level `reasoning_effort`.

Other OpenRouter models (Qwen, GLM, Kimi, Grok, Gemini, … including ids added at runtime from the catalog) also accept the `-thinking-{level}` suffix; the gateway sends it as OpenRouter's unified `reasoning: {effort}` with the level passed through unchanged (bare `-thinking` → `high`); OpenRouter maps a level the model lacks to its nearest supported one, so `-thinking-max` reaches `moonshotai/kimi-k3` (max/high/low) as `max` and lands on `xhigh` for `qwen/qwen3.8-max-0902`. It used to send an Anthropic-style `reasoning: {max_tokens}` budget, which effort-only models such as `qwen/qwen3.8-max-0902` ignore, leaving them at their catalog default (`xhigh`, reasoning mandatory) — that is why `-thinking-low` had no visible effect there. Only pre-adaptive Claude families still get the `reasoning: {max_tokens}` budget. A model whose OpenRouter descriptor marks reasoning `mandatory` cannot be switched off by the gateway: the bare id runs at the provider default, so pick `-thinking-low` to shorten it.

### OpenRouter provider pinning

The Replit AI Integration proxy passes through the `provider` field for some sources but strips it for others:
- ✅ Works: `OpenAI`, `amazon-bedrock` (US-based providers)
- ❌ Stripped: `deepseek` (CN-based provider) — DeepSeek V4 entries fall back to OpenRouter's auto-routing (Novita / GMICloud / Together / etc.)

`openai/gpt-5.5*` entries are pinned to OpenAI (not Azure) via `provider.order: ["OpenAI"]`.

Default model: `gpt-4.1-mini`

### Adding OpenRouter models at runtime

`artifacts/api-server/src/lib/models.ts` holds a hard-coded `MODEL_REGISTRY`, plus an
operator-managed list persisted under the `custom_models.json` kv key. The effective
registry is `MODEL_REGISTRY + custom models` (`getModelRegistry()`).

The admin portal → Model Management → "添加 OpenRouter 模型" panel pulls the live
catalog and lets the operator pick which models to add:

- `artifacts/api-server/src/lib/openrouterCatalog.ts` fetches `https://openrouter.ai/api/v1/models`
  (public, no key), cached 5 minutes, shared across concurrent callers. If that host is
  unreachable it falls back to `<configured openrouter baseUrl>/models`; if both fail a
  stale cache is served rather than an error. The response reports which `source` was used.
- Added models are stored with `provider: "openrouter"` and are deletable from the portal.
  Built-in models can only be disabled, never deleted (DELETE returns 404 for them, unless
  `thinking_variants: true` finds operator-added variants to remove — see below).
- Adding an id clears it from `disabled_models.json`, so a freshly added model shows up on
  `/v1/models` immediately.
- Cap: `MAX_CUSTOM_MODELS` (2000) total, 500 base ids per POST.
- `thinking_variants: true` on POST (request-level, or per `models[]` item) also registers
  `<id>-thinking` and `<id>-thinking-{low,medium,high,xhigh,max}` right after each base id,
  mirroring the built-in Claude entries, so clients that pick models from `/v1/models` can
  choose a thinking level without typing the suffix. The portal exposes this as the
  「同时添加思考变种」checkbox. DELETE accepts the same flag to remove a base id together
  with its operator-added variants (the portal does this automatically when variants exist).
- The base id may be a built-in OpenRouter model (e.g. `moonshotai/kimi-k3`, which ships
  without variants): POST skips the base as `builtin` and stores only the six variants as
  custom entries; DELETE with the flag removes just those variants and keeps the base. The
  portal's model list shows「添加思考变种」on built-in OpenRouter models that have no
  variants yet and「删除思考变种」once they do. The catalog panel can't be used for this
  because it marks built-in ids as「已在列表」.

## Claude Code Compatibility

Claude Code speaks the Anthropic Messages API, not OpenAI's. `POST /v1/messages`
(+ `POST /v1/messages/count_tokens`) makes the gateway usable as its
`ANTHROPIC_BASE_URL`. Implemented in `artifacts/api-server/src/routes/v1/messages.ts`,
`src/lib/anthropicInbound.ts` and `src/lib/claudeCode.ts`.

**Two paths**

- **Native passthrough** (`provider === "anthropic"`): the body is forwarded to
  `<anthropic baseUrl>/v1/messages` almost untouched, so `thinking` blocks,
  `cache_control` breakpoints, `tool_use` ids and `system` block arrays survive
  the round trip. SSE is relayed verbatim; only `message_start.message.model` is
  rewritten to the id the client asked for. Upstream 4xx errors are relayed with
  their original status and Anthropic error envelope (so Claude Code can show
  the real message); 429/5xx are treated as node faults and retried on another
  pool entry (6 attempts, same policy as `/v1/chat/completions`).
- **Conversion path** (openai / gemini / openrouter): the request is converted to
  the gateway's OpenAI shape (`anthropicToOpenAIRequest`) and the reply is
  re-encoded as Anthropic messages/SSE (`message_start` →
  `content_block_start|delta|stop` → `message_delta` → `message_stop`). Tool
  calls become `tool_use` blocks with `input_json_delta`; `tool_choice`
  `auto|any|tool` maps to `auto|required|{function}`. Thinking blocks and
  `cache_control` cannot be represented in this format and are dropped.

**Model id resolution** (`resolveClaudeCodeModel`). Claude Code sends ids that
are not in `MODEL_REGISTRY`, so they are normalised in this order (operator
mapping first):

| Input | Registry id |
|-------|-------------|
| *(operator mapping hit)* | whatever the mapping says (any provider) |
| `claude-sonnet-4-5-20250929` | `claude-sonnet-4-5` (date dropped) |
| `claude-sonnet-4-5-20250929[1m]` | `claude-sonnet-4-5` (`[1m]` 1M-context marker dropped) |
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | `claude-sonnet-4-5` (Bedrock/Vertex prefix) |
| `claude-sonnet-4.5` | `claude-sonnet-4-5` (`4.5` == `4-5`) |
| `claude-3-5-haiku-20241022` | `claude-haiku-4-5` (retired version → newest *enabled* of family) |
| `claude-*-fast` / `-1m` / `-latest` | same model without the serving marker |
| `claude-*-thinking[-level]` | base model + thinking enabled at that level |

The family fallback (newest **enabled** `claude-<opus|sonnet|haiku>-*` in the
registry) is what keeps retired ids such as `claude-3-5-sonnet-20241022`
working; it is reported in the request log as `match: "family"`. Unknown ids
return `404 not_found_error` unless a `*` fallback is configured.

### Model mapping (admin portal → Configuration)

`server_settings.json` → `claudeCodeModelMap` is a `{clientModelId: gatewayModelId}`
map applied **before** every heuristic, so an operator can pin an id Claude Code
sends (`claude-haiku-5-5`, a retired snapshot, a plugin's own alias) to any
gateway model — including another provider (`gpt-5.5`, `gemini-3.1-pro-preview`).
Managed in the portal's「Claude Code 模型映射」card, or via API:

```bash
# whole-map replacement; {} clears it
curl -X POST $GW/api/settings -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"claudeCodeModelMap":{"claude-haiku-5-5":"claude-haiku-4-5","*":"claude-sonnet-4-5"}}'
```

- Keys are matched exactly, case-insensitively, and date/version/`[1m]`
  insensitively — one row for `claude-sonnet-4-5` also covers
  `claude-sonnet-4-5-20250929[1m]`.
- `"*"` is the wildcard fallback: used when the id resolves to nothing, or to a
  model that is disabled. Explicit mappings and exact ids always win, so the
  wildcard cannot shadow them. This is what keeps an agent asking for
  `claude-haiku-5-5` working on a gateway where every Claude model is disabled.
- A mapping that points at a disabled model fails with an actionable message
  (`model X is mapped to Y, which is disabled…`) instead of a bare 400.
- Cap: 200 entries; keys/values are trimmed and length-capped server-side.
- `GET /v1/admin/claude-code/models` lists the ids Claude Code has actually
  sent recently (in-memory, 50 entries) with the id each resolved to, the match
  kind, request count and whether the target is disabled — the portal renders
  it under the mapping editor with one-click「加映射」.

**Anthropic beta flags.** Claude Code sends `anthropic-beta` values meant for
its own first-party OAuth session: `oauth-2025-04-20` and `claude-code-*`. A
plain `x-api-key` upstream rejects those, so they are stripped before the
request leaves the gateway. Real API betas (`interleaved-thinking-*`,
`fine-grained-tool-streaming-*`, `context-1m-*`, `prompt-caching-*`, …) pass
through. Extra betas can be stripped with a comma-separated
`CLAUDE_CODE_STRIP_BETAS` env var (prefix match on the beta name), for upstreams
that reject a beta they do not implement.

**Thinking translation.** Claude Code still sends the legacy
`thinking: {type:"enabled", budget_tokens}` shape. For adaptive families
(opus 4.6+, opus 5, sonnet 5, fable 5) it is translated to
`thinking: {type:"adaptive", display:"summarized"}` + `output_config.effort`
derived from the budget, and sampling params are dropped because those models
reject them. The reverse happens when an adaptive block is sent to a legacy
model. `max_tokens` is raised above the budget when needed. On the conversion
path a thinking request upgrades the routed model to its `-thinking-<level>`
registry variant so reasoning models receive the effort.

**Unsupported body fields are stripped automatically.** Anthropic gates
`context_management`, `container`, `mcp_servers`, `service_tier` (and whatever
Claude Code adds next) behind betas, and an endpoint that does not implement one
rejects the entire request with `"<field>: Extra inputs are not permitted"` —
which is what Replit's modelfarm proxy answers when Claude Code sends
`context_management` on every request. Instead of keeping a blacklist that goes
stale, the gateway reads the offending field name out of the 400, deletes it,
and retries (up to 4 fields). What was learned is remembered per upstream URL,
so only the first request after a restart pays the extra round trip. Fields in
`CORE_NATIVE_FIELDS` (`model`, `messages`, `system`, `max_tokens`, `stream`) are
never dropped — an error naming one of those is relayed to the client.

**count_tokens.** Proxied to `<anthropic baseUrl>/v1/messages/count_tokens` when
the model is served by Anthropic (8s timeout). Any other provider — or an
upstream without that route — gets a local estimate (`estimateAnthropicInputTokens`:
ASCII ≈ 4 chars/token, CJK ≈ 1.5 chars/token, 1600 tokens per image, plus tool
and message overhead). It never fails; Claude Code uses it for context
accounting only.

**Other details.** Auth accepts both `x-api-key` and `Authorization: Bearer`
(the latter is what `ANTHROPIC_AUTH_TOKEN` sends); failures use the Anthropic
`{type:"error", error:{type, message}}` envelope. `/v1/messages` gets a 32 MB
JSON limit (Claude Code inlines files and screenshots) while the rest of the
gateway stays at 10 MB. If an upstream answers a streaming request with a
complete JSON message, it is re-encoded as a well-formed SSE sequence. A 200
response that closes without a single event is treated as an empty upstream
stream: the node is cooled down and the next attempt uses another pool entry.

**Setup**

```bash
export ANTHROPIC_BASE_URL=https://<gateway-host>      # no /v1 suffix
export ANTHROPIC_AUTH_TOKEN=<PROXY_API_KEY>
export ANTHROPIC_MODEL=claude-sonnet-4-5
export ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5
claude
```

Equivalent `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://<gateway-host>",
    "ANTHROPIC_AUTH_TOKEN": "<PROXY_API_KEY>",
    "ANTHROPIC_MODEL": "claude-sonnet-4-5",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5"
  }
}
```

## Reverse-Proxy Forwarding Mode

The gateway can forward all 4 providers to a **pool** of one or more remote upstream gateways instead of using this Repl's local Replit AI Integration keys. Configure in admin portal → Configuration → "Upstream Reverse Proxy Pool".

When enabled, requests are routed to:
- `<upstream>/modelfarm/openai/chat/completions` (Authorization: Bearer)
- `<upstream>/modelfarm/anthropic/v1/messages` (x-api-key)
- `<upstream>/modelfarm/google/<model>:generateContent` (x-goog-api-key)
- `<upstream>/modelfarm/openrouter/chat/completions` (Authorization: Bearer)

Note `gemini` provider maps to upstream segment `google`.

**Pool & mode**:
- The pool is an ordered list of `{url, apiKey}` entries.
- `reverseProxyMode = "sticky"` — every request uses pool[0].
- `reverseProxyMode = "round-robin"` — sequential requests rotate across the pool (process-local cursor; not persisted; not shared across processes).
- Per-entry `apiKey` falls back to `pool[0].apiKey` when blank.
- Per-provider overrides take precedence over the pool (single URL each).
- Switching modes/pool is instant (no restart). Implemented in `artifacts/api-server/src/lib/providerEndpoint.ts`.
- Each pool pick is logged at `info` level (`reverse-proxy pool pick` with `provider`, `mode`, `upstreamIndex`, `poolSize`, `url`). The portal's pool-status pill also shows the next round-robin index live.

**Dev nodes are always disabled**: any `.replit.dev` URL put into the pool (portal save, import, copy-from, or already persisted) is moved into `disabledUpstreamNodes` as `requires-wakeup` by `updateSettings()` / `initSettings()` (`divertDevNodes()` in `settings.ts`). They cannot be re-enabled manually and both status checks skip them; the portal lists them all under「需要唤醒 (Dev 节点)」.

**Node status check**: the portal's「检测节点状态」button calls `POST /api/upstream-nodes/check` (auth required), which GETs `<node>/healthz` for every pool entry (10s timeout, 8 at a time; see `artifacts/api-server/src/lib/nodeProbe.ts`). A node counts as offline only on a connection error/timeout, a Replit page served in place of a stopped node (the `.replit.app` hosting placeholder, or the `.replit.dev` "Run this app to see the results here." page — both arrive as 404; see `detectReplitNotRunning()` in `upstreamNodeFailure.ts`, which real requests use too), or a 502/503/504; offline nodes are disabled with `upstreamReason` `probe-offline` (or `replit-hosting-shutdown`) and come back on their next self-registration or via「重新启用」. The probe uses no model quota, so it cannot detect budget-exhausted nodes — those are still caught by real requests.

**AI availability check**: the portal's「检测 AI 可用性」button calls `POST /api/upstream-nodes/check-ai` (auth required), which sends a real 1-token message (`claude-haiku-4-5`, `max_tokens: 1`, 30s timeout) to `<node>/modelfarm/anthropic/v1/messages` on every pool entry, using each entry's own key and falling back to pool[0]'s. Every node is classified as `ok`, `credential` (500 with an empty body — no AI credential until republished, disabled permanently), `server-error-with-body` (500 that carries a provider error — credential works, cooled down and rotated to the tail), `quota` (403 with a budget body such as `FREE_TIER_BUDGET_EXCEEDED` — disabled for 31 days, the monthly reset), `forbidden` (403 with a non-quota body — disabled with no recovery window, the same rule real requests apply in `upstreamNodeFailure.ts`), `unreachable` (no HTTP response) or `error`. Only `unreachable` and `error` are left untouched.

An **empty-body 403 is never a verdict**: it is re-probed once, and the retry's body decides — which is how a node that was restarting during the first probe still lands on `quota` and shows「免费额度耗尽」with its monthly window. If both probes come back empty the node is cooled down and left in the pool, landing in `error`; there is deliberately no separate bucket for "403 with no body", because that would describe our uncertainty rather than the node. On boot, `lib/disabledNodeRecheck.ts` re-probes entries recorded as `forbidden` (or with an "empty response body" error) so old mislabelled blocks heal themselves without waiting for a manual 检测并恢复 — up to 25 entries, 4 at a time, never awaited.

The portal renders both the summary bar and the per-kind detail blocks from a single `kinds` table, and prints a 合计 line whenever the counts don't add up to `summary.total` — a hand-written bar silently dropped a whole kind twice when the server grew a new one.

**Build stamp**: `GET /api/build-info` (public) returns `{ commit, builtAt }`, injected by `artifacts/api-server/build.mjs` via esbuild `define` from `git rev-parse --short HEAD`. The portal shows it as「服务端构建 xxxxxxx」next to the pool status and in the AI check header. Because the deployment is a bundle, this is the only way to tell a stale dist (no route, old behaviour) from a stale portal.

**Disabled-node recovery check**: the blocked-nodes panel's「检测并恢复」button calls `POST /api/upstream-nodes/check-disabled` (auth required). It sends a real 1-token message (`claude-haiku-4-5`, `max_tokens: 1`, 30s timeout) to `<node>/modelfarm/anthropic/v1/messages` on every disabled non-Dev node, using pool[0]'s key (which restored nodes inherit). Nodes that return a valid message are moved back into the pool via `restoreDisabledNodes()`; the rest stay disabled. This costs a tiny amount of quota per node but does catch budget-exhausted nodes.

**Key preservation**: Pool POST is atomic-replace, but a row resubmitted with the *same* URL and blank `apiKey` keeps its previously stored key. Changing a row's URL drops the prior key — the new URL needs an explicit key.

**Legacy compat**: PATCH `/api/settings` still accepts the old scalar `reverseProxyUrl`/`reverseProxyApiKey` and maps them onto pool[0]. Override-only legacy configs (no global URL but a global key) get the legacy key applied to every override URL that lacks its own key. GET responses expose only the new pool shape.

## Persistence

PostgreSQL 16 (Replit managed). All data is stored in a single `kv_store` table:

```sql
CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

Keys stored:
- `server_settings.json` — gateway settings (sillyTavernMode, reverseProxyEnabled, reverseProxyMode, reverseProxyPool[], disabledUpstreamNodes[], providerOverrides)
- `disabled_models.json` — list of disabled model IDs
- `custom_models.json` — operator-added models (`{id, provider, created}`), e.g. pulled from OpenRouter

On startup, `initSettings()` and `initModels()` load from the database into an in-memory cache. All writes go to the database immediately via `writeJsonAsync`. Data survives restarts and deployments.

## Features

- OpenAI-compatible interface for all 4 providers
- Anthropic Messages API (`/v1/messages`) so Claude Code can use the gateway,
  including native thinking/tool_use/cache_control passthrough and
  `count_tokens`
- Streaming SSE support
- Tool calling / function calling for all providers
- SillyTavern mode (appends "继续" to Claude requests without tools)
- Model enable/disable management
- Add OpenRouter models by pulling the live remote catalog and picking from it
- PostgreSQL 16 persistence — settings and node state survive restarts
- Disabled upstream node management — re-enable auto-blocked nodes from the portal

## Admin Portal

3 tabs:
1. **Configuration** — Base URL, gateway API key, provider status, SillyTavern toggle
2. **Model Management** — Per-provider enable/disable with bulk controls, plus an
   "添加 OpenRouter 模型" panel (remote catalog → search → multi-select → add / delete)
3. **API Docs** — Authentication, endpoint reference, code examples
