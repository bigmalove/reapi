import { REPLIT_HOSTING_SHUTDOWN, NODE_PROBE_OFFLINE } from "./settings.js";
import { detectReplitNotRunning } from "./upstreamNodeFailure.js";

const PROBE_TIMEOUT_MS = 10_000;
const LLM_PROBE_TIMEOUT_MS = 30_000;
const LLM_PROBE_MODEL = "claude-haiku-4-5";
const PROBE_CONCURRENCY = 8;

export interface NodeProbeResult {
  url: string;
  online: boolean;
  status?: number;
  latencyMs: number;
  /** upstreamReason to record when the node is offline. */
  reason?: string;
  error?: string;
}

/**
 * Check whether a node's process is answering. The probe is a plain GET that
 * costs no model quota, so it cannot tell a working node from one whose
 * account is out of budget — those are caught by real requests instead
 * (upstreamNodeFailure.ts). A node counts as offline only when:
 *  - the request fails outright (DNS, connection refused, timeout),
 *  - Replit serves a placeholder page instead of the app (deployment not
 *    live, or dev workspace not running — see detectReplitNotRunning), or
 *  - Replit's edge answers 502/503/504 (app not responding).
 * Any other response, including 401/404 from the node app, means it is up.
 */
export async function probeNode(url: string): Promise<NodeProbeResult> {
  const started = Date.now();
  try {
    const response = await fetch(`${url}/healthz`, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await response.text().catch(() => "");
    const latencyMs = Date.now() - started;
    const status = response.status;

    const notRunning = detectReplitNotRunning(body);
    if (notRunning) {
      return { url, online: false, status, latencyMs, reason: REPLIT_HOSTING_SHUTDOWN, error: notRunning };
    }
    if (status === 502 || status === 503 || status === 504) {
      return {
        url, online: false, status, latencyMs,
        reason: NODE_PROBE_OFFLINE,
        error: `Node not responding (HTTP ${status})`,
      };
    }
    return { url, online: true, status, latencyMs };
  } catch (err: unknown) {
    const latencyMs = Date.now() - started;
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
    return {
      url, online: false, latencyMs,
      reason: NODE_PROBE_OFFLINE,
      error: timedOut
        ? `Node did not respond within ${PROBE_TIMEOUT_MS / 1000}s`
        : `${err instanceof Error ? err.message : String(err)}${cause}`.slice(0, 300),
    };
  }
}

/**
 * Check whether a node can actually serve an LLM call: send the cheapest
 * possible message (Haiku, 1 output token) through the node's Anthropic
 * route. Unlike `probeNode`, this also catches nodes that are up but
 * out of budget, so a pass means the node is safe to put back in the pool.
 */
export async function probeNodeLlm(url: string, apiKey: string): Promise<NodeProbeResult> {
  const started = Date.now();
  try {
    const response = await fetch(`${url}/modelfarm/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: LLM_PROBE_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS),
    });
    const body = await response.text().catch(() => "");
    const latencyMs = Date.now() - started;
    const status = response.status;

    let hasContent = false;
    try {
      hasContent = Array.isArray((JSON.parse(body) as { content?: unknown }).content);
    } catch {
      // not JSON
    }
    if (response.ok && hasContent) return { url, online: true, status, latencyMs };
    return {
      url, online: false, status, latencyMs,
      error: `HTTP ${status}: ${body.slice(0, 300)}`,
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - started;
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
    return {
      url, online: false, latencyMs,
      error: timedOut
        ? `Node did not respond within ${LLM_PROBE_TIMEOUT_MS / 1000}s`
        : `${err instanceof Error ? err.message : String(err)}${cause}`.slice(0, 300),
    };
  }
}

/** Probe many nodes with bounded concurrency; results keep the input order. */
export async function probeNodes(
  urls: string[],
  probe: (url: string) => Promise<NodeProbeResult> = probeNode,
): Promise<NodeProbeResult[]> {
  const results = new Array<NodeProbeResult>(urls.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < urls.length) {
      const i = next++;
      results[i] = await probe(urls[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, urls.length) }, worker));
  return results;
}
