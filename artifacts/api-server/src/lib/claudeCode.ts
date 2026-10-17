import { getModelRegistry, isThinkingVariantId, resolveProvider } from "./models.js";
import { logger } from "./logger.js";

/**
 * Claude Code compatibility helpers.
 *
 * Claude Code talks the Anthropic Messages API but does not always send the
 * bare model ids this gateway ships. On the wire it may send:
 *
 *   - `claude-sonnet-4-5-20250929`          (dated snapshot)
 *   - `claude-sonnet-4-5-20250929[1m]`      (1M-context marker)
 *   - `us.anthropic.claude-sonnet-4-5-...`  (Bedrock / Vertex prefixed id)
 *   - `claude-3-5-haiku-20241022`           (retired family)
 *   - `claude-sonnet-4-5-thinking-high`     (thinking variant)
 *
 * None of those hit `MODEL_REGISTRY` directly, so requests would fail with an
 * unknown-model error even though the underlying model is available. The
 * resolver below normalises them onto a registry id.
 *
 * It also strips Claude Code's own beta flags (`claude-code-*`, `oauth-*`)
 * before they reach a real Anthropic API key: those betas require Anthropic's
 * first-party OAuth session and make a normal `x-api-key` request fail with
 * "OAuth authentication is currently not supported".
 */

export type ClaudeModelMatch =
  | "exact"
  | "mapped"
  /** Wildcard `*` fallback: the id was unknown or resolved to a disabled model. */
  | "fallback"
  | "normalized"
  | "canonical"
  | "family"
  | "unmapped";

export interface ClaudeModelResolution {
  /** Model id as sent by the client. */
  requested: string;
  /** Registry id the request should be routed with. */
  model: string;
  match: ClaudeModelMatch;
}

const THINKING_SUFFIX_RE = /-thinking(-visible|-low|-medium|-high|-xhigh|-max)?$/;

/**
 * Split a trailing thinking marker off a model id.
 * `claude-opus-4-5-thinking-high` → { base: "claude-opus-4-5", level: "high" }
 */
export function splitThinkingSuffix(id: string): {
  base: string;
  level: string | null;
  thinking: boolean;
} {
  const match = id.match(THINKING_SUFFIX_RE);
  if (!match) return { base: id, level: null, thinking: false };
  const marker = match[1];
  const level = marker && marker !== "-visible" ? marker.slice(1) : null;
  return { base: id.slice(0, id.length - match[0].length), level, thinking: true };
}

/** Remove transport-only decorations from a model id. */
function stripWireNoise(raw: string): string {
  let id = raw.trim();
  // Claude Code marks 1M-context models with a `[1m]` suffix on the wire.
  id = id.replace(/\[\d+m\]$/i, "");
  // Bedrock / Vertex style ids: `us.anthropic.claude-...`, `anthropic.claude-...`.
  id = id.replace(/^(?:us|eu|apac|global)\.anthropic\./i, "");
  id = id.replace(/^anthropic\.(?=claude)/i, "");
  // Vertex publisher path prefixes.
  id = id.replace(/^(?:projects\/[^/]+\/locations\/[^/]+\/publishers\/anthropic\/models\/)/i, "");
  // `-v1:0` / `-v1` model version trailer.
  id = id.replace(/-v\d+(?::\d+)?$/i, "");
  // `@20250929` → `-20250929`
  id = id.replace(/@(\d{8})$/, "-$1");
  return id;
}

/** Dash/dot/date-insensitive key so `4.5` and `4-5` compare equal. */
function canonicalKey(id: string): string {
  return stripWireNoise(id)
    .toLowerCase()
    .replace(/[._@]/g, "-")
    .replace(/-\d{8}$/, "")
    .replace(/-v\d+(?:-\d+)?$/, "")
    .replace(/-+/g, "-")
    .replace(/-$/, "");
}

/**
 * Map a Claude Code model id onto a registry id.
 *
 * Resolution order: operator mapping → exact → whitespace/Bedrock normalised →
 * canonical (`4.5` == `4-5`, dates dropped) → serving-mode marker stripped
 * (`-fast`/`-1m`/`-latest`) → family fallback (newest **enabled**
 * `claude-<family>-*`), and only for versions at or below what the registry
 * already has.
 *
 * The operator mapping (`settings.claudeCodeModelMap`) is consulted first so an
 * explicit choice always wins over the heuristics — that is what lets a client
 * id such as `claude-haiku-5-5` be pinned to whichever model the operator wants
 * (including a model from another provider) without reconfiguring the client.
 *
 * The family fallback exists for retired ids: `claude-3-5-haiku-20241022` is no
 * longer served, so the request lands on the newest model of that family. It
 * deliberately does NOT fire when the client asks for a NEWER version than the
 * registry has (`claude-opus-5-5` while only `claude-opus-5` is registered):
 * silently serving an older model is a downgrade the caller never asked for and
 * cannot see. Those ids stay unresolved, so the request fails with a message
 * naming the id and pointing at the mapping setting.
 */
export function resolveClaudeCodeModel(
  requested: string,
  options: { map?: Record<string, string>; isUsable?: (id: string) => boolean } = {},
): ClaudeModelResolution {
  const trimmed = requested.trim();
  if (!trimmed) return { requested, model: requested, match: "unmapped" };

  const mapped = lookupMappedModel(options.map, trimmed);
  if (mapped) return { requested, model: mapped, match: "mapped" };

  // Thinking variants resolve through their base id, then re-attach the marker.
  const thinking = THINKING_SUFFIX_RE.exec(trimmed);
  if (thinking) {
    const baseRes = resolveClaudeCodeModel(trimmed.slice(0, -thinking[0].length), options);
    if (baseRes.match !== "unmapped") {
      return {
        requested,
        model: reattachThinkingSuffix(baseRes.model, thinking[0]),
        match: baseRes.match,
      };
    }
  }

  const registry = getModelRegistry();

  const exact = registry.find((m) => m.id === trimmed);
  if (exact) return { requested, model: exact.id, match: "exact" };

  const cleaned = stripWireNoise(trimmed);
  const normalized = registry.find((m) => m.id === cleaned);
  if (normalized) return { requested, model: normalized.id, match: "normalized" };

  const target = canonicalKey(cleaned);
  const bases = registry.filter((m) => !isThinkingVariantId(m.id));

  const canonical =
    bases.find((m) => canonicalKey(m.id) === target) ??
    registry.find((m) => canonicalKey(m.id) === target);
  if (canonical) return { requested, model: canonical.id, match: "canonical" };

  // `-fast`, `-1m` and `-latest` describe how a model is served, not which
  // model it is. Retry without them before falling back to the family default.
  const stripped = target.replace(/-(?:fast|1m|latest|\d+m)$/, "");
  if (stripped !== target) {
    const strippedMatch = bases.find((m) => canonicalKey(m.id) === stripped);
    if (strippedMatch) return { requested, model: strippedMatch.id, match: "canonical" };
  }

  const family = target.match(/(?:^|-)(opus|sonnet|haiku)(?:-|$)/)?.[1];
  if (family && (target.startsWith("claude-") || target.startsWith("anthropic-claude-"))) {
    const requestedVersion = familyVersion(target, family);
    // Newest first; prefer an enabled model so one disabled entry does not turn
    // every request for a retired id into a 400.
    const candidates = bases
      .filter((m) => m.provider === "anthropic" && canonicalKey(m.id).startsWith(`claude-${family}-`))
      .sort((a, b) => b.created - a.created);
    const preferred =
      (options.isUsable ? candidates.find((m) => options.isUsable!(m.id)) : undefined) ?? candidates[0];

    if (preferred) {
      const newestVersion = familyVersion(canonicalKey(preferred.id), family);
      const newer = compareVersions(requestedVersion, newestVersion) > 0;
      if (newer) {
        logger.warn(
          {
            requested: trimmed,
            family,
            requestedVersion,
            newestRegistered: preferred.id,
            newestVersion,
          },
          "claude code model asks for a newer version than the registry has — not falling back to an older one",
        );
        return { requested, model: cleaned || trimmed, match: "unmapped" };
      }
      return { requested, model: preferred.id, match: "family" };
    }
  }

  return { requested, model: cleaned || trimmed, match: "unmapped" };
}

/**
 * Version tuple of a Claude id relative to its family token.
 * `claude-opus-5-5` → `[5,5]`, `claude-3-5-haiku` → `[3,5]` (version before the
 * family token), `claude-opus-latest` → `[]`.
 */
function familyVersion(id: string, family: string): number[] {
  const parts = id.split("-");
  const index = parts.indexOf(family);
  if (index === -1) return [];
  const before = parts.slice(0, index).filter((part) => /^\d+$/.test(part)).map(Number);
  const after = parts.slice(index + 1).filter((part) => /^\d+$/.test(part)).map(Number);
  // `claude-3-5-haiku-20241022` puts the version before the family and the date
  // after it; dates are 8 digits, so drop them before comparing.
  const afterShort = after.filter((part) => part < 10000);
  if (afterShort.length > 0) return afterShort;
  return before;
}

/** Lexicographic compare of version tuples; missing entries count as 0. */
function compareVersions(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * `claude-haiku-4-5` + `-thinking-high` → `claude-haiku-4-5-thinking-high`, but
 * only when that variant exists. A mapped target from another provider (or a
 * base id without variants) is returned unchanged: the providers parse the
 * suffix themselves and an unregistered id would 404 at routing time.
 */
function reattachThinkingSuffix(target: string, suffix: string): string {
  if (THINKING_SUFFIX_RE.test(target)) return target;
  const candidate = `${target}${suffix}`;
  return getModelRegistry().some((m) => m.id === candidate) ? candidate : target;
}

/**
 * Look an id up in the operator mapping. Matching is deliberately forgiving so
 * one row covers the variants a client sends: exact, case-insensitive, and
 * date / version / serving-marker insensitive (`claude-sonnet-4-5` also covers
 * `claude-sonnet-4-5-20250929[1m]`).
 */
function lookupMappedModel(
  map: Record<string, string> | undefined,
  requested: string,
): string | null {
  if (!map) return null;
  const direct = map[requested];
  if (typeof direct === "string" && direct) return direct;

  const lower = requested.toLowerCase();
  const target = canonicalKey(requested);
  const targetBase = target.replace(/-(?:fast|1m|latest|\d+m)$/, "");

  let looseMatch: string | null = null;
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== "string" || !value) continue;
    const lowerKey = key.trim().toLowerCase();
    if (lowerKey === lower) return value;
    const keyCanonical = canonicalKey(key);
    if (keyCanonical === target) return value;
    if (keyCanonical.replace(/-(?:fast|1m|latest|\d+m)$/, "") === targetBase) looseMatch = value;
  }
  return looseMatch;
}

/**
 * Betas Claude Code adds for its own first-party session. They are rejected by
 * the Anthropic API when the request is authenticated with a plain API key.
 */
const STRIPPED_BETA_PREFIXES = ["oauth-", "claude-code-"];

/**
 * Extra betas to strip, comma separated (`CLAUDE_CODE_STRIP_BETAS`). Useful
 * when an upstream rejects a beta it does not implement.
 */
function extraStrippedBetas(): string[] {
  return (process.env["CLAUDE_CODE_STRIP_BETAS"] ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Filter an `anthropic-beta` header down to betas a non-OAuth upstream accepts.
 * Returns `undefined` when nothing is left, so the header is not sent empty.
 */
export function sanitizeAnthropicBeta(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const extra = extraStrippedBetas();
  const kept = value
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean)
    .filter((beta) => {
      const lower = beta.toLowerCase();
      return (
        !STRIPPED_BETA_PREFIXES.some((prefix) => lower.startsWith(prefix)) &&
        !extra.some((entry) => lower === entry || lower.startsWith(entry))
      );
    });
  const unique = Array.from(new Set(kept));
  return unique.length > 0 ? unique.join(",") : undefined;
}

/** Same filter for the body-level `betas` array used by newer beta APIs. */
export function sanitizeBetaList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const raw = value.filter((entry): entry is string => typeof entry === "string");
  const sanitized = sanitizeAnthropicBeta(raw.join(","));
  return sanitized ? sanitized.split(",") : undefined;
}

/**
 * Resolve a Claude Code model id to the model that will actually serve it,
 * applying the operator mapping, the automatic heuristics, and the wildcard
 * `*` fallback.
 *
 * The wildcard row (`{"*": "<model>"}`) is what keeps Claude Code usable when
 * the model it asks for is disabled or unknown — a background agent asking for
 * `claude-haiku-5-5` on a gateway where every Claude model is disabled would
 * otherwise fail every request. It only kicks in when the normal resolution
 * cannot produce a usable model, so explicit mappings and exact ids win.
 */
export function routeClaudeCodeModel(
  requested: string,
  map: Record<string, string> = {},
  isUsable: (id: string) => boolean = () => true,
): { model: string; match: ClaudeModelMatch; disabled: boolean } {
  const resolution = resolveClaudeCodeModel(requested, { map, isUsable });
  const disabled = !isUsable(resolution.model);

  const fallback = (map["*"] ?? "").trim();
  if (
    fallback &&
    fallback !== resolution.model &&
    (resolution.match === "unmapped" || disabled) &&
    isUsable(fallback) &&
    resolveProvider(fallback)
  ) {
    return { model: fallback, match: "fallback", disabled: false };
  }

  return { model: resolution.model, match: resolution.match, disabled };
}

// ── Model observations ──────────────────────────────────────────────────────

export interface ClaudeModelObservation {
  /** Model id as the client sent it. */
  requested: string;
  /** Gateway model id it was routed to. */
  resolved: string;
  match: ClaudeModelMatch;
  /** True when the resolved model is currently disabled (requests fail). */
  resolvedDisabled: boolean;
  count: number;
  /** ISO timestamp of the most recent request. */
  lastSeen: string;
}

const MAX_OBSERVATIONS = 50;
const observations = new Map<string, ClaudeModelObservation>();

/**
 * Record which model ids Claude Code actually sends, so the portal can offer
 * one-click mappings for the ones that are not in the registry yet instead of
 * making the operator dig through logs.
 */
export function recordModelObservation(
  requested: string,
  resolved: string,
  match: ClaudeModelMatch,
  resolvedDisabled: boolean,
  now: number = Date.now(),
): void {
  const key = requested.trim().toLowerCase();
  if (!key) return;
  const existing = observations.get(key);
  if (existing) {
    existing.resolved = resolved;
    existing.match = match;
    existing.resolvedDisabled = resolvedDisabled;
    existing.count++;
    existing.lastSeen = new Date(now).toISOString();
    return;
  }
  if (observations.size >= MAX_OBSERVATIONS) {
    // Evict the least recently seen id.
    let oldestKey: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [k, v] of observations) {
      const seen = Date.parse(v.lastSeen);
      if (seen < oldest) {
        oldest = seen;
        oldestKey = k;
      }
    }
    if (oldestKey) observations.delete(oldestKey);
  }
  observations.set(key, {
    requested: requested.trim(),
    resolved,
    match,
    resolvedDisabled,
    count: 1,
    lastSeen: new Date(now).toISOString(),
  });
}

/** Most recently seen model ids first. */
export function getModelObservations(): ClaudeModelObservation[] {
  return Array.from(observations.values()).sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
}

/**
 * Claude families that replaced `thinking.budget_tokens` with the adaptive
 * thinking API (`thinking: {type:"adaptive"}` + `output_config.effort`).
 * Matched by family prefix so dated ids and point releases are covered.
 */
const ADAPTIVE_THINKING_PREFIXES = [
  "claude-opus-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-sonnet-5",
];

export function usesAdaptiveThinking(modelId: string): boolean {
  const { base } = splitThinkingSuffix(modelId);
  return ADAPTIVE_THINKING_PREFIXES.some(
    (prefix) => base === prefix || base.startsWith(`${prefix}.`) || base.startsWith(`${prefix}-`),
  );
}

/** Token budget → effort level, mirroring providers/anthropic.ts. */
export function budgetToEffort(budget: number): string {
  if (budget >= 20000) return "max";
  if (budget >= 14000) return "xhigh";
  if (budget >= 8000) return "high";
  if (budget >= 3000) return "medium";
  return "low";
}

/** Effort level → legacy budget_tokens, mirroring providers/anthropic.ts. */
export function effortToBudget(effort: string, maxTokens: number): number {
  switch (effort) {
    case "max":
      return Math.floor(maxTokens * 0.95);
    case "xhigh":
      return Math.min(Math.floor(maxTokens * 0.9), 20000);
    case "high":
      return Math.min(Math.floor(maxTokens * 0.8), 14000);
    case "medium":
      return Math.min(Math.floor(maxTokens * 0.5), 8000);
    case "low":
      return Math.min(Math.floor(maxTokens * 0.3), 3000);
    default:
      return Math.floor(maxTokens * 0.8);
  }
}
