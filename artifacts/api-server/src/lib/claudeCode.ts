import { getModelRegistry, isThinkingVariantId } from "./models.js";

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

export type ClaudeModelMatch = "exact" | "normalized" | "canonical" | "family" | "unmapped";

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
 * Resolution order: exact → whitespace/Bedrock normalised → canonical
 * (`4.5` == `4-5`, dates dropped) → serving-mode marker stripped
 * (`-fast`/`-1m`/`-latest`) → family fallback (newest `claude-<family>-*`).
 * The family fallback is what keeps retired ids such as
 * `claude-3-5-haiku-20241022` working: the exact version is gone from the
 * registry, so the request lands on the newest model of that family.
 */
export function resolveClaudeCodeModel(requested: string): ClaudeModelResolution {
  const trimmed = requested.trim();
  if (!trimmed) return { requested, model: requested, match: "unmapped" };

  // Thinking variants resolve through their base id, then re-attach the marker.
  const thinking = THINKING_SUFFIX_RE.exec(trimmed);
  if (thinking) {
    const baseRes = resolveClaudeCodeModel(trimmed.slice(0, -thinking[0].length));
    if (baseRes.match !== "unmapped") {
      return {
        requested,
        model: `${baseRes.model}${thinking[0]}`,
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
    const newest = bases
      .filter((m) => m.provider === "anthropic" && canonicalKey(m.id).startsWith(`claude-${family}-`))
      .sort((a, b) => b.created - a.created)[0];
    if (newest) return { requested, model: newest.id, match: "family" };
  }

  return { requested, model: cleaned || trimmed, match: "unmapped" };
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
