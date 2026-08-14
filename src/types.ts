/** Client-safe vocabulary for the `usageCost` session projection. */

import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'

/** The four disjoint provider-reported token buckets. */
export interface TokenBucketCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Cumulative cost for one model id. */
export interface UsageCostByModel extends TokenBucketCounts {
  costCny: number
  peakCostCny: number
  offPeakCostCny: number
}

/** Whole-session cumulative cost: the value served under the `usageCost` projection key. */
export interface UsageCostProjection extends TokenBucketCounts {
  costCny: number
  peakCostCny: number
  offPeakCostCny: number
  byModel: Record<string, UsageCostByModel>
  /** Tokens from models without a pricing table (not counted in `costCny`). */
  unpricedTokens: TokenBucketCounts
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    usageCost: UsageCostProjection
  }
}
