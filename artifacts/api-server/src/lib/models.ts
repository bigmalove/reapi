import { readJsonAsync, writeJson } from "./persist.js";

export type Provider = "openai" | "anthropic" | "gemini" | "openrouter";

export const PROVIDERS: Provider[] = ["openai", "anthropic", "gemini", "openrouter"];

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
  { id: "claude-opus-5",                        provider: "anthropic", created: 1785024000 },
  { id: "claude-opus-5-thinking",               provider: "anthropic", created: 1785024000 },
  { id: "claude-opus-5-thinking-visible",       provider: "anthropic", created: 1785024000 },
  { id: "claude-opus-5-thinking-low",           provider: "anthropic", created: 1785024000 },
  { id: "claude-opus-5-thinking-medium",        provider: "anthropic", created: 1785024000 },
  { id: "claude-opus-5-thinking-high",          provider: "anthropic", created: 1785024000 },
  { id: "claude-opus-5-thinking-xhigh",         provider: "anthropic", created: 1785024000 },
  { id: "claude-opus-5-thinking-max",           provider: "anthropic", created: 1785024000 },
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
  { id: "claude-sonnet-5",                       provider: "anthropic", created: 1782864000 },
  { id: "claude-sonnet-5-thinking",             provider: "anthropic", created: 1782864000 },
  { id: "claude-sonnet-5-thinking-visible",     provider: "anthropic", created: 1782864000 },
  { id: "claude-sonnet-5-thinking-low",         provider: "anthropic", created: 1782864000 },
  { id: "claude-sonnet-5-thinking-medium",      provider: "anthropic", created: 1782864000 },
  { id: "claude-sonnet-5-thinking-high",        provider: "anthropic", created: 1782864000 },
  { id: "claude-sonnet-5-thinking-xhigh",       provider: "anthropic", created: 1782864000 },
  { id: "claude-sonnet-5-thinking-max",         provider: "anthropic", created: 1782864000 },
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
  { id: "sakana/fugu-ultra",                 provider: "openrouter", created: 1750377600 },
  { id: "openrouter/fusion",                 provider: "openrouter", created: 1750032000 },
  { id: "x-ai/grok-4.20",                   provider: "openrouter", created: 1753142400 },
  { id: "x-ai/grok-4.5",                    provider: "openrouter", created: 1751932800 },
  { id: "x-ai/grok-4.1-fast",               provider: "openrouter", created: 1751328000 },
  { id: "x-ai/grok-4-fast",                 provider: "openrouter", created: 1748995200 },
  { id: "meta-llama/llama-4-maverick",       provider: "openrouter", created: 1744934400 },
  { id: "meta-llama/llama-4-scout",          provider: "openrouter", created: 1744934400 },
  { id: "openai/gpt-5.6-sol",                       provider: "openrouter", created: 1754352000 },
  { id: "openai/gpt-5.6-sol-pro",                   provider: "openrouter", created: 1754352000 },
  { id: "openai/gpt-5.6-terra",                     provider: "openrouter", created: 1754352000 },
  { id: "openai/gpt-5.6-terra-pro",                 provider: "openrouter", created: 1754352000 },
  { id: "openai/gpt-5.6-luna",                      provider: "openrouter", created: 1754352000 },
  { id: "openai/gpt-5.6-luna-pro",                  provider: "openrouter", created: 1754352000 },
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
  { id: "deepseek/deepseek-v4-flash-0731",             provider: "openrouter", created: 1785024000 },
  { id: "deepseek/deepseek-v4-flash",                 provider: "openrouter", created: 1759276800 },
  { id: "deepseek/deepseek-v3.2",            provider: "openrouter", created: 1751328000 },
  { id: "deepseek/deepseek-r1",              provider: "openrouter", created: 1737158400 },
  { id: "deepseek/deepseek-r1-0528",         provider: "openrouter", created: 1748995200 },
  { id: "mistralai/mistral-small-2603",      provider: "openrouter", created: 1741392000 },
  { id: "meta/muse-spark-1.2",                provider: "openrouter", created: 1785959287 },
  { id: "qwen/qwen-image-3-pro",              provider: "openrouter", created: 1785959287 },
  { id: "qwen/qwen3.8-max",                  provider: "openrouter", created: 1785024000 },
  { id: "qwen/qwen3.7-max",                  provider: "openrouter", created: 1748390400 },
  { id: "qwen/qwen3.5-122b-a10b",            provider: "openrouter", created: 1751328000 },
  { id: "qwen/qwen3.6-max-preview",          provider: "openrouter", created: 1747267200 },
  { id: "stepfun/step-3.7-flash",            provider: "openrouter", created: 1748390400 },
  { id: "moonshotai/kimi-k3",                provider: "openrouter", created: 1752537600 },
  { id: "moonshotai/kimi-k2.7-code",         provider: "openrouter", created: 1749600000 },
  { id: "moonshotai/kimi-k2.6",              provider: "openrouter", created: 1747267200 },
  { id: "z-ai/glm-5.2",                      provider: "openrouter", created: 1750032000 },
  { id: "z-ai/glm-5.1",                      provider: "openrouter", created: 1747267200 },
  { id: "google/gemini-3.6-flash",            provider: "openrouter", created: 1756684800 },
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
  { id: "anthropic/claude-opus-5",                        provider: "openrouter", created: 1785024000 },
  { id: "anthropic/claude-opus-5-thinking",               provider: "openrouter", created: 1785024000 },
  { id: "anthropic/claude-opus-5-thinking-low",           provider: "openrouter", created: 1785024000 },
  { id: "anthropic/claude-opus-5-thinking-medium",        provider: "openrouter", created: 1785024000 },
  { id: "anthropic/claude-opus-5-thinking-high",          provider: "openrouter", created: 1785024000 },
  { id: "anthropic/claude-opus-5-thinking-xhigh",         provider: "openrouter", created: 1785024000 },
  { id: "anthropic/claude-opus-5-thinking-max",           provider: "openrouter", created: 1785024000 },
  { id: "anthropic/claude-sonnet-5",                     provider: "openrouter", created: 1782864000 },
  { id: "anthropic/claude-sonnet-5-thinking",            provider: "openrouter", created: 1782864000 },
  { id: "anthropic/claude-sonnet-5-thinking-low",        provider: "openrouter", created: 1782864000 },
  { id: "anthropic/claude-sonnet-5-thinking-medium",     provider: "openrouter", created: 1782864000 },
  { id: "anthropic/claude-sonnet-5-thinking-high",       provider: "openrouter", created: 1782864000 },
  { id: "anthropic/claude-sonnet-5-thinking-xhigh",      provider: "openrouter", created: 1782864000 },
  { id: "anthropic/claude-sonnet-5-thinking-max",        provider: "openrouter", created: 1782864000 },
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
  { id: "openai/gpt-image-2",                provider: "openrouter", created: 1745280000 },
  { id: "openai/gpt-5.4-image-2",            provider: "openrouter", created: 1751328000 },
  { id: "google/gemini-3.1-flash-image",     provider: "openrouter", created: 1753142400 },
  { id: "google/gemini-3-pro-image",         provider: "openrouter", created: 1751328000 },
  { id: "x-ai/grok-imagine-video-1.5",       provider: "openrouter", created: 1756684800 },
  { id: "x-ai/grok-imagine-image-quality",   provider: "openrouter", created: 1751328000 },
  { id: "bytedance-seed/seedream-4.5",       provider: "openrouter", created: 1747180800 },
  { id: "bytedance/seedance-2.0",            provider: "openrouter", created: 1747180800 },
  { id: "bytedance/seedance-2.0-fast",      provider: "openrouter", created: 1747180800 },
  { id: "kwaivgi/kling-v3.0-pro",            provider: "openrouter", created: 1747180800 },
  { id: "minimax/minimax-m3",               provider: "openrouter", created: 1781136000 },
  { id: "xiaomi/mimo-v2.5",                 provider: "openrouter", created: 1781136000 },
  { id: "tencent/hy3",                      provider: "openrouter", created: 1751328000 },
];

const DEFAULT_MODEL = "gpt-4.1-mini";

const DISABLED_MODELS_KEY = "disabled_models.json";
const CUSTOM_MODELS_KEY = "custom_models.json";

/** Upper bound on one add request, so a bad client can't blow up the kv row. */
export const MAX_CUSTOM_MODELS = 2000;

const BUILTIN_IDS = new Set(MODEL_REGISTRY.map((m) => m.id));

export function getDefaultModel(): string {
  return DEFAULT_MODEL;
}

export function resolveProvider(modelId: string): Provider | null {
  const entry = getModelRegistry().find((m) => m.id === modelId);
  if (entry) return entry.provider;
  if (modelId.includes("/")) return "openrouter";
  return null;
}

let _disabledModels: Set<string> | null = null;
let _customModels: ModelEntry[] | null = null;

function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as string[]).includes(value);
}

/** Coerce a persisted / client-supplied entry into a ModelEntry, or drop it. */
function sanitizeCustomModel(raw: unknown): ModelEntry | null {
  if (raw === null || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec["id"] === "string" ? rec["id"].trim() : "";
  if (!id || id.length > 200) return null;
  const created = typeof rec["created"] === "number" && Number.isFinite(rec["created"])
    ? Math.trunc(rec["created"])
    : 0;
  return {
    id,
    provider: isProvider(rec["provider"]) ? rec["provider"] : "openrouter",
    created,
  };
}

export async function initModels(): Promise<void> {
  const [disabled, custom] = await Promise.all([
    readJsonAsync<unknown>(DISABLED_MODELS_KEY, []),
    readJsonAsync<unknown>(CUSTOM_MODELS_KEY, []),
  ]);

  _disabledModels = new Set(
    Array.isArray(disabled) ? disabled.filter((id): id is string => typeof id === "string") : [],
  );

  const seen = new Set<string>();
  _customModels = (Array.isArray(custom) ? custom : [])
    .map(sanitizeCustomModel)
    .filter((m): m is ModelEntry => {
      // Drop anything that has since been promoted into the built-in registry.
      if (m === null || BUILTIN_IDS.has(m.id) || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
}

function loadDisabledModels(): Set<string> {
  if (_disabledModels === null) {
    _disabledModels = new Set();
  }
  return _disabledModels;
}

function loadCustomModels(): ModelEntry[] {
  if (_customModels === null) {
    _customModels = [];
  }
  return _customModels;
}

/** Models the operator added at runtime (e.g. pulled from OpenRouter). */
export function getCustomModels(): ModelEntry[] {
  return loadCustomModels().map((m) => ({ ...m }));
}

/** Built-in registry plus operator-added models. */
export function getModelRegistry(): ModelEntry[] {
  return [...MODEL_REGISTRY, ...loadCustomModels()];
}

export type SkipReason = "invalid-id" | "builtin" | "already-added" | "limit-reached";

export interface AddCustomModelsResult {
  added: ModelEntry[];
  skipped: Array<{ id: string; reason: SkipReason }>;
}

/**
 * Add models to the registry. Adding also clears the id from the disabled set,
 * so a freshly added model is immediately visible on `/v1/models`.
 */
export function addCustomModels(
  inputs: Array<{ id?: unknown; provider?: unknown; created?: unknown }>,
): AddCustomModelsResult {
  const custom = loadCustomModels();
  const existing = new Set(custom.map((m) => m.id));
  const disabled = loadDisabledModels();

  const added: ModelEntry[] = [];
  const skipped: AddCustomModelsResult["skipped"] = [];

  for (const input of inputs) {
    const entry = sanitizeCustomModel(input);
    const rawId = typeof input.id === "string" ? input.id.trim() : "";
    if (entry === null) {
      skipped.push({ id: rawId, reason: "invalid-id" });
      continue;
    }
    if (BUILTIN_IDS.has(entry.id)) {
      skipped.push({ id: entry.id, reason: "builtin" });
      continue;
    }
    if (existing.has(entry.id)) {
      skipped.push({ id: entry.id, reason: "already-added" });
      continue;
    }
    if (custom.length >= MAX_CUSTOM_MODELS) {
      skipped.push({ id: entry.id, reason: "limit-reached" });
      continue;
    }
    custom.push(entry);
    existing.add(entry.id);
    disabled.delete(entry.id);
    added.push(entry);
  }

  if (added.length > 0) {
    _customModels = custom;
    _disabledModels = disabled;
    writeJson(CUSTOM_MODELS_KEY, custom);
    writeJson(DISABLED_MODELS_KEY, Array.from(disabled));
  }

  return { added, skipped };
}

/** Remove an operator-added model. Built-in models can only be disabled. */
export function removeCustomModel(id: string): boolean {
  const custom = loadCustomModels();
  const idx = custom.findIndex((m) => m.id === id);
  if (idx === -1) return false;

  custom.splice(idx, 1);
  _customModels = custom;
  writeJson(CUSTOM_MODELS_KEY, custom);

  // Don't leave a stale disable flag behind for a later re-add.
  const disabled = loadDisabledModels();
  if (disabled.delete(id)) {
    _disabledModels = disabled;
    writeJson(DISABLED_MODELS_KEY, Array.from(disabled));
  }
  return true;
}

export function getDisabledModels(): string[] {
  return Array.from(loadDisabledModels());
}

export function isModelDisabled(id: string): boolean {
  return loadDisabledModels().has(id);
}

export function setDisabledModels(ids: string[]): void {
  _disabledModels = new Set(ids);
  writeJson(DISABLED_MODELS_KEY, ids);
}

export function patchModelDisabled(id: string, disabled: boolean): void {
  const set = loadDisabledModels();
  if (disabled) {
    set.add(id);
  } else {
    set.delete(id);
  }
  _disabledModels = set;
  writeJson(DISABLED_MODELS_KEY, Array.from(set));
}

export function getEnabledModels(): ModelEntry[] {
  const disabled = loadDisabledModels();
  return getModelRegistry().filter((m) => !disabled.has(m.id));
}

export function getAllModelsWithStatus(): Array<
  ModelEntry & { disabled: boolean; custom: boolean }
> {
  const disabled = loadDisabledModels();
  const customIds = new Set(loadCustomModels().map((m) => m.id));
  return getModelRegistry().map((m) => ({
    ...m,
    disabled: disabled.has(m.id),
    custom: customIds.has(m.id),
  }));
}
