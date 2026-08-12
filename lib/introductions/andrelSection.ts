/**
 * Structural partition of the member-facing suggested cards into the two Introductions-page
 * sections. Classification is STRUCTURAL — driven only by `introducedByAndrel` (which the page sets
 * from `pair_id IS NOT NULL`), never from match_reason or display text:
 *
 *   - "Introduced by Andrel"  → reciprocal pairs (introducedByAndrel === true)
 *   - "Recommended for you"   → ordinary/legacy suggestions (introducedByAndrel !== true, i.e. pair_id NULL)
 *
 * Each card lands in EXACTLY ONE bucket (no duplication, no loss). Within each section the first card
 * is featured and the rest follow. Pure + unit-tested so the render can rely on it.
 */
export interface IntroSectionCard {
  introducedByAndrel?: boolean
  [k: string]: unknown
}
export interface IntroSection<T> { featured: T | null; additional: T[] }
export interface IntroSections<T> { andrel: IntroSection<T>; ordinary: IntroSection<T> }

export function buildIntroSections<T extends IntroSectionCard>(items: T[]): IntroSections<T> {
  const list = items ?? []
  const andrel = list.filter((s) => s.introducedByAndrel === true)
  const ordinary = list.filter((s) => s.introducedByAndrel !== true)
  return {
    andrel: { featured: andrel[0] ?? null, additional: andrel.slice(1) },
    ordinary: { featured: ordinary[0] ?? null, additional: ordinary.slice(1) },
  }
}
