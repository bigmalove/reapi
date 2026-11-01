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
| `claude-opus-5-5` (registry only has 5.0) | **404** — no silent downgrade, see below |
| `claude-*-fast` / `-1m` / `-latest` | same model without the serving marker |
| `claude-*-thinking[-level]` | base model + thinking enabled at that level |

The family fallback (newest **enabled** `claude-<opus|sonnet|haiku>-*` in the
registry) exists for retired ids such as `claude-3-5-sonnet-20241022`; it is
reported in the request log as `match: "family"`. It **only fires when the
requested version is at or below the newest registered version**: asking for
`claude-opus-5-5` while only `claude-opus-5` is registered returns
`404 not_found_error` instead of quietly serving the older model. Serving an
older model is a downgrade the caller never asked for and cannot see — the
error names the id and points at the mapping setting. Add the model (or map it)
to use it.

`anthropic/claude-opus-5.5`, `anthropic/claude-sonnet-5.5` and
`anthropic/claude-haiku-5.5` are registered as OpenRouter models (ids verified
against `https://openrouter.ai/api/v1/models`), with the usual `-thinking*`
variants. The Anthropic direct integration has no 5.5 endpoint, so those ids
route through OpenRouter.

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

### Upstream errors are relayed, not flattened to 502

The converted path (any non-Anthropic provider) reports the upstream's own
status and message: a 404 from OpenRouter (`No endpoints found for …`) arrives
as `404 not_found_error`, a 400 as `invalid_request_error`, a 429 as
`rate_limit_error`. Only 5xx and network failures become `502 api_error`.
A 4xx is never retried — the same request would be rejected identically — so
the client sees the real cause on the first attempt. `UpstreamHttpError`
(`lib/upstreamError.ts`) carries the status; providers throw it instead of a
bare `Error`.

Claude models routed through OpenRouter are pinned to
`provider.order: ["amazon-bedrock", "claude-on-aws", "anthropic"]` with
`allow_fallbacks: true`. The previous pin, `["amazon-bedrock/claude-on-aws"]`
with fallbacks disabled, used a provider slug OpenRouter does not define, so
any Claude id that channel could not serve came back as a gateway 502
(`anthropic/claude-opus-5.5` is the first id that hit it). Bedrock is still
preferred for cost; the other Claude channels are fallbacks rather than hard
failures.

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

**Identity metadata is clamped to 32 bytes.** Claude Code sends
`metadata.user_id` (`user_` + a long hash) on every request, and a relay that
translates Anthropic → OpenAI maps it onto `safety_identifier`, which some
upstreams cap at 32 **bytes** — the request then dies with
`400 safety_identifier is too long. Maximum length: 32 bytes.` before the model
is called. `clampIdentifier()` (byte-safe, never splits a multi-byte character)
truncates `metadata.user_id`, `user` and `safety_identifier` on every outbound
path (native Anthropic body, converted request, OpenAI/OpenRouter bodies). If an
upstream still rejects it, the native path drops `metadata` entirely and retries
once — the value only groups requests for abuse monitoring.

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

**In-request rotation on node-level 4xx**: `maybeDisableSelectedNode()` returns `{action, retryElsewhere}`. A 403/402 whose body marks the node as exhausted (quota, `FREE_TIER_BUDGET_EXCEEDED`, `insufficient_quota`, `额度已用尽`…) evicts the node **and** the same request is replayed on the next pool entry — `/v1/messages` (native and converted), `/v1/chat/completions` and the provider layer all honour it via `UpstreamHttpError.nodeRetryable`. `retryElsewhere` is false when nothing is left to rotate to (or when the endpoint came from a per-provider override), and then the upstream 403 with its quota message is relayed unchanged instead of becoming a misleading 502.

**Wrapped quota 429 is counted, not instant death**: pool nodes report an exhausted account as `HTTP 502 {"type":"upstream_node_unavailable","upstreamStatus":429,"reason":"quota-exhausted","retryable":false,"disabledCandidate":true}` — and they stamp the SAME envelope on any upstream rate limit, discarding the original body. So the wording can never separate "account is spent" from "the provider throttled us", and the gateway judges from a series instead of one response.

A wrapped 429 is therefore a cooldown + rotation (`QUOTA_STRIKE_LIMIT = 8` per node inside a 10-minute window in `lib/upstreamNodeFailure.ts`); the eighth strike evicts the node with the monthly window and records `quotaSignalUnverified: true`. The unit is the **request**, not the attempt: `runWithQuotaStrikeScope()` gives every request an `AsyncLocalStorage` id (`/v1/chat/completions`, `/v1/messages`), so the gateway's own replays across the pool count as one observation. Without that, one throttled channel drained the pool in seconds — a burst of concurrent turns fanned out over different nodes and every one of them reported the channel as dead, parking accounts that had answered 200 moments earlier. A genuinely spent account still gets there in minutes, because every single request fails. Raw upstream bodies are kept on the row (`rawUpstreamBody`) so a verdict can be re-read later instead of trusting a summary.

**Output budget default = maximum**: whenever the client sends no `max_tokens`, the gateway forwards **64000** (`lib/outputLimits.ts` → `DEFAULT_MAX_OUTPUT_TOKENS`), applied in `buildNativeAnthropicBody`, `anthropicToOpenAIRequest`, and the openai/gemini/openrouter provider bodies. The old 4096/8192/16000 defaults were what let thinking models consume the whole allowance before answering — the client then shows "已达到输出 token 上限，回答被截断" over an empty reply. An explicit client value is never overridden; `MAX_OUTPUT_TOKENS` env lowers the default. If a model still rejects the value (`400`/`422` "max_tokens … too large"), the request is replayed with the budget halved (`shrinkOutputBudget()`, floor 1024) on all three entry paths, so a maximum default cannot turn a previously working model into a hard error.

**Zero-content answers**: a stream that ends with `stop_reason`/`finish_reason` `max_tokens` and no visible delta is not a truncated answer — nothing was produced. On the converted path the SSE headers are withheld until the first visible delta; if the stream ends first, `finish_reason: length` triggers an automatic `max_tokens` doubling (max 2 tries, ceiling 64000) before anything is committed, and a still-empty result is reported as an `error` event naming the budget. On the DeepSeek thinking branch `openrouter.ts` also raises `max_tokens` to a 16000 floor, because reasoning tokens count against that budget. Empty answers on the native Anthropic path are logged (`produced no content but reported stop_reason=max_tokens`) — headers are already committed there, so no retry is possible.

**Concurrency: one OpenRouter channel, one gate**: every pool node forwards to the same OpenRouter key and channel, so a wrapped 429 is a property of the channel, not of the node — rotating to the next node re-enters the same throttling window. `providers/openrouter.ts` therefore queues dispatches per model: a throttled model is parked for 2s (capped at 8s, honouring `Retry-After` when the node sends one) and dispatches are spaced 400ms apart, because every waiter waking from its `setTimeout` in the same tick would otherwise hit the channel together again (measured: five concurrent turns resumed within 3ms of each other). Retries inside a request back off exponentially too (`min(1000 × 2^(attempt-1), 8000)` in `/v1/chat/completions` and both `/v1/messages` paths), so a retry lands after the window instead of inside it.

**Pool drained ≠ misconfigured**: `disableUpstreamNode()` no longer flips `reverseProxyEnabled` off when the last node leaves. Availability is derived — `isReverseProxyActive()` is false while the pool is empty — and `resolveProviderEndpoint()` raises `UpstreamUnavailableError`, which the routes answer with **503 + `Retry-After`** and `type: "upstream_unavailable"` instead of a 502 that reads as a permanent gateway fault, or a `Provider "p" is not configured…` that hides the real upstream cause.

**OpenRouter routing tier** (`openRouterRoutingTier`, portal → 配置 →「OpenRouter 路由档位」): `auto` sends the model id untouched; `floor` appends `:floor` (price sort, `flex` tier eligible); `nitro` appends `:nitro` (throughput sort, `priority` tier eligible). Only those two suffixes are reserved by OpenRouter — an arbitrary `:<provider>` suffix becomes part of the id and matches nothing. Each suffix sorts candidates *and* makes an extra service tier eligible; it pins neither a provider nor a tier (the tier endpoint still has to win the same sort), so the UI must not call it a pin. The suffix goes on the outgoing id only: the bare `actualModel` stays the pricing key and the `usage.byModel` key. This is also the one routing control that survives a pool node — a `provider` object in the body is stripped before it reaches OpenRouter, the model string is forwarded verbatim. A model id that already carries `:free|:floor|:nitro|:online|:extended` is left alone (`hasModelVariantSuffix()`); PATCH validates the enum and answers 400 on anything else.

**Usage accounting** (`/api/usage`, portal tab「用量统计」): `lib/usageLedger.ts` records the token usage each provider reports, attributes it to the pool entry that served the request, prices it with the OpenRouter `/models` catalog, and aggregates it into hourly buckets (45-day retention, ≤40k buckets, debounced flush; `usage_ledger_v1` + `openrouter_prices_v1` in `kv_store`). Streams are tapped (`tapStreamUsage()`) so the final-chunk `usage` and OpenRouter's per-chunk `provider` (the channel that actually served it — "Wafer", "DeepSeek", …) are captured; non-streaming replies are recorded directly. Cost prefers the upstream-reported `usage.cost` and falls back to the catalog estimate, keeping both figures apart (`upstreamCostUsd` vs `estimatedCostUsd`) plus a `pricedRequests/unpricedRequests` split; a request that reports no usage at all is counted in `coverage.missingUsage` instead of looking like free traffic. `GET /api/usage?window=24h|7d|30d|all` returns totals, byProvider/byAccount/byModel (with per-channel breakdown), daily series, recent calls, blocked-pool state and price-snapshot metadata; `POST /api/usage/refresh-prices` and `POST /api/usage/reset` are the portal's two actions. Blocked rows with a 403 budget body are counted as `blocked-quota`; an inferred (strike-counted) park shows as `blocked-suspect` instead of inflating the casualty count.

**Disabled-node sweep**: `restoreExpiredDisabledNodes()` also runs at boot and every 60s (`index.ts`), so a quiet gateway cannot hold rows past their window while the panel keeps rendering a stale badge.

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
- `usage_ledger_v1` — hourly usage buckets + recent calls + coverage counters (`lib/usageLedger.ts`)
- `openrouter_prices_v1` — persisted OpenRouter price snapshot, so costs survive a restart while the catalog is unreachable

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

4 tabs:
1. **Configuration** — Base URL, gateway API key, provider status, SillyTavern toggle,
   OpenRouter routing tier, Claude Code model mapping
2. **Model Management** — Per-provider enable/disable with bulk controls, plus an
   "添加 OpenRouter 模型" panel (remote catalog → search → multi-select → add / delete)
3. **Usage** — totals, per-model cost (OpenRouter catalog prices), per-account and
   per-channel breakdown, daily series, recent calls, blocked-pool view, price refresh / ledger reset
4. **API Docs** — Authentication, endpoint reference, code examples

## Install / Build / Deploy (read this before touching dependency config)

Three failures look like build errors but are install errors:

| 症状 | 真因 |
| --- | --- |
| `WARN Local package.json exists, but node_modules missing` | `pnpm install` 失败或被杀，工作区根本没有依赖 |
| `sh: 1: vite: not found` | 同上，`node_modules/.bin` 里没有 vite |
| `Cannot find module 'esbuild'`（来自 `build.mjs`） | 同上，esbuild 的安装被中断 |

两条曾经真实踩到的坑：

1. **`ERR_MODULE_NOT_FOUND`/`ERR_PNPM_IGNORED_BUILDS`** — pnpm 10 用 `pnpm-workspace.yaml` 的
   `onlyBuiltDependencies` 放行构建脚本；pnpm 11 不再读它，改为 `allowBuilds`，而且拒绝执行 esbuild 的
   install 脚本时会**直接失败**（不是警告）。所以 `pnpm-workspace.yaml` 同时声明两个键，pnpm 10 / 11 都能装。
2. **`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`** — 非 TTY（Replit workflow / post-merge / deploy builder）
   下 pnpm 拒绝清除过期 `node_modules` 并退出，工作区就此没有依赖。仓库级开关写在
   `pnpm-workspace.yaml` 的 `confirmModulesPurge: false`（`.npmrc` 里的 `confirm-modules-purge` **不生效**，
   已实测），这样平台自己的自动安装也能自愈，不需要任何终端命令。`scripts/bootstrap.sh` 另外导出
   `CI=true` / `npm_config_confirm_modules_purge=false` 作为第二道保险。
3. **依赖为空时每个 artifact 的命令都先自愈** — 三个 artifact 的 `dev`/`build`/`typecheck` 前置了
   `node ../../scripts/ensure-deps.mjs <vite|esbuild|tsc>`：工具找不到就先把 workspace 装好，再执行原命令。
   Replit 里点 workflow 时不需要有人先跑 `pnpm install`。

入口统一在这几个脚本里，不要各自 `pnpm install`：

- `scripts/ensure-deps.mjs` — 每个 artifact 命令的前置自愈（workflow 直接可用）
- `scripts/bootstrap.sh` — 安装 + 冻结锁文件失败时自动刷新锁文件 + 校验三个 artifact 的 `vite`/`esbuild`
- `scripts/deploy-build.sh` — 部署构建（bootstrap → api-server esbuild → api-portal vite），供 `.replit [deployment].build` 调用
- `scripts/deploy-run.sh` — 部署启动（`.replit [deployment].run`），dist 缺失时直接报错而不是静默起空服务
- `scripts/post-merge.sh` — 合并后钩子，容错安装；drizzle push 用 `@workspace/db`（旧的 `--filter db` 从来匹配不到包）

构建脚本不再要求 `PORT` / `BASE_PATH`：它们只影响 dev/preview server，而 `vite build` 在部署构建里没有任何环境变量，
原先的 `throw` 会让整个 `pnpm run build` 在配置加载阶段就失败。

自检一次过：

```bash
bash scripts/bootstrap.sh      # 装依赖并校验 vite/esbuild
pnpm run build                 # 全量（不含部署环境变量）必须通过
PORT=24927 bash scripts/deploy-run.sh   # curl /healthz -> {"status":"ok"}
```
