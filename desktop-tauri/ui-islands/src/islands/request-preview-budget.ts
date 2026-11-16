// Limit DOM/Markdown amplification on small devices; original bodies remain available to copy.
export const PREVIEW_LIMIT = 256 * 1024
export function exceedsPreviewBudget(value: unknown): boolean {
  let remaining = PREVIEW_LIMIT
  const visit = (item: unknown): boolean => {
    if (--remaining < 0) return true
    if (typeof item === 'string') remaining -= item.length
    else if (Array.isArray(item)) { for (const child of item) if (visit(child)) return true }
    else if (item && typeof item === 'object') {
      for (const key of Object.keys(item)) {
        remaining -= key.length
        if (visit((item as Record<string, unknown>)[key])) return true
      }
    }
    return remaining < 0
  }
  return visit(value)
}
