import { readJsonAsync, writeJson } from "./persist.js";

export type Provider = "openai" | "anthropic" | "gemini" | "openrouter";

export interface ModelEntry {
  id: string;
  provider: Provider;
  created: number;
}

export const MODEL_REGISTRY: ModelEntry[] = [
  // ── OpenAI Chat ──────────────────────────────────────────────────────────
  { id: "gpt-5.5",                  provider: "openai", created: 1753747200 },
  { id: "gpt-5.5-thinking",         provider: "openai", created: 1753747200 },
  { id: "gpt-5.5-thinking-low",     provider: "openai", created: 1753747200 },
  { id: "gpt-5.5-thinking-medium",  provider: "openai", created: 1753747200 },
  { id: "gpt-5.5-thinking-high",    provider: "openai", created: 1753747200 },
  { id: "gpt-5.5-thinking-xhigh",   provider: "openai", created: 1753747200 },
  { id: "gpt-5.5-thinking-max",     provider: "openai", created: 1753747200 },
  { id: "gpt-5.2",            provider: "openai", created: 1752537600 },
  { id: "gpt-5.1",            provider: "openai", created: 1751328000 },
  { id: "gpt-5",              provider: "openai", created: 1749600000 },
  { id: "gpt-5-mini",         provider: "openai", created: 1749600000 },
  { id: "gpt-5-nano",         provider: "openai", created: 1749600000 },
  { id: "gpt-4.1",            provider: "openai", created: 1744934400 },
  { id: "gpt-4.1-mini",       provider: "openai", created: 1744934400 },
  { id: "gpt-4.1-nano",       provider: "openai", created: 1744934400 },
  { id: "gpt-4o",             provider: "openai", created: 1715904000 },
  { id: "gpt-4o-mini",        provider: "openai", created: 1721260800 },
  // ── OpenAI Reasoning ─────────────────────────────────────────────────────
  { id: "o4-mini",            provider: "openai", created: 1744934400 },
  { id: "o3",                 provider: "openai", created: 1741392000 },
  { id: "o3-mini",            provider: "openai", created: 1738281600 },
  // ── OpenAI Thinking aliases (extended thinking via API param) ─────────────
  { id: "o4-mini-thinking",   provider: "openai", created: 1744934400 },
  { id: "o3-thinking",        provider: "openai", created: 1741392000 },
  { id: "o3-mini-thinking",   provider: "openai", created: 1738281600 },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  { id: "claude-opus-4-8",                      provider: "anthropic", created: 1759276800 },
  { id: "claude-opus-4-8-thinking",             provider: "anthropic", created: 1759276800 },
  { id: "claude-opus-4-8-thinking-visible",     provider: "anthropic", created: 1759276800 },
  { id: "claude-opus-4-8-thinking-low",         provider: "anthropic", created: 1759276800 },
  { id: "claude-opus-4-8-thinking-medium",      provider: "anthropic", created: 1759276800 },
  { id: "claude-opus-4-8-thinking-high",        provider: "anthropic", created: 1759276800 },
  { id: "claude-opus-4-8-thinking-xhigh",       provider: "anthropic", created: 1759276800 },
  { id: "claude-opus-4-8-thinking-max",         provider: "anthropic", created: 1759276800 },
  { id: "claude-opus-4-7",                      provider: "anthropic", created: 1756684800 },
  { id: "claude-opus-4-7-thinking",             provider: "anthropic", created: 1756684800 },
  { id: "claude-opus-4-7-thinking-visible",     provider: "anthropic", created: 1756684800 },
  { id: "claude-opus-4-7-thinking-low",         provider: "anthropic", created: 1756684800 },
  { id: "claude-opus-4-7-thinking-medium",      provider: "anthropic", created: 1756684800 },
  { id: "claude-opus-4-7-thinking-high",        provider: "anthropic", created: 1756684800 },
  { id: "claude-opus-4-7-thinking-xhigh",       provider: "anthropic", created: 1756684800 },
  { id: "claude-opus-4-7-thinking-max",         provider: "anthropic", created: 1756684800 },
  { id: "claude-opus-4-6",                      provider: "anthropic", created: 1753142400 },
  { id: "claude-opus-4-6-thinking",             provider: "anthropic", created: 1753142400 },
  { id: "claude-opus-4-6-thinking-visible",     provider: "anthropic", created: 1753142400 },
  { id: "claude-opus-4-6-thinking-low",         provider: "anthropic", created: 1753142400 },
  { id: "claude-opus-4-6-thinking-medium",      provider: "anthropic", created: 1753142400 },
  { id: "claude-opus-4-6-thinking-high",        provider: "anthropic", created: 1753142400 },
  { id: "claude-opus-4-6-thinking-xhigh",       provider: "anthropic", created: 1753142400 },
  { id: "claude-opus-4-6-thinking-max",         provider: "anthropic", created: 1753142400 },
  { id: "claude-opus-4-5",                      provider: "anthropic", created: 1751328000 },
  { id: "claude-opus-4-5-thinking",             provider: "anthropic", created: 1751328000 },
  { id: "claude-opus-4-5-thinking-visible",     provider: "anthropic", created: 1751328000 },
  { id: "claude-opus-4-5-thinking-low",         provider: "anthropic", created: 1751328000 },
  { id: "claude-opus-4-5-thinking-medium",      provider: "anthropic", created: 1751328000 },
  { id: "claude-opus-4-5-thinking-high",        provider: "anthropic", created: 1751328000 },
  { id: "claude-opus-4-5-thinking-xhigh",       provider: "anthropic", created: 1751328000 },
  { id: "claude-opus-4-5-thinking-max",         provider: "anthropic", created: 1751328000 },
  { id: "claude-opus-4-1",                      provider: "anthropic", created: 1748995200 },
  { id: "claude-opus-4-1-thinking",             provider: "anthropic", created: 1748995200 },
  { id: "claude-opus-4-1-thinking-visible",     provider: "anthropic", created: 1748995200 },
  { id: "claude-sonnet-4-6",                    provider: "anthropic", created: 1753142400 },
  { id: "claude-sonnet-4-6-thinking",           provider: "anthropic", created: 1753142400 },
  { id: "claude-sonnet-4-6-thinking-visible",   provider: "anthropic", created: 1753142400 },
  { id: "claude-sonnet-4-6-thinking-low",       provider: "anthropic", created: 1753142400 },
  { id: "claude-sonnet-4-6-thinking-medium",    provider: "anthropic", created: 1753142400 },
  { id: "claude-sonnet-4-6-thinking-high",      provider: "anthropic", created: 1753142400 },
  { id: "claude-sonnet-4-6-thinking-xhigh",     provider: "anthropic", created: 1753142400 },
  { id: "claude-sonnet-4-6-thinking-max",       provider: "anthropic", created: 1753142400 },
  { id: "claude-sonnet-4-5",                    provider: "anthropic", created: 1751328000 },
  { id: "claude-sonnet-4-5-thinking",           provider: "anthropic", created: 1751328000 },
  { id: "claude-sonnet-4-5-thinking-visible",   provider: "anthropic", created: 1751328000 },
  { id: "claude-sonnet-4-5-thinking-low",       provider: "anthropic", created: 1751328000 },
  { id: "claude-sonnet-4-5-thinking-medium",    provider: "anthropic", created: 1751328000 },
  { id: "claude-sonnet-4-5-thinking-high",      provider: "anthropic", created: 1751328000 },
  { id: "claude-sonnet-4-5-thinking-xhigh",     provider: "anthropic", created: 1751328000 },
  { id: "claude-sonnet-4-5-thinking-max",       provider: "anthropic", created: 1751328000 },
  { id: "claude-haiku-4-5",                     provider: "anthropic", created: 1751328000 },
  { id: "claude-haiku-4-5-thinking",            provider: "anthropic", created: 1751328000 },
  { id: "claude-haiku-4-5-thinking-visible",    provider: "anthropic", created: 1751328000 },
  { id: "claude-haiku-4-5-thinking-low",        provider: "anthropic", created: 1751328000 },
  { id: "claude-haiku-4-5-thinking-medium",     provider: "anthropic", created: 1751328000 },
  { id: "claude-haiku-4-5-thinking-high",       provider: "anthropic", created: 1751328000 },
  { id: "claude-haiku-4-5-thinking-xhigh",      provider: "anthropic", created: 1751328000 },
  { id: "claude-haiku-4-5-thinking-max",        provider: "anthropic", created: 1751328000 },
  { id: "claude-fable-5",                       provider: "anthropic", created: 1749600000 },
  { id: "claude-fable-5-thinking",              provider: "anthropic", created: 1749600000 },
  { id: "claude-fable-5-thinking-visible",      provider: "anthropic", created: 1749600000 },
  { id: "claude-fable-5-thinking-low",          provider: "anthropic", created: 1749600000 },
  { id: "claude-fable-5-thinking-medium",       provider: "anthropic", created: 1749600000 },
  { id: "claude-fable-5-thinking-high",         provider: "anthropic", created: 1749600000 },
  { id: "claude-fable-5-thinking-xhigh",        provider: "anthropic", created: 1749600000 },
  { id: "claude-fable-5-thinking-max",          provider: "anthropic", created: 1749600000 },

  // ── Gemini ────────────────────────────────────────────────────────────────
  { id: "gemini-3.1-pro-preview",                    provider: "gemini", created: 1753142400 },
  { id: "gemini-3.1-pro-preview-thinking",           provider: "gemini", created: 1753142400 },
  { id: "gemini-3.1-pro-preview-thinking-visible",   provider: "gemini", created: 1753142400 },
  { id: "gemini-3.1-pro-preview-thinking-low",       provider: "gemini", created: 1753142400 },
  { id: "gemini-3.1-pro-preview-thinking-medium",    provider: "gemini", created: 1753142400 },
  { id: "gemini-3.1-pro-preview-thinking-high",      provider: "gemini", created: 1753142400 },
  { id: "gemini-3.1-pro-preview-thinking-max",       provider: "gemini", created: 1753142400 },
  { id: "gemini-3.1-flash-image-preview",            provider: "gemini", created: 1753142400 },
  { id: "gemini-3.1-flash-lite-preview",             provider: "gemini", created: 1753142400 },
  { id: "gemini-3-flash-preview",                    provider: "gemini", created: 1751328000 },
  { id: "gemini-3-flash-preview-thinking",           provider: "gemini", created: 1751328000 },
  { id: "gemini-3-flash-preview-thinking-visible",   provider: "gemini", created: 1751328000 },
  { id: "gemini-2.5-pro",                            provider: "gemini", created: 1748995200 },
  { id: "gemini-2.5-pro-thinking",                   provider: "gemini", created: 1748995200 },
  { id: "gemini-2.5-pro-thinking-visible",           provider: "gemini", created: 1748995200 },
  { id: "gemini-2.5-flash",                          provider: "gemini", created: 1747699200 },
  { id: "gemini-2.5-flash-thinking",                 provider: "gemini", created: 1747699200 },
  { id: "gemini-2.5-flash-thinking-visible",         provider: "gemini", created: 1747699200 },
  { id: "gemini-3.5-flash",                           provider: "gemini", created: 1753747200 },
  { id: "gemini-3.5-flash-thinking",                 provider: "gemini", created: 1753747200 },
  { id: "gemini-3.5-flash-thinking-visible",         provider: "gemini", created: 1753747200 },
  { id: "gemini-3.5-flash-thinking-low",             provider: "gemini", created: 1753747200 },
  { id: "gemini-3.5-flash-thinking-medium",          provider: "gemini", created: 1753747200 },
  { id: "gemini-3.5-flash-thinking-high",            provider: "gemini", created: 1753747200 },
  { id: "gemini-3.5-flash-thinking-max",             provider: "gemini", created: 1753747200 },
  { id: "gemini-2.5-flash-lite",                     provider: "gemini", created: 1751328000 },

  // ── OpenRouter Featured ───────────────────────────────────────────────────
  { id: "x-ai/grok-4.20",                   provider: "openrouter", created: 1753142400 },
  { id: "x-ai/grok-4.1-fast",               provider: "openrouter", created: 1751328000 },
  { id: "x-ai/grok-4-fast",                 provider: "openrouter", created: 1748995200 },
  { id: "meta-llama/llama-4-maverick",       provider: "openrouter", created: 1744934400 },
  { id: "meta-llama/llama-4-scout",          provider: "openrouter", created: 1744934400 },
  { id: "openai/gpt-5.5",                          provider: "openrouter", created: 1753747200 },
  { id: "openai/gpt-5.5-thinking",                 provider: "openrouter", created: 1753747200 },
  { id: "openai/gpt-5.5-thinking-low",             provider: "openrouter", created: 1753747200 },
  { id: "openai/gpt-5.5-thinking-medium",          provider: "openrouter", created: 1753747200 },
  { id: "openai/gpt-5.5-thinking-high",            provider: "openrouter", created: 1753747200 },
  { id: "openai/gpt-5.5-thinking-xhigh",           provider: "openrouter", created: 1753747200 },
  { id: "openai/gpt-5.5-thinking-max",             provider: "openrouter", created: 1753747200 },
  { id: "openai/gpt-5.5-pro",                      provider: "openrouter", created: 1753747200 },
  { id: "deepseek/deepseek-v4-pro",                   provider: "openrouter", created: 1759276800 },
  { id: "deepseek/deepseek-v4-pro-thinking-xhigh",   provider: "openrouter", created: 1759276800 },
  { id: "deepseek/deepseek-v4-pro-thinking-max",      provider: "openrouter", created: 1759276800 },
  { id: "deepseek/deepseek-v4-flash",                 provider: "openrouter", created: 1759276800 },
  { id: "deepseek/deepseek-v3.2",            provider: "openrouter", created: 1751328000 },
  { id: "deepseek/deepseek-r1",              provider: "openrouter", created: 1737158400 },
  { id: "deepseek/deepseek-r1-0528",         provider: "openrouter", created: 1748995200 },
  { id: "mistralai/mistral-small-2603",      provider: "openrouter", created: 1741392000 },
  { id: "qwen/qwen3.7-max",                  provider: "openrouter", created: 1748390400 },
  { id: "qwen/qwen3.5-122b-a10b",            provider: "openrouter", created: 1751328000 },
  { id: "qwen/qwen3.6-max-preview",          provider: "openrouter", created: 1747267200 },
  { id: "stepfun/step-3.7-flash",            provider: "openrouter", created: 1748390400 },
  { id: "moonshotai/kimi-k2.6",              provider: "openrouter", created: 1747267200 },
  { id: "z-ai/glm-5.1",                      provider: "openrouter", created: 1747267200 },
  { id: "google/gemini-3.5-flash",            provider: "openrouter", created: 1753747200 },
  { id: "google/gemini-2.5-pro",             provider: "openrouter", created: 1748995200 },
  { id: "google/gemini-3.1-pro-preview",     provider: "openrouter", created: 1747267200 },
  // Anthropic via OpenRouter → forced to AWS Bedrock
  { id: "Bedrock/claude-4.8-opus",                       provider: "openrouter", created: 1759276800 },
  { id: "Bedrock/claude-4.8-opus-thinking",              provider: "openrouter", created: 1759276800 },
  { id: "Bedrock/claude-4.8-opus-thinking-low",          provider: "openrouter", created: 1759276800 },
  { id: "Bedrock/claude-4.8-opus-thinking-medium",       provider: "openrouter", created: 1759276800 },
  { id: "Bedrock/claude-4.8-opus-thinking-high",         provider: "openrouter", created: 1759276800 },
  { id: "Bedrock/claude-4.8-opus-thinking-xhigh",        provider: "openrouter", created: 1759276800 },
  { id: "Bedrock/claude-4.8-opus-thinking-max",          provider: "openrouter", created: 1759276800 },
  { id: "Bedrock/claude-4.7-opus",                       provider: "openrouter", created: 1756684800 },
  { id: "Bedrock/claude-4.7-opus-thinking",              provider: "openrouter", created: 1756684800 },
  { id: "Bedrock/claude-4.7-opus-thinking-low",          provider: "openrouter", created: 1756684800 },
  { id: "Bedrock/claude-4.7-opus-thinking-medium",       provider: "openrouter", created: 1756684800 },
  { id: "Bedrock/claude-4.7-opus-thinking-high",         provider: "openrouter", created: 1756684800 },
  { id: "Bedrock/claude-4.7-opus-thinking-xhigh",        provider: "openrouter", created: 1756684800 },
  { id: "Bedrock/claude-4.7-opus-thinking-max",          provider: "openrouter", created: 1756684800 },
  { id: "Bedrock/claude-fable-5",                        provider: "openrouter", created: 1749600000 },
  { id: "Bedrock/claude-fable-5-thinking",               provider: "openrouter", created: 1749600000 },
  { id: "Bedrock/claude-fable-5-thinking-low",           provider: "openrouter", created: 1749600000 },
  { id: "Bedrock/claude-fable-5-thinking-medium",        provider: "openrouter", created: 1749600000 },
  { id: "Bedrock/claude-fable-5-thinking-high",          provider: "openrouter", created: 1749600000 },
  { id: "Bedrock/claude-fable-5-thinking-xhigh",         provider: "openrouter", created: 1749600000 },
  { id: "Bedrock/claude-fable-5-thinking-max",           provider: "openrouter", created: 1749600000 },
  { id: "Bedrock/claude-4.6-opus",                       provider: "openrouter", created: 1753142400 },
  { id: "Bedrock/claude-4.6-opus-thinking",              provider: "openrouter", created: 1753142400 },
  { id: "Bedrock/claude-4.6-opus-thinking-low",          provider: "openrouter", created: 1753142400 },
  { id: "Bedrock/claude-4.6-opus-thinking-medium",       provider: "openrouter", created: 1753142400 },
  { id: "Bedrock/claude-4.6-opus-thinking-high",         provider: "openrouter", created: 1753142400 },
  { id: "Bedrock/claude-4.6-opus-thinking-xhigh",        provider: "openrouter", created: 1753142400 },
  { id: "Bedrock/claude-4.6-opus-thinking-max",          provider: "openrouter", created: 1753142400 },
  { id: "~anthropic/claude-opus-latest",                  provider: "openrouter", created: 1747180800 },
  { id: "~anthropic/claude-fable-latest",                        provider: "openrouter", created: 1781136000 },
  { id: "~anthropic/claude-fable-latest-thinking",               provider: "openrouter", created: 1781136000 },
  { id: "~anthropic/claude-fable-latest-thinking-visible",       provider: "openrouter", created: 1781136000 },
  { id: "~anthropic/claude-fable-latest-thinking-low",           provider: "openrouter", created: 1781136000 },
  { id: "~anthropic/claude-fable-latest-thinking-medium",        provider: "openrouter", created: 1781136000 },
  { id: "~anthropic/claude-fable-latest-thinking-high",          provider: "openrouter", created: 1781136000 },
  { id: "~anthropic/claude-fable-latest-thinking-xhigh",         provider: "openrouter", created: 1781136000 },
  { id: "~anthropic/claude-fable-latest-thinking-max",           provider: "openrouter", created: 1781136000 },
  { id: "anthropic/claude-opus-4.8",                     provider: "openrouter", created: 1759276800 },
  { id: "anthropic/claude-opus-4.8-fast",               provider: "openrouter", created: 1759276800 },
  { id: "anthropic/claude-opus-4.8-thinking",            provider: "openrouter", created: 1759276800 },
  { id: "anthropic/claude-opus-4.8-thinking-low",        provider: "openrouter", created: 1759276800 },
  { id: "anthropic/claude-opus-4.8-thinking-medium",     provider: "openrouter", created: 1759276800 },
  { id: "anthropic/claude-opus-4.8-thinking-high",       provider: "openrouter", created: 1759276800 },
  { id: "anthropic/claude-opus-4.8-thinking-xhigh",      provider: "openrouter", created: 1759276800 },
  { id: "anthropic/claude-opus-4.8-thinking-max",        provider: "openrouter", created: 1759276800 },
  { id: "anthropic/claude-opus-4.7",                     provider: "openrouter", created: 1756684800 },
  { id: "anthropic/claude-opus-4.7-fast",                provider: "openrouter", created: 1756684800 },
  { id: "anthropic/claude-opus-4.7-thinking",            provider: "openrouter", created: 1756684800 },
  { id: "anthropic/claude-opus-4.7-thinking-low",        provider: "openrouter", created: 1756684800 },
  { id: "anthropic/claude-opus-4.7-thinking-medium",     provider: "openrouter", created: 1756684800 },
  { id: "anthropic/claude-opus-4.7-thinking-high",       provider: "openrouter", created: 1756684800 },
  { id: "anthropic/claude-opus-4.7-thinking-xhigh",      provider: "openrouter", created: 1756684800 },
  { id: "anthropic/claude-opus-4.7-thinking-max",        provider: "openrouter", created: 1756684800 },
  { id: "anthropic/claude-opus-4.6",                     provider: "openrouter", created: 1753142400 },
  { id: "anthropic/claude-opus-4.6-thinking",            provider: "openrouter", created: 1753142400 },
  { id: "anthropic/claude-opus-4.6-thinking-low",        provider: "openrouter", created: 1753142400 },
  { id: "anthropic/claude-opus-4.6-thinking-medium",     provider: "openrouter", created: 1753142400 },
  { id: "anthropic/claude-opus-4.6-thinking-high",       provider: "openrouter", created: 1753142400 },
  { id: "anthropic/claude-opus-4.6-thinking-xhigh",      provider: "openrouter", created: 1753142400 },
  { id: "anthropic/claude-opus-4.6-thinking-max",        provider: "openrouter", created: 1753142400 },
  { id: "anthropic/claude-opus-4.5",                     provider: "openrouter", created: 1751328000 },
  { id: "anthropic/claude-opus-4.5-thinking",            provider: "openrouter", created: 1751328000 },
  { id: "anthropic/claude-opus-4.5-thinking-low",        provider: "openrouter", created: 1751328000 },
  { id: "anthropic/claude-opus-4.5-thinking-medium",     provider: "openrouter", created: 1751328000 },
  { id: "anthropic/claude-opus-4.5-thinking-high",       provider: "openrouter", created: 1751328000 },
  { id: "anthropic/claude-opus-4.5-thinking-xhigh",      provider: "openrouter", created: 1751328000 },
  { id: "anthropic/claude-opus-4.5-thinking-max",        provider: "openrouter", created: 1751328000 },
  { id: "anthropic/claude-sonnet-4.6",                   provider: "openrouter", created: 1753142400 },
  { id: "anthropic/claude-sonnet-4.6-thinking",          provider: "openrouter", created: 1753142400 },
  { id: "anthropic/claude-sonnet-4.6-thinking-low",      provider: "openrouter", created: 1753142400 },
  { id: "anthropic/claude-sonnet-4.6-thinking-medium",   provider: "openrouter", created: 1753142400 },
  { id: "anthropic/claude-sonnet-4.6-thinking-high",     provider: "openrouter", created: 1753142400 },
  { id: "anthropic/claude-sonnet-4.6-thinking-xhigh",    provider: "openrouter", created: 1753142400 },
  { id: "anthropic/claude-sonnet-4.6-thinking-max",      provider: "openrouter", created: 1753142400 },
  { id: "anthropic/claude-haiku-4.5",                    provider: "openrouter", created: 1751328000 },
  { id: "anthropic/claude-haiku-4.5-thinking",           provider: "openrouter", created: 1751328000 },
  { id: "anthropic/claude-haiku-4.5-thinking-low",       provider: "openrouter", created: 1751328000 },
  { id: "anthropic/claude-haiku-4.5-thinking-medium",    provider: "openrouter", created: 1751328000 },
  { id: "anthropic/claude-haiku-4.5-thinking-high",      provider: "openrouter", created: 1751328000 },
  { id: "anthropic/claude-haiku-4.5-thinking-xhigh",     provider: "openrouter", created: 1751328000 },
  { id: "anthropic/claude-haiku-4.5-thinking-max",       provider: "openrouter", created: 1751328000 },
  { id: "anthropic/claude-fable-5",                     provider: "openrouter", created: 1749600000 },
  { id: "anthropic/claude-fable-5-thinking",            provider: "openrouter", created: 1749600000 },
  { id: "anthropic/claude-fable-5-thinking-low",        provider: "openrouter", created: 1749600000 },
  { id: "anthropic/claude-fable-5-thinking-medium",     provider: "openrouter", created: 1749600000 },
  { id: "anthropic/claude-fable-5-thinking-high",       provider: "openrouter", created: 1749600000 },
  { id: "anthropic/claude-fable-5-thinking-xhigh",      provider: "openrouter", created: 1749600000 },
  { id: "anthropic/claude-fable-5-thinking-max",        provider: "openrouter", created: 1749600000 },
  { id: "cohere/command-a",                       provider: "openrouter", created: 1741392000 },
  { id: "amazon/nova-premier-v1",            provider: "openrouter", created: 1744934400 },
  { id: "baidu/ernie-4.5-300b-a47b",         provider: "openrouter", created: 1744934400 },
  { id: "openai/gpt-5.4-image-2",            provider: "openrouter", created: 1751328000 },
  { id: "bytedance-seed/seedream-4.5",       provider: "openrouter", created: 1747180800 },
  { id: "bytedance/seedance-2.0",            provider: "openrouter", created: 1747180800 },
  { id: "bytedance/seedance-2.0-fast",      provider: "openrouter", created: 1747180800 },
  { id: "kwaivgi/kling-v3.0-pro",            provider: "openrouter", created: 1747180800 },
  { id: "minimax/minimax-m3",               provider: "openrouter", created: 1781136000 },
  { id: "xiaomi/mimo-v2.5",                 provider: "openrouter", created: 1781136000 },
];

const DEFAULT_MODEL = "gpt-4.1-mini";

export function getDefaultModel(): string {
  return DEFAULT_MODEL;
}

export function resolveProvider(modelId: string): Provider | null {
  const entry = MODEL_REGISTRY.find((m) => m.id === modelId);
  if (entry) return entry.provider;
  if (modelId.includes("/")) return "openrouter";
  return null;
}

let _disabledModels: Set<string> | null = null;

export async function initModels(): Promise<void> {
  const arr = await readJsonAsync<string[]>("disabled_models.json", []);
  _disabledModels = new Set(arr);
}

function loadDisabledModels(): Set<string> {
  if (_disabledModels === null) {
    _disabledModels = new Set();
  }
  return _disabledModels;
}

export function getDisabledModels(): string[] {
  return Array.from(loadDisabledModels());
}

export function isModelDisabled(id: string): boolean {
  return loadDisabledModels().has(id);
}

export function setDisabledModels(ids: string[]): void {
  _disabledModels = new Set(ids);
  writeJson("disabled_models.json", ids);
}

export function patchModelDisabled(id: string, disabled: boolean): void {
  const set = loadDisabledModels();
  if (disabled) {
    set.add(id);
  } else {
    set.delete(id);
  }
  _disabledModels = set;
  writeJson("disabled_models.json", Array.from(set));
}

export function getEnabledModels(): ModelEntry[] {
  const disabled = loadDisabledModels();
  return MODEL_REGISTRY.filter((m) => !disabled.has(m.id));
}

export function getAllModelsWithStatus(): Array<ModelEntry & { disabled: boolean }> {
  const disabled = loadDisabledModels();
  return MODEL_REGISTRY.map((m) => ({ ...m, disabled: disabled.has(m.id) }));
}
