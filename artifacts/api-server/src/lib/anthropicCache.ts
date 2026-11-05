/**
 * Prompt-cache breakpoints for Anthropic models reached through an
 * OpenAI-shaped upstream (OpenRouter and friends).
 *
 * Anthropic only caches a prompt prefix when the request carries an explicit
 * `cache_control` marker (max four). A client that speaks OpenAI's protocol has
 * no way to express that: `prompt_cache_key` is an OpenAI-only mechanism, and
 * OpenRouter forwards `cache_control` only inside content blocks. So a gateway
 * that forwards OpenAI bodies untouched always measures 0% cache reads — every
 * turn is billed as a cold prompt.
 *
 * This module rewrites the outbound messages just before dispatch: clone, convert
 * the tagged message's string content into a text-block array, and put
 * `cache_control` on its last text block. Four breakpoints, matching Anthropic's
 * documented limit:
 *
 *   1. the last system message   — the stable instructions prefix
 *   2. the previous assistant    — the mid-conversation rollback point
 *   3. the last assistant
 *   4. the last message          — tool results included: OpenRouter maps a
 *                                  `tool` message's text block through to an
 *                                  Anthropic `tool_result`, where the marker is
 *                                  legal and was verified to produce a hit
 *
 * Breakpoints 2 and 3 are what make an agent loop pay: each step appends to the
 * tail, so the previous step's full transcript is served from cache instead of
 * being re-billed.
 */

import type { ContentPart, Message } from "../types.js";

type CacheControl = { type: "ephemeral" };
type TaggedContentPart = ContentPart & { cache_control?: CacheControl };

const CACHE_CONTROL: CacheControl = { type: "ephemeral" };

/** Anthropic caps breakpoints at four; exceeding it is a 400 from the upstream. */
const MAX_BREAKPOINTS = 4;

/**
 * Model ids that resolve to something Anthropic serves. Gateways name them
 * `anthropic/...`, `claude-...`, or pass a bare id after a model mapping, so
 * match on both the namespace and the family prefix.
 */
const ANTHROPIC_FAMILY = /^(anthropic[\/:]|claude[-.]?)/i;

export function isAnthropicFamilyModel(model: string): boolean {
  return ANTHROPIC_FAMILY.test(model);
}

/**
 * Copy `content` into a block array and mark its last non-empty text block.
 * Returns null when there is nothing legal to mark (no text block, or content
 * that cannot carry one) so the caller leaves the message untouched.
 */
function tagLastTextBlock(
  content: Message["content"],
): TaggedContentPart[] | null {
  if (typeof content === "string") {
    if (content.length === 0) return null;
    const blocks: TaggedContentPart[] = [{ type: "text", text: content }];
    blocks[0]!.cache_control = CACHE_CONTROL;
    return blocks;
  }
  if (!Array.isArray(content) || content.length === 0) return null;

  // Clone the blocks: the request body is reused across retries and must not
  // accumulate markers as attempts replay.
  const blocks: TaggedContentPart[] = content.map((part) => ({ ...part }));
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.type !== "text") continue;
    if (typeof block.text === "string" && block.text.length === 0) continue;
    block.cache_control = CACHE_CONTROL;
    return blocks;
  }
  return null;
}

/**
 * Return a copy of `messages` with up to four `cache_control` breakpoints on
 * stable prefixes. The input array and its members are never mutated.
 */
export function applyUpstreamCacheBreakpoints(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  const out = messages.map((message) => ({ ...message }));
  const tagged = new Set<number>();

  const tag = (index: number): void => {
    if (index < 0 || index >= out.length) return;
    if (tagged.has(index)) return;
    if (tagged.size >= MAX_BREAKPOINTS) return;
    const message = out[index]!;
    if (message.role === "assistant" && !message.content) return; // tool-call-only turn
    const blocks = tagLastTextBlock(message.content);
    if (blocks === null) return;
    message.content = blocks;
    tagged.add(index);
  };

  // 1. last system message: the instruction prefix, identical on every step.
  const systemIndex = out
    .map((message, index) => (message.role === "system" ? index : -1))
    .filter((i) => i >= 0)
    .at(-1);
  if (systemIndex !== undefined) tag(systemIndex);

  // 2 + 3. the last two assistant turns: the rollback points an agent loop reuses.
  const assistantIndexes = out
    .map((message, index) => (message.role === "assistant" ? index : -1))
    .filter((i) => i >= 0);
  for (const index of assistantIndexes.slice(-2)) tag(index);

  // 4. the newest message, so the whole conversation-so-far is cacheable.
  tag(out.length - 1);

  return out;
}
