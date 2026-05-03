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
| GET | /v1/models | List enabled models (OpenAI compatible) |
| POST | /v1/chat/completions | Chat completion (core endpoint) |
| GET | /v1/admin/models | List all models with status |
| PATCH | /v1/admin/models | Enable/disable models |

## Environment Variables (Replit AI Integrations — auto-provisioned)

- `AI_INTEGRATIONS_OPENAI_BASE_URL` + `AI_INTEGRATIONS_OPENAI_API_KEY`
- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` + `AI_INTEGRATIONS_ANTHROPIC_API_KEY`
- `AI_INTEGRATIONS_GEMINI_BASE_URL` + `AI_INTEGRATIONS_GEMINI_API_KEY`
- `AI_INTEGRATIONS_OPENROUTER_BASE_URL` + `AI_INTEGRATIONS_OPENROUTER_API_KEY`

Optional:
- `PROXY_API_KEY` — gateway auth key (if set, required for all /v1/* requests)

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

### OpenRouter provider pinning

The Replit AI Integration proxy passes through the `provider` field for some sources but strips it for others:
- ✅ Works: `OpenAI`, `amazon-bedrock` (US-based providers)
- ❌ Stripped: `deepseek` (CN-based provider) — DeepSeek V4 entries fall back to OpenRouter's auto-routing (Novita / GMICloud / Together / etc.)

`openai/gpt-5.5*` entries are pinned to OpenAI (not Azure) via `provider.order: ["OpenAI"]`.

Default model: `gpt-4.1-mini`

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

**Legacy compat**: PATCH `/api/settings` still accepts the old scalar `reverseProxyUrl`/`reverseProxyApiKey` and maps them onto pool[0]. GET responses expose only the new pool shape.

## Persistence

Local JSON files in `artifacts/api-server/data/`:
- `server_settings.json` — gateway settings (sillyTavernMode, reverseProxyEnabled, reverseProxyMode, reverseProxyPool[], providerOverrides)
- `disabled_models.json` — list of disabled model IDs

## Features

- OpenAI-compatible interface for all 4 providers
- Streaming SSE support
- Tool calling / function calling for all providers
- SillyTavern mode (appends "继续" to Claude requests without tools)
- Model enable/disable management
- No database required — JSON file persistence only

## Admin Portal

3 tabs:
1. **Configuration** — Base URL, gateway API key, provider status, SillyTavern toggle
2. **Model Management** — Per-provider enable/disable with bulk controls
3. **API Docs** — Authentication, endpoint reference, code examples
