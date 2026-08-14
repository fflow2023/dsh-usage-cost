/**
 * dsh-usage-cost — host half.
 *
 * Registers the `usageCost` session projection: one pure, O(1) fold driven by
 * the existing `session/event` feed. No extra subscription, timer, polling,
 * RPC, or durable state of its own; every figure replays from the durable log.
 *
 * Prices are CNY per 1M tokens, effective 2026-08-17 (post-increase peak/off-
 * peak schedule). Source: https://api-docs.deepseek.com/quick_start/pricing/
 * To update after a price change: edit PRICES and bump the package version.
 */

export const name = 'usage-cost'
export const inject = ['sessionProjections']

// Peak (高峰) = Beijing time 09:00–12:00 and 14:00–18:00; the rest is off-peak (空闲, half price).
const PRICES = {
  'deepseek-v4-flash': {
    offPeak: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
    peak: { cacheHit: 0.10, cacheMiss: 3.0, output: 9.0 },
  },
  'deepseek-v4-pro': {
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    peak: { cacheHit: 0.30, cacheMiss: 9.0, output: 27.0 },
  },
}

const BEIJING_MS = 8 * 3600 * 1000

function isPeak(epochMs) {
  const d = new Date(epochMs + BEIJING_MS)
  const t = d.getUTCHours() + d.getUTCMinutes() / 60
  return (t >= 9 && t < 12) || (t >= 14 && t < 18)
}

function bucketsOf(usage) {
  return {
    inputTokens: usage.inputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    cacheReadTokens: usage.cacheReadTokens || 0,
    cacheWriteTokens: usage.cacheWriteTokens || 0,
  }
}

// Returns CNY cost, or null when the model has no pricing table (tokens are
// then tracked as unpriced rather than silently mispriced).
function costOf(buckets, model, peak) {
  const table = model === undefined ? undefined : PRICES[model]
  if (table === undefined) return null
  const p = peak ? table.peak : table.offPeak
  const miss = buckets.inputTokens + buckets.cacheWriteTokens
  return (p.cacheHit * buckets.cacheReadTokens + p.cacheMiss * miss + p.output * buckets.outputTokens) / 1_000_000
}

function zeroTotals() {
  return { costCny: 0, peakCostCny: 0, offPeakCostCny: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function zeroBuckets() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function shiftTotals(t, s, sign) {
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

function shiftBuckets(b, s, sign) {
  return {
    inputTokens: b.inputTokens + sign * s.buckets.inputTokens,
    outputTokens: b.outputTokens + sign * s.buckets.outputTokens,
    cacheReadTokens: b.cacheReadTokens + sign * s.buckets.cacheReadTokens,
    cacheWriteTokens: b.cacheWriteTokens + sign * s.buckets.cacheWriteTokens,
  }
}

function shiftByModel(byModel, s, sign) {
  if (s.model === undefined || s.costCny === null) return byModel
  const next = Object.assign({}, byModel)
  const prev = next[s.model] || zeroTotals()
  next[s.model] = shiftTotals(prev, s, sign)
  return next
}

function bucketsEqual(a, b) {
  return a.inputTokens === b.inputTokens
    && a.outputTokens === b.outputTokens
    && a.cacheReadTokens === b.cacheReadTokens
    && a.cacheWriteTokens === b.cacheWriteTokens
}

function round6(n) {
  return Math.round(n * 1_000_000) / 1_000_000
}

export function apply(ctx) {
  const definition = {
    key: 'usageCost',
    schema: { parse: (value) => value },
    stateVersion: 1,
    init: () => ({
      lastModel: undefined,
      lastRequestTime: undefined,
      last: null,
      totals: zeroTotals(),
      byModel: {},
      unpricedTokens: zeroBuckets(),
    }),
    apply: (state, event) => {
      if (event.type === 'request/header') {
        const cfg = event.data && event.data.header ? event.data.header.config : undefined
        const model = cfg ? cfg.model : undefined
        if (model === undefined) return state
        if (model !== state.lastModel || event.time !== state.lastRequestTime) {
          return { ...state, lastModel: model, lastRequestTime: event.time }
        }
        return state
      }

      let turn, step, usage, model
      if (event.type === 'assistant/chunk' && event.data && event.data.chunk && event.data.chunk.type === 'usage') {
        turn = event.data.turn; step = event.data.step; usage = event.data.chunk.usage; model = state.lastModel
      } else if (event.type === 'assistant/message' && event.data && event.data.usage !== undefined) {
        turn = event.data.turn; step = event.data.step; usage = event.data.usage
        const source = event.data.message && event.data.message.source
        model = (source && typeof source.model === 'string' ? source.model : undefined) || state.lastModel
      } else {
        return state
      }

      const buckets = bucketsOf(usage)
      const peak = isPeak(state.lastRequestTime !== undefined ? state.lastRequestTime : event.time)
      const sample = { turn, step, buckets, costCny: costOf(buckets, model, peak), model, peak }

      const previous = state.last && state.last.turn === turn && state.last.step === step ? state.last : null
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
    view: (state) => {
      const byModel = {}
      for (const m of Object.keys(state.byModel)) {
        const t = state.byModel[m]
        byModel[m] = {
          costCny: round6(t.costCny),
          peakCostCny: round6(t.peakCostCny),
          offPeakCostCny: round6(t.offPeakCostCny),
          inputTokens: t.inputTokens,
          outputTokens: t.outputTokens,
          cacheReadTokens: t.cacheReadTokens,
          cacheWriteTokens: t.cacheWriteTokens,
        }
      }
      return {
        costCny: round6(state.totals.costCny),
        peakCostCny: round6(state.totals.peakCostCny),
        offPeakCostCny: round6(state.totals.offPeakCostCny),
        inputTokens: state.totals.inputTokens,
        outputTokens: state.totals.outputTokens,
        cacheReadTokens: state.totals.cacheReadTokens,
        cacheWriteTokens: state.totals.cacheWriteTokens,
        byModel,
        unpricedTokens: state.unpricedTokens,
      }
    },
  }

  ctx.effect(() => ctx.sessionProjections.register(definition))
}
