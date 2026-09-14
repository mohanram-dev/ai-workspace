import type { TokenUsage } from "./types";

interface PriceTier {
  /** Tier applies while prompt tokens are at or below this value. */
  maxInputTokens: number;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

/**
 * Published list prices (USD per 1M tokens, paid tier). Estimates only:
 * cached-input discounts, audio pricing and free-tier usage are not modelled.
 * Models without an entry report a null cost rather than a guess.
 */
const PRICING: Record<string, Record<string, PriceTier[]>> = {
  gemini: {
    "gemini-2.5-pro": [
      { maxInputTokens: 200_000, inputPerMillionUsd: 1.25, outputPerMillionUsd: 10 },
      { maxInputTokens: Number.POSITIVE_INFINITY, inputPerMillionUsd: 2.5, outputPerMillionUsd: 15 },
    ],
    "gemini-2.5-flash": [
      { maxInputTokens: Number.POSITIVE_INFINITY, inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 },
    ],
    "gemini-2.5-flash-lite": [
      { maxInputTokens: Number.POSITIVE_INFINITY, inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 },
    ],
    // Text/image/video input rates (ai.google.dev/gemini-api/docs/pricing, checked 2026-09-13).
    "gemini-3.1-flash-lite": [
      { maxInputTokens: Number.POSITIVE_INFINITY, inputPerMillionUsd: 0.25, outputPerMillionUsd: 1.5 },
    ],
    "gemini-3.5-flash-lite": [
      { maxInputTokens: Number.POSITIVE_INFINITY, inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 },
    ],
  },
};

export function estimateCostUsd(provider: string, model: string, usage: TokenUsage): number | null {
  const tiers = PRICING[provider]?.[model];
  if (!tiers) return null;
  const tier = tiers.find((t) => usage.inputTokens <= t.maxInputTokens) ?? tiers[tiers.length - 1];
  if (!tier) return null;
  const cost =
    (usage.inputTokens * tier.inputPerMillionUsd + usage.outputTokens * tier.outputPerMillionUsd) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
