/**
 * Client half: two additive UI surfaces, no stores, no subscriptions, no
 * side effects.
 *
 * 1. Replaces the shipped `stats` dock entry so the cumulative cost sits on the
 *    SAME line as the token stats (experience-first integration; see README for
 *    the coupling caveat).
 * 2. Adds a `费用统计` settings section with the global cumulative cost.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { UsageCostProjection } from '../types.ts'

export const inject = ['slots'] as const

/* ---- minimal prop types (the exact share types come from dsh-client-ui-slots) ---- */

interface ProjectionSeat {
  useProjection: (key: string) => unknown
  t: (key: string, params?: Record<string, string | number>) => string
}

interface SessionListSeat {
  useSessions: <R>(selector: (state: SessionListLike) => R) => R
}

/* ---- loose mirrors of the projection values this plugin reads ---- */

interface TokenUsageLike {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface SessionStatsLike {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

interface SessionSummaryLike {
  id: string
  displayTitle?: string
  projectionValues?: { usageCost?: UsageCostProjection }
}

interface SessionListLike {
  ids: string[]
  byId: Record<string, SessionSummaryLike>
}

/* ---- formatting helpers ---- */

function formatCny(n: number): string {
  const v = Number.isFinite(n) ? n : 0
  if (v === 0) return '¥0.00'
  if (v < 0.01) return `¥${v.toFixed(4)}`
  return `¥${v.toFixed(2)}`
}

function formatTokens(n: number): string {
  const scaled = (v: number): string => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1000)}K`
  return `${scaled(n / 1_000_000)}M`
}

function formatDuration(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

function billedInputTokens(usage: TokenUsageLike): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

function cacheHitPercent(usage: TokenUsageLike): number | null {
  const denominator = billedInputTokens(usage)
  return denominator === 0 ? null : Math.round(usage.cacheReadTokens / denominator * 100)
}

function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? n : 0
  if (v < 1000) return String(v)
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}K`
  return `${(v / 1_000_000).toFixed(1)}M`
}

function modelName(id: string): string {
  return id === 'deepseek-v4-pro' ? 'V4 Pro' : id === 'deepseek-v4-flash' ? 'V4 Flash' : id
}

const rootStyle: React.CSSProperties = {
  display: 'block',
  textAlign: 'center',
  maxWidth: 'var(--dsh-chat-content-width)',
  width: '100%',
  margin: '0 auto',
  boxSizing: 'border-box',
  padding: '4px calc(var(--dsh-composer-side-clearance) + 16px) 0px',
  fontSize: '12px',
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-tertiary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const sepStyle: React.CSSProperties = { color: 'var(--dsw-alias-separator-primary)', margin: '0 10px' }

/* ---- per-session cost, inline with the token stats ---- */

function StatsWithCost(props: ProjectionSeat): JSX.Element | null {
  const usage = props.useProjection('tokenUsage') as TokenUsageLike | undefined
  const stats = props.useProjection('sessionStats') as SessionStatsLike | undefined
  const cost = props.useProjection('usageCost') as UsageCostProjection | undefined
  const t = props.t

  const groups: string[] = []
  if (stats !== undefined && stats.steps > 0) {
    groups.push(t('stats.counts', { turns: stats.turns, steps: stats.steps }))
    const durations: string[] = []
    if (stats.llmMs > 0) durations.push(t('stats.llm', { duration: formatDuration(stats.llmMs) }))
    if (stats.toolMs > 0) durations.push(t('stats.toolCall', { duration: formatDuration(stats.toolMs) }))
    if (durations.length > 0) groups.push(durations.join(' · '))
    const speeds: string[] = []
    if (stats.ttftSteps > 0) speeds.push(t('stats.ttftAverage', { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }))
    if (stats.decodeMs > 0) speeds.push(t('stats.tokensPerSecond', { throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1000)) }))
    if (speeds.length > 0) groups.push(speeds.join(' · '))
  }
  if (usage !== undefined && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
    const cacheHit = cacheHitPercent(usage)
    if (cacheHit !== null) groups.push(t('stats.cacheHit', { percent: cacheHit }))
    groups.push(t('stats.tokens', { input: formatTokens(billedInputTokens(usage)), output: formatTokens(usage.outputTokens) }))
  }
  if (cost !== undefined && typeof cost.costCny === 'number') {
    let text = formatCny(cost.costCny)
    if (cost.peakCostCny > 0 && cost.offPeakCostCny > 0) {
      text += `（高峰 ${formatCny(cost.peakCostCny)} / 闲时 ${formatCny(cost.offPeakCostCny)}）`
    }
    groups.push(`费用 ${text}`)
  }
  if (groups.length === 0) return null

  const children: React.ReactNode[] = []
  for (let i = 0; i < groups.length; i++) {
    if (i > 0) {
      children.push(<span key={`s${i}`} style={sepStyle} aria-hidden="true">|</span>)
      children.push(' ')
    }
    children.push(<span key={`g${i}`}>{groups[i]}</span>)
  }

  return <div style={rootStyle} title={groups.join(' | ')}>{children}</div>
}

/* ---- global cumulative cost in Settings ---- */

function GlobalCost(props: SessionListSeat): JSX.Element {
  const sessions = props.useSessions((s) => s)

  const rows: { title: string; costCny: number }[] = []
  let totalCny = 0
  let totalPeak = 0
  let totalOffPeak = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  const byModel: Record<string, number> = {}

  const ids = sessions?.ids ?? Object.keys(sessions?.byId ?? {})
  for (const id of ids) {
    const entry = sessions.byId[id]
    if (entry === undefined) continue
    const cost = entry.projectionValues?.usageCost
    if (cost === undefined || typeof cost.costCny !== 'number') continue
    totalCny += cost.costCny || 0
    totalPeak += cost.peakCostCny || 0
    totalOffPeak += cost.offPeakCostCny || 0
    totalInput += (cost.inputTokens || 0) + (cost.cacheReadTokens || 0) + (cost.cacheWriteTokens || 0)
    totalOutput += cost.outputTokens || 0
    totalCacheRead += cost.cacheReadTokens || 0
    for (const [m, t] of Object.entries(cost.byModel ?? {})) {
      byModel[m] = (byModel[m] ?? 0) + (t.costCny || 0)
    }
    rows.push({ title: entry.displayTitle || entry.id, costCny: cost.costCny || 0 })
  }
  rows.sort((a, b) => b.costCny - a.costCny)

  const muted: React.CSSProperties = { color: 'rgba(128,128,128,0.9)', fontSize: '12px' }
  const subHead: React.CSSProperties = { marginTop: '16px', fontSize: '13px', fontWeight: 600 }
  const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: '13px' }

  return (
    <div style={{ padding: '16px', maxWidth: '760px' }}>
      <h2 style={{ margin: '0 0 12px', fontSize: '16px' }}>累计费用</h2>
      <div style={{ fontSize: '24px', fontWeight: 700 }}>{formatCny(totalCny)}</div>
      <div style={muted}>高峰 {formatCny(totalPeak)} · 闲时 {formatCny(totalOffPeak)}</div>
      <div style={muted}>计费输入 {fmtTokens(totalInput)} · 输出 {fmtTokens(totalOutput)} · 缓存命中 {fmtTokens(totalCacheRead)}</div>

      {Object.keys(byModel).length > 0 && (
        <>
          <div style={subHead}>按模型</div>
          {Object.entries(byModel).map(([m, c], i) => (
            <div key={`m${i}`} style={rowStyle}>
              <span>{modelName(m)}</span>
              <span>{formatCny(c)}</span>
            </div>
          ))}
        </>
      )}

      {rows.length > 0 ? (
        <>
          <div style={subHead}>按会话（费用降序）</div>
          {rows.slice(0, 60).map((r, i) => (
            <div key={`r${i}`} style={{ ...rowStyle, borderBottom: '1px solid rgba(128,128,128,0.15)' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{r.title}</span>
              <span>{formatCny(r.costCny)}</span>
            </div>
          ))}
          {rows.length > 60 && <div style={muted}>… 另有 {rows.length - 60} 个会话未列出</div>}
        </>
      ) : (
        <div style={muted}>暂无可计费数据。费用自本插件启用后按会话累计，仅统计 deepseek-v4-pro 与 deepseek-v4-flash（按 2026-08-17 峰谷价）。</div>
      )}
    </div>
  )
}

/* ---- registration ---- */

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'stats', order: 0, locale: 'conversation' },
    StatsWithCost,
  ))
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'usage-cost', order: 50, label: '费用统计' },
    GlobalCost,
  ))
}
