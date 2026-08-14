/**
 * Single source of truth for DeepSeek pricing and peak/off-peak classification.
 *
 * Prices are CNY per 1,000,000 tokens, effective 2026-08-17 00:00 Beijing time
 * (the post-increase peak/off-peak schedule). Source:
 * https://api-docs.deepseek.com/quick_start/pricing/
 *
 * To update after a price change: edit `PRICES`, then bump the package version.
 * Deliberately there is no settings UI or runtime configuration — this plugin is
 * a read-only, zero-state estimator.
 */

/** One billing tier: all three prices are CNY per 1M tokens. */
export interface PriceTier {
  /** Input tokens served from the prompt cache (缓存命中). */
  cacheHit: number
  /** Input tokens missing the cache (缓存未命中), including cache writes. */
  cacheMiss: number
  /** Output tokens (输出). */
  output: number
}

export interface ModelPricing {
  /** 空闲时段 (off-peak): half the peak price. */
  offPeak: PriceTier
  /** 高峰时段 (peak). */
  peak: PriceTier
}

export const PRICES: Readonly<Record<string, ModelPricing>> = {
  'deepseek-v4-flash': {
    offPeak: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
    peak: { cacheHit: 0.10, cacheMiss: 3.0, output: 9.0 },
  },
  'deepseek-v4-pro': {
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    peak: { cacheHit: 0.30, cacheMiss: 9.0, output: 27.0 },
  },
}

const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/** Peak hours (Beijing time): 09:00–12:00 and 14:00–18:00; everything else is off-peak. */
export function isPeak(epochMs: number): boolean {
  const d = new Date(epochMs + BEIJING_OFFSET_MS)
  const t = d.getUTCHours() + d.getUTCMinutes() / 60
  return (t >= 9 && t < 12) || (t >= 14 && t < 18)
}

/** Disjoint token buckets for one model call (harness TokenUsage convention). */
export interface TokenBuckets {
  /** Uncached input (cache miss). */
  inputTokens: number
  outputTokens: number
  /** Input served from cache (cache hit). */
  cacheReadTokens: number
  /** Input written to cache (billed as cache miss). */
  cacheWriteTokens: number
}

/**
 * Cost in CNY for one call's buckets under the given model and peak flag.
 * Returns `null` when the model has no pricing table — such tokens are tracked
 * as unpriced instead of silently mispriced.
 */
export function costOf(buckets: TokenBuckets, model: string | undefined, peak: boolean): number | null {
  const table = model === undefined ? undefined : PRICES[model]
  if (table === undefined) return null
  const tier = peak ? table.peak : table.offPeak
  const cacheMissTokens = buckets.inputTokens + buckets.cacheWriteTokens
  return (tier.cacheHit * buckets.cacheReadTokens + tier.cacheMiss * cacheMissTokens + tier.output * buckets.outputTokens) / 1_000_000
}
