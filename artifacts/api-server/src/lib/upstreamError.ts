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

  constructor(provider: string, status: number, body: string) {
    super(`${provider} error ${status}: ${body}`);
    this.name = "UpstreamHttpError";
    this.provider = provider;
    this.status = status;
    this.body = body;
  }

  /** 4xx other than 429: the request itself is wrong, retrying cannot help. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
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

/** Does this upstream body mean the model id itself does not exist? */
export function looksLikeUnknownModel(body: string): boolean {
  return /no endpoints found|not a valid model|model (?:not found|does not exist)|unknown model|invalid model/i.test(
    body,
  );
}
