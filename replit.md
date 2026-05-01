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

- `gpt-*`, `o1-*`, `o3-*`, `o4-*` → OpenAI (via Replit AI Integrations)
- `claude-*` → Anthropic (via Replit AI Integrations)
- `gemini-*` → Google Gemini (via Replit AI Integrations)
- `provider/model` format (e.g. `meta-llama/llama-3.3-70b-instruct`) → OpenRouter (via Replit AI Integrations)

Default model: `gpt-4.1-mini`

## Persistence

Local JSON files in `artifacts/api-server/data/`:
- `server_settings.json` — gateway settings (sillyTavernMode, etc.)
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
