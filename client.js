/**
 * dsh-usage-cost — browser half.
 *
 * Lazy CJS client bundle: executing this file only REGISTERS the factory via
 * `window.__ModuleLoader__.load`; the plugin body (apply/inject) runs later at
 * materialization, with react resolved through the injected `require`.
 *
 * Two additive UI surfaces, no stores, no subscriptions, no side effects:
 *  1. Replaces the shipped `stats` dock entry so the cumulative cost sits on
 *     the SAME line as the token stats.
 *  2. Adds a `费用统计` settings section with the global cumulative cost.
 */

window.__ModuleLoader__.load({
  id: '@fflow2023/dsh-usage-cost',
  factory: (require) => {
    const { createElement } = require('react')

    function formatCny(n) {
      const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
      if (v === 0) return '¥0.00'
      if (v < 0.01) return '¥' + v.toFixed(4)
      return '¥' + v.toFixed(2)
    }

    function formatTokens(n) {
      const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
      if (n < 1000) return String(n)
      if (n < 1000000) return scaled(n / 1000) + 'K'
      return scaled(n / 1000000) + 'M'
    }

    function formatDuration(ms) {
      const s = ms / 1000
      if (s < 60) return String(Math.round(s * 10) / 10) + 's'
      const whole = Math.round(s)
      return Math.floor(whole / 60) + 'm' + (whole % 60) + 's'
    }

    function formatTokensPerSecond(tps) {
      const clamped = Math.max(0, tps)
      return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
    }

    function billedInputTokens(usage) {
      return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    }

    function cacheHitPercent(usage) {
      const denominator = billedInputTokens(usage)
      return denominator === 0 ? null : Math.round((usage.cacheReadTokens / denominator) * 100)
    }

    function fmtTokens(n) {
      const v = typeof n === 'number' && Number.isFinite(n) ? n : 0
      if (v < 1000) return String(v)
      if (v < 1000000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + 'K'
      return (v / 1000000).toFixed(1) + 'M'
    }

    function modelName(id) {
      return id === 'deepseek-v4-pro' ? 'V4 Pro' : id === 'deepseek-v4-flash' ? 'V4 Flash' : String(id)
    }

    const rootStyle = {
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

    const sepStyle = { color: 'var(--dsw-alias-separator-primary)', margin: '0 10px' }

    // Per-session cost, inline with the shipped token stats line.
    function StatsWithCost(props) {
      const usage = props.useProjection('tokenUsage')
      const stats = props.useProjection('sessionStats')
      const cost = props.useProjection('usageCost')
      const t = props.t

      const groups = []
      if (stats !== undefined && stats.steps > 0) {
        groups.push(t('stats.counts', { turns: stats.turns, steps: stats.steps }))
        const durations = []
        if (stats.llmMs > 0) durations.push(t('stats.llm', { duration: formatDuration(stats.llmMs) }))
        if (stats.toolMs > 0) durations.push(t('stats.toolCall', { duration: formatDuration(stats.toolMs) }))
        if (durations.length > 0) groups.push(durations.join(' · '))
        const speeds = []
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
          text += '（高峰 ' + formatCny(cost.peakCostCny) + ' / 闲时 ' + formatCny(cost.offPeakCostCny) + '）'
        }
        groups.push('费用 ' + text)
      }
      if (groups.length === 0) return null

      const children = []
      for (let i = 0; i < groups.length; i++) {
        if (i > 0) {
          children.push(createElement('span', { key: 's' + i, style: sepStyle, 'aria-hidden': 'true' }, '|'))
          children.push(' ')
        }
        children.push(createElement('span', { key: 'g' + i }, groups[i]))
      }
      return createElement('div', { style: rootStyle, title: groups.join(' | ') }, children)
    }

    // Global cumulative cost in Settings.
    function GlobalCost(props) {
      const sessions = props.useSessions((s) => s)

      const rows = []
      let totalCny = 0
      let totalPeak = 0
      let totalOffPeak = 0
      let totalInput = 0
      let totalOutput = 0
      let totalCacheRead = 0
      const byModel = {}

      const byId = sessions !== undefined && sessions.byId !== undefined ? sessions.byId : {}
      const ids = sessions !== undefined && sessions.ids !== undefined ? sessions.ids : Object.keys(byId)
      for (const id of ids) {
        const entry = byId[id]
        if (entry === undefined) continue
        const cost = entry.projectionValues !== undefined ? entry.projectionValues.usageCost : undefined
        if (cost === undefined || typeof cost.costCny !== 'number') continue
        totalCny += cost.costCny || 0
        totalPeak += cost.peakCostCny || 0
        totalOffPeak += cost.offPeakCostCny || 0
        totalInput += (cost.inputTokens || 0) + (cost.cacheReadTokens || 0) + (cost.cacheWriteTokens || 0)
        totalOutput += cost.outputTokens || 0
        totalCacheRead += cost.cacheReadTokens || 0
        for (const m of Object.keys(cost.byModel || {})) {
          byModel[m] = (byModel[m] || 0) + (cost.byModel[m].costCny || 0)
        }
        rows.push({ title: entry.displayTitle || entry.id, costCny: cost.costCny || 0 })
      }
      rows.sort((a, b) => b.costCny - a.costCny)

      const muted = { color: 'rgba(128,128,128,0.9)', fontSize: '12px' }
      const subHead = { marginTop: '16px', fontSize: '13px', fontWeight: 600 }
      const rowStyle = { display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: '13px' }

      const children = []
      children.push(createElement('h2', { key: 'h', style: { margin: '0 0 12px', fontSize: '16px' } }, '累计费用'))
      children.push(createElement('div', { key: 'big', style: { fontSize: '24px', fontWeight: 700 } }, formatCny(totalCny)))
      children.push(createElement('div', { key: 'split', style: muted }, '高峰 ' + formatCny(totalPeak) + ' · 闲时 ' + formatCny(totalOffPeak)))
      children.push(createElement('div', { key: 'tokens', style: muted }, '计费输入 ' + fmtTokens(totalInput) + ' · 输出 ' + fmtTokens(totalOutput) + ' · 缓存命中 ' + fmtTokens(totalCacheRead)))

      const modelKeys = Object.keys(byModel)
      if (modelKeys.length > 0) {
        children.push(createElement('div', { key: 'mh', style: subHead }, '按模型'))
        for (let i = 0; i < modelKeys.length; i++) {
          const m = modelKeys[i]
          children.push(createElement('div', { key: 'm' + i, style: rowStyle },
            createElement('span', null, modelName(m)),
            createElement('span', null, formatCny(byModel[m])),
          ))
        }
      }

      if (rows.length > 0) {
        children.push(createElement('div', { key: 'sh', style: subHead }, '按会话（费用降序）'))
        const shown = rows.slice(0, 60)
        for (let i = 0; i < shown.length; i++) {
          children.push(createElement('div', { key: 'r' + i, style: Object.assign({}, rowStyle, { borderBottom: '1px solid rgba(128,128,128,0.15)' }) },
            createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' } }, shown[i].title),
            createElement('span', null, formatCny(shown[i].costCny)),
          ))
        }
        if (rows.length > 60) {
          children.push(createElement('div', { key: 'more', style: muted }, '… 另有 ' + (rows.length - 60) + ' 个会话未列出'))
        }
      } else {
        children.push(createElement('div', { key: 'empty', style: muted }, '暂无可计费数据。费用自本插件启用后按会话累计，仅统计 deepseek-v4-pro 与 deepseek-v4-flash（按 2026-08-17 峰谷价）。'))
      }

      return createElement('div', { style: { padding: '16px', maxWidth: '760px' } }, children)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'stats', order: 0, locale: 'conversation' },
          StatsWithCost,
        ))
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'usage-cost', order: 50, label: '费用统计' },
          GlobalCost,
        ))
      },
    }
  },
})
