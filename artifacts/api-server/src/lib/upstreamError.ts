/**
 * An upstream provider answered with a non-2xx status.
 *
 * Providers used to throw a plain `Error("<Provider> error <status>: <body>")`,
 * which the route layer could only turn into a blanket 502 — so a genuine
 * "model not found" or "invalid request" reached the client as a gateway fault,
 * hiding the actual cause. Carrying the status (and the raw body) lets the
 * routes relay the real error, and lets the retry policy skip retrying a 4xx
 * that will fail identically every time.
 *
 * The message keeps the historical `"<Provider> error <status>: <body>"` shape:
 * `isNodeFault()` matches on it and logs are already written against it.
 */
export class UpstreamHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly body: string;
  /**
   * The failure was attributed to the pool node we sent it to (quota exhausted,
   * forbidden, payment required…) and that node has just been dropped from the
   * pool. The same request replayed on the next node is a different account, so
   * it is worth retrying even though the status is a 4xx.
   */
  readonly nodeRetryable: boolean;

  constructor(provider: string, status: number, body: string, nodeRetryable = false) {
    super(`${provider} error ${status}: ${body}`);
    this.name = "UpstreamHttpError";
    this.provider = provider;
    this.status = status;
    this.body = body;
    this.nodeRetryable = nodeRetryable;
  }

  /**
   * 4xx other than 429: the request itself is wrong, retrying cannot help —
   * unless the node itself was the problem (`nodeRetryable`), in which case a
   * 403/402 names an exhausted account rather than a malformed request.
   */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429 && !this.nodeRetryable;
  }
}

/** Narrow an unknown thrown value without importing the class at every call site. */
export function asUpstreamHttpError(err: unknown): UpstreamHttpError | null {
  if (err instanceof UpstreamHttpError) return err;
  // esbuild bundles are single-instance, but a duplicated module (e.g. two
  // entry points) would break `instanceof`; fall back to a shape check.
  if (
    err instanceof Error &&
    typeof (err as Partial<UpstreamHttpError>).status === "number" &&
    typeof (err as Partial<UpstreamHttpError>).provider === "string" &&
    typeof (err as Partial<UpstreamHttpError>).body === "string"
  ) {
    return err as UpstreamHttpError;
  }
  return null;
}

/**
 * Is this payload a whole HTML document rather than an API response?
 *
 * A stopped Replit deployment (`.replit.app`) or a stopped dev workspace is
 * answered by the platform edge, not by the node app: 404 plus ~8 KB of markup.
 * Every node route otherwise answers JSON, so leading markup identifies "the
 * app was never reached". Markup embedded in a JSON string (a relayed upstream
 * error) sits behind a `{` and is deliberately not matched.
 */
export function looksLikeHtmlDocument(body: string): boolean {
  const text = body.trim();
  const at = text.search(/<!doctype html|<html[\s>]/i);
  if (at < 0) return false;
  const prefix = text.slice(0, at).trim().replace(/\s+/g, " ");
  return prefix === "" || /^[A-Za-z][\w .-]* error \d{3}:$/.test(prefix);
}

/**
 * Client-facing text for a failure whose body is a whole HTML document. The
 * raw page is useless to a caller (the UI prints a wall of markup and the real
 * cause disappears), so it collapses to one line; the raw body stays in logs.
 */
export function summarizeUpstreamError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "Unknown error");
  if (!looksLikeHtmlDocument(raw)) return raw;
  const status = /\berror (\d{3})\b/.exec(raw)?.[1];
  return `Upstream returned a Replit placeholder page${status ? ` (HTTP ${status})` : ""} instead of JSON — that node cannot serve and was removed from the pool, please retry`;
}

/** Does this upstream body mean the model id itself does not exist? */
export function looksLikeUnknownModel(body: string): boolean {
  return /no endpoints found|not a valid model|model (?:not found|does not exist)|unknown model|invalid model/i.test(
    body,
  );
}
