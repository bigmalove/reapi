import { logger } from "./logger.js";
import { resolveProviderEndpoint } from "./providerEndpoint.js";

// OpenRouter's catalog endpoint is public — no key required. It is the
// authoritative "latest models" list, so it is tried first.
const PUBLIC_CATALOG_URL = "https://openrouter.ai/api/v1/models";

const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

export type CatalogSource = "openrouter-public" | "gateway-upstream";

export interface OpenRouterCatalogEntry {
  id: string;
  name: string;
  created: number;
  description?: string;
  contextLength: number | null;
  promptPrice: string | null;
  completionPrice: string | null;
  modality: string | null;
  /** Normalised `architecture.output_modalities` (`["text"]`, `["image","text"]`, …). */
  outputModalities: string[];
  /**
   * The model can RETURN images. This is the only reliable drawing signal in the
   * catalog: `modality` conflates input and output ("text+image->text" means it
   * only READS images), which is why the picker looked like OpenRouter had no
   * image models at all. Pure image vendors (flux/ideogram/seedream/dall-e) are
   * not chat models and never appear in `/models` to begin with.
   */
  canOutputImage: boolean;
}

export interface OpenRouterCatalog {
  source: CatalogSource;
  fetchedAt: number;
  models: OpenRouterCatalogEntry[];
}

let cache: OpenRouterCatalog | null = null;
let inflight: Promise<OpenRouterCatalog> | null = null;

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** `["image","text"]` shape, or a comma/slash string in the tolerant fallback path. */
function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,+|]/)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

/**
 * Whether a model card emits images. Prefers `modality`'s output half
 * (`text+image->text+image`) because some endpoints only expose that field.
 */
function detectsImageOutput(outputModalities: string[], modality: string | null): boolean {
  if (outputModalities.includes("image")) return true;
  if (!modality) return false;
  const arrow = modality.split("->");
  if (arrow.length !== 2) return false;
  return arrow[1]!.split("+").some((part) => part.trim().toLowerCase() === "image");
}

/**
 * Normalise a `/models` payload into catalog entries. Tolerant on purpose: the
 * fallback source is whatever OpenRouter-compatible endpoint the gateway is
 * pointed at, which may only return the bare OpenAI `{id, created}` shape.
 */
function toEntries(payload: unknown): OpenRouterCatalogEntry[] {
  const data = asRecord(payload)["data"];
  if (!Array.isArray(data)) return [];

  const seen = new Set<string>();
  const out: OpenRouterCatalogEntry[] = [];

  for (const item of data) {
    const model = asRecord(item);
    const id = asString(model["id"])?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const pricing = asRecord(model["pricing"]);
    const topProvider = asRecord(model["top_provider"]);
    const architecture = asRecord(model["architecture"]);
    const description = asString(model["description"]);
    const modality = asString(architecture["modality"]);
    const outputModalities = toStringList(architecture["output_modalities"]);

    out.push({
      id,
      name: asString(model["name"]) ?? id,
      created: asNumber(model["created"]) ?? 0,
      ...(description ? { description: description.slice(0, 400) } : {}),
      contextLength: asNumber(model["context_length"]) ?? asNumber(topProvider["context_length"]),
      promptPrice: asString(pricing["prompt"]),
      completionPrice: asString(pricing["completion"]),
      modality,
      outputModalities,
      canOutputImage: detectsImageOutput(outputModalities, modality),
    });
  }

  out.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  return out;
}

async function fetchCatalog(): Promise<OpenRouterCatalog> {
  const errors: string[] = [];

  try {
    const models = toEntries(await fetchJson(PUBLIC_CATALOG_URL, { Accept: "application/json" }));
    if (models.length > 0) {
      return { source: "openrouter-public", fetchedAt: Date.now(), models };
    }
    errors.push("openrouter.ai: empty model list");
  } catch (err) {
    errors.push(`openrouter.ai: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fallback: ask whichever OpenRouter endpoint this gateway actually routes
  // through (Replit AI Integration proxy, or a reverse-proxy upstream).
  try {
    const endpoint = resolveProviderEndpoint("openrouter");
    const url = `${endpoint.baseUrl.replace(/\/+$/, "")}/models`;
    const models = toEntries(
      await fetchJson(url, {
        Accept: "application/json",
        Authorization: `Bearer ${endpoint.apiKey}`,
      }),
    );
    if (models.length > 0) {
      return { source: "gateway-upstream", fetchedAt: Date.now(), models };
    }
    errors.push("gateway upstream: empty model list");
  } catch (err) {
    errors.push(`gateway upstream: ${err instanceof Error ? err.message : String(err)}`);
  }

  logger.warn({ errors }, "Failed to fetch OpenRouter model catalog");
  throw new Error(`Unable to fetch the OpenRouter model list — ${errors.join("; ")}`);
}

/**
 * Fetch the remote OpenRouter model catalog, cached for `CACHE_TTL_MS`.
 * Concurrent callers share a single in-flight request. When every source fails
 * a previously cached (stale) catalog is served rather than an error.
 */
export async function getOpenRouterCatalog(
  opts: { refresh?: boolean } = {},
): Promise<OpenRouterCatalog> {
  if (!opts.refresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }
  if (inflight) return inflight;

  inflight = fetchCatalog()
    .then((catalog) => {
      cache = catalog;
      return catalog;
    })
    .catch((err: unknown) => {
      if (cache) {
        logger.warn({ err }, "Serving stale OpenRouter catalog");
        return cache;
      }
      throw err;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/**
 * Synchronous capability probe against the warm cache.
 *
 * Returns `null` when no catalog has been fetched yet — callers must then fall
 * back to their own heuristic instead of blocking the request path on a
 * possibly unreachable openrouter.ai.
 */
export function cachedImageOutputCapability(modelId: string): boolean | null {
  if (!cache) return null;
  const hit = cache.models.find((m) => m.id === modelId);
  return hit ? hit.canOutputImage : null;
}

/** Warm the catalog without making the caller wait (best effort). */
export function warmCatalog(): void {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return;
  if (inflight) return;
  void getOpenRouterCatalog().catch(() => undefined);
}

/** Every catalog entry that can return images. Empty when the fetch fails. */
export async function listImageOutputModels(): Promise<OpenRouterCatalogEntry[]> {
  try {
    const catalog = await getOpenRouterCatalog();
    return catalog.models.filter((m) => m.canOutputImage);
  } catch (err) {
    logger.warn({ err }, "Image-capable catalog unavailable");
    return [];
  }
}
