/**
 * Host half: registers the `usageCost` session projection.
 *
 * One pure, O(1) fold driven by the existing `session/event` feed — no extra
 * subscription, timer, polling, RPC, or durable state of its own. Every figure
 * replays from the durable log, so restart and cold reads recover it.
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { costOf, isPeak, type TokenBuckets } from './pricing.ts'
import type { TokenBucketCounts, UsageCostByModel, UsageCostProjection } from './types.ts'

export const name = 'usage-cost'
export const inject = ['sessionProjections'] as const

interface Totals extends TokenBucketCounts {
  costCny: number
  peakCostCny: number
  offPeakCostCny: number
}

interface Sample {
  turn: number
  step: number
  buckets: TokenBuckets
  costCny: number | null
  model: string | undefined
  peak: boolean
}

interface State {
  lastModel: string | undefined
  lastRequestTime: number | undefined
  last: Sample | null
  totals: Totals
  byModel: Record<string, Totals>
  unpricedTokens: TokenBucketCounts
}

function zeroTotals(): Totals {
  return { costCny: 0, peakCostCny: 0, offPeakCostCny: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function zeroBuckets(): TokenBucketCounts {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function bucketsOf(usage: TokenUsage): TokenBuckets {
  return {
    inputTokens: usage.inputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    cacheReadTokens: usage.cacheReadTokens || 0,
    cacheWriteTokens: usage.cacheWriteTokens || 0,
  }
}

function shiftTotals(t: Totals, s: Sample, sign: 1 | -1): Totals {
  const c = s.costCny === null ? 0 : s.costCny
  return {
    costCny: t.costCny + sign * c,
    peakCostCny: t.peakCostCny + sign * (s.peak ? c : 0),
    offPeakCostCny: t.offPeakCostCny + sign * (s.peak ? 0 : c),
    inputTokens: t.inputTokens + sign * s.buckets.inputTokens,
    outputTokens: t.outputTokens + sign * s.buckets.outputTokens,
    cacheReadTokens: t.cacheReadTokens + sign * s.buckets.cacheReadTokens,
    cacheWriteTokens: t.cacheWriteTokens + sign * s.buckets.cacheWriteTokens,
  }
}

function shiftBuckets(b: TokenBucketCounts, s: Sample, sign: 1 | -1): TokenBucketCounts {
  return {
    inputTokens: b.inputTokens + sign * s.buckets.inputTokens,
    outputTokens: b.outputTokens + sign * s.buckets.outputTokens,
    cacheReadTokens: b.cacheReadTokens + sign * s.buckets.cacheReadTokens,
    cacheWriteTokens: b.cacheWriteTokens + sign * s.buckets.cacheWriteTokens,
  }
}

function shiftByModel(byModel: Record<string, Totals>, s: Sample, sign: 1 | -1): Record<string, Totals> {
  if (s.model === undefined || s.costCny === null) return byModel
  const next = { ...byModel }
  next[s.model] = shiftTotals(next[s.model] ?? zeroTotals(), s, sign)
  return next
}

function bucketsEqual(a: TokenBuckets, b: TokenBuckets): boolean {
  return a.inputTokens === b.inputTokens
    && a.outputTokens === b.outputTokens
    && a.cacheReadTokens === b.cacheReadTokens
    && a.cacheWriteTokens === b.cacheWriteTokens
}

/** Extract the model id from an assistant message's provenance, falling back safely. */
function modelOf(message: { source?: { model?: unknown } } | undefined, fallback: string | undefined): string | undefined {
  const model = message?.source?.model
  return typeof model === 'string' ? model : fallback
}

const bucketCountsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
})

const byModelSchema = bucketCountsSchema.extend({
  costCny: z.number(),
  peakCostCny: z.number(),
  offPeakCostCny: z.number(),
})

const projectionSchema = bucketCountsSchema.extend({
  costCny: z.number(),
  peakCostCny: z.number(),
  offPeakCostCny: z.number(),
  byModel: z.record(z.string(), byModelSchema),
  unpricedTokens: bucketCountsSchema,
}) as z.ZodType<UsageCostProjection>

const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000

function roundTotals(t: Totals): UsageCostByModel {
  return {
    costCny: round6(t.costCny),
    peakCostCny: round6(t.peakCostCny),
    offPeakCostCny: round6(t.offPeakCostCny),
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheWriteTokens: t.cacheWriteTokens,
  }
}

export function apply(ctx: Context): void {
  const definition: ProjectionDefinition<'usageCost', State> = {
    key: 'usageCost',
    schema: projectionSchema,
    stateVersion: 1,
    init: (): State => ({
      lastModel: undefined,
      lastRequestTime: undefined,
      last: null,
      totals: zeroTotals(),
      byModel: {},
      unpricedTokens: zeroBuckets(),
    }),
    apply: (state, event: SessionEvent) => {
      if (event.type === 'request/header') {
        const model = event.data.header.config.model
        if (model === undefined) return state
        if (model !== state.lastModel || event.time !== state.lastRequestTime) {
          return { ...state, lastModel: model, lastRequestTime: event.time }
        }
        return state
      }

      let turn: number
      let step: number
      let usage: TokenUsage
      let model: string | undefined
      if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
        turn = event.data.turn
        step = event.data.step
        usage = event.data.chunk.usage
        model = state.lastModel
      } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
        turn = event.data.turn
        step = event.data.step
        usage = event.data.usage
        model = modelOf(event.data.message, state.lastModel)
      } else {
        return state
      }

      const buckets = bucketsOf(usage)
      const peak = isPeak(state.lastRequestTime ?? event.time)
      const sample: Sample = { turn, step, buckets, costCny: costOf(buckets, model, peak), model, peak }

      const previous = state.last !== null && state.last.turn === turn && state.last.step === step
        ? state.last
        : null
      if (previous !== null && bucketsEqual(previous.buckets, buckets) && previous.model === model && previous.peak === peak) {
        return state
      }

      let totals = state.totals
      let byModel = state.byModel
      let unpricedTokens = state.unpricedTokens
      if (previous !== null) {
        totals = shiftTotals(totals, previous, -1)
        byModel = shiftByModel(byModel, previous, -1)
        if (previous.costCny === null) unpricedTokens = shiftBuckets(unpricedTokens, previous, -1)
      }
      totals = shiftTotals(totals, sample, 1)
      byModel = shiftByModel(byModel, sample, 1)
      if (sample.costCny === null) unpricedTokens = shiftBuckets(unpricedTokens, sample, 1)

      return { ...state, last: sample, totals, byModel, unpricedTokens }
    },
    view: (state): UsageCostProjection => {
      const byModel: Record<string, UsageCostByModel> = {}
      for (const [m, t] of Object.entries(state.byModel)) byModel[m] = roundTotals(t)
      return {
        ...roundTotals(state.totals),
        byModel,
        unpricedTokens: { ...state.unpricedTokens },
      }
    },
  }

  ctx.effect(() => ctx.sessionProjections.register(definition))
}
