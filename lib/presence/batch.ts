// Batching plan for the coarse-label endpoint: dedupe visible member ids (a card and the
// modal/header can request the same member) and chunk them so no request exceeds the
// endpoint's max id count. Preserves first-seen order; drops falsy ids. Pure + unit-tested.

export function planPresenceBatches(ids: Array<string | null | undefined>, max: number): string[][] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const id of ids) {
    if (!id) continue
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(id)
  }
  const size = Math.max(1, max)
  const batches: string[][] = []
  for (let i = 0; i < unique.length; i += size) batches.push(unique.slice(i, i + size))
  return batches
}
