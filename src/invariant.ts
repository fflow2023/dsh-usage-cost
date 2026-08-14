/**
 * Companion plugin for the package-owned runtime-invariant registry.
 *
 * Optional: loaded only when `@deepseek-ai/dsh-invariants` is mounted.
 */

import type { Context } from '@deepseek-ai/cordis'

export const inject = ['invariants'] as const

export function apply(ctx: Context): void {
  // No runtime invariant: the `usageCost` projection folds provider-reported
  // usage from the authoritative session log (assistant/chunk usage and
  // assistant/message), so this package owns no additional mutable state or
  // event/data relation beyond the projection registry's own replay guarantee.
  ctx.invariants.register('dsh-usage-cost', () => {})
}
