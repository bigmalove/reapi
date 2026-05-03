# AI Upstream Pool Node

## Overview

A single-instance **upstream pool node** deployed on Replit. Its sole job is to expose `/modelfarm/{openai,anthropic,google,openrouter}/*` paths and transparently forward every byte to the actual provider backends configured via Replit AI Integrations on this Repl.

Other gateways (the "downstream" / orchestrator) put this node's URL into their reverse-proxy pool. This node itself does **not** do any model routing, registry, request rewriting, or response rewriting.

## Architecture

Two artifacts in a pnpm monorepo:

- **`artifacts/api-server`** — Express + TypeScript proxy (serves at `/api` and `/modelfarm`)
- **`artifacts/api-portal`** — React + Vite status portal (serves at `/`)

## Stack

- pnpm workspaces, Node.js 24, Express 5, esbuild ESM bundle
- React + Vite + TypeScript + Tailwind CSS v4
- No database, no persisted state

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET    | /healthz, /api/healthz | Health check |
| GET    | /api/setup-status | Node role + per-segment env-var status |
| ANY    | /modelfarm/<segment>/<rest> | Transparent proxy to upstream |

### `/modelfarm/<segment>` mapping

| Segment | Forwarded to | Auth header injected |
|---|---|---|
| `openai` | `AI_INTEGRATIONS_OPENAI_BASE_URL` | `Authorization: Bearer …` |
| `anthropic` | `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | `x-api-key` + `anthropic-version` (passed through, default `2023-06-01`) |
| `google` | `AI_INTEGRATIONS_GEMINI_BASE_URL` | `x-goog-api-key` |
| `openrouter` | `AI_INTEGRATIONS_OPENROUTER_BASE_URL` | `Authorization: Bearer …` |

The proxy:
- Uses `express.raw()` so the original request body bytes are forwarded untouched.
- Preserves request method, query string, and `Content-Type` / `Accept` headers.
- Streams the upstream response body verbatim (so SSE works out of the box).
- Returns `503` if the segment's env vars are missing.

## Environment Variables

Replit AI Integrations (auto-provisioned per provider in use):

- `AI_INTEGRATIONS_OPENAI_BASE_URL` + `AI_INTEGRATIONS_OPENAI_API_KEY`
- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` + `AI_INTEGRATIONS_ANTHROPIC_API_KEY`
- `AI_INTEGRATIONS_GEMINI_BASE_URL` + `AI_INTEGRATIONS_GEMINI_API_KEY`
- `AI_INTEGRATIONS_OPENROUTER_BASE_URL` + `AI_INTEGRATIONS_OPENROUTER_API_KEY`

Optional:

- `PROXY_API_KEY` — when set, every `/modelfarm/*` request must carry it in `Authorization: Bearer <key>` or `x-api-key: <key>`. When unset the node is open.

## Admin Portal

Two tabs:

1. **节点状态** — Node base URL, `PROXY_API_KEY` status, per-segment env-var status.
2. **接入文档** — Auth, segment mapping, sample curl, how to add this node to a downstream pool.

## Key Commands

- `pnpm --filter @workspace/api-server run dev` — run API server
- `pnpm --filter @workspace/api-portal run dev` — run admin portal
- `pnpm run typecheck` — full repo typecheck
