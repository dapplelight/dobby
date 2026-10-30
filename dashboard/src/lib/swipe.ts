// Swipe on a phone row: right = the row's main action, left = decline. Pure, so a test can check the rule.
export const SWIPE_AT = 96 // px dragged before it counts

/** What a finished drag does: the action name, or null (too short, nothing offered, or reduced motion is on). */
export function swipeAction(dx: number, o: { offers: string[]; reduced: boolean }): "primary" | "decline" | null {
  if (o.reduced) return null
  if (dx >= SWIPE_AT) return "primary"
  if (dx <= -SWIPE_AT && o.offers.includes("decline")) return "decline"
  return null
}
