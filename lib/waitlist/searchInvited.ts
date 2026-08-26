/**
 * Search over the ALREADY-LOADED invited waitlist. Pure, synchronous, and deliberately small.
 *
 * IT NEVER TALKS TO THE SERVER. The admin page already ships the whole waitlist to the client, so
 * filtering is an array operation on data the operator is looking at. There is no request per
 * keystroke, no debounce to tune, and no way for typing to write anything — which is also why this
 * module contains no fetch, no client, and no id-to-row lookup: callers filter the real entry
 * objects and keep operating on those, so a row action after filtering still targets the same
 * waitlist row it always did.
 *
 * MATCHING RULE. The query is lowercased, trimmed, and split on any run of whitespace. An entry
 * matches when EVERY token appears somewhere in its name or email. Token-AND is what makes
 * "doug  smith" (two spaces) and "SMITH doug" both find Doug Smith, and it degrades to plain
 * substring search for a single token, which is what an operator typing an email fragment expects.
 *
 * PRIVACY. Email is matched in memory on a page that is already admin-gated; nothing here logs,
 * serialises, or transmits an address.
 */

/** The two fields an operator searches by. Anything else is deliberately out of scope. */
export interface SearchableWaitlistEntry {
  full_name?: string | null
  email?: string | null
}

/** Lowercase, trim, collapse internal whitespace. '' when the query is only spaces. */
export function normalizeSearchQuery(raw: string | null | undefined): string {
  return (raw ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
}

/** The tokens a normalized query searches for. Empty array ⇒ match everything. */
export function searchTokens(raw: string | null | undefined): string[] {
  const n = normalizeSearchQuery(raw)
  return n ? n.split(' ') : []
}

/** One entry's haystack: name and email, lowercased, separated so tokens cannot span the two. */
function haystack(entry: SearchableWaitlistEntry): string {
  return `${(entry.full_name ?? '').toLowerCase()} ${(entry.email ?? '').toLowerCase()}`
}

/** True when every token appears in the entry's name or email. An empty query matches all. */
export function matchesInvitedSearch(entry: SearchableWaitlistEntry, raw: string | null | undefined): boolean {
  const tokens = searchTokens(raw)
  if (tokens.length === 0) return true
  const hay = haystack(entry)
  return tokens.every((t) => hay.includes(t))
}

/**
 * Filter, preserving input order EXACTLY. An empty query returns the same array contents in the
 * same sequence, so clearing the box restores the page's existing Invited ordering untouched.
 */
export function filterInvitedBySearch<T extends SearchableWaitlistEntry>(
  entries: readonly T[] | null | undefined,
  raw: string | null | undefined,
): T[] {
  const list = entries ? [...entries] : []
  if (searchTokens(raw).length === 0) return list
  return list.filter((e) => matchesInvitedSearch(e, raw))
}

/**
 * The plain-language line next to the box.
 *
 *   no query      "24 invited people"        — the size of what is on screen
 *   matches       "3 results"
 *   no matches    'No invited people match “doug”'
 *
 * `shown` is the count AFTER both the lifecycle sub-filter and the search, so the summary always
 * describes the rows actually rendered. The tab badge is a separate, server-computed total and is
 * deliberately not derived from this.
 */
export function invitedResultSummary(shown: number, raw: string | null | undefined): string {
  const n = Math.max(0, shown | 0)
  const q = normalizeSearchQuery(raw)
  if (!q) return `${n} invited ${n === 1 ? 'person' : 'people'}`
  if (n === 0) return `No invited people match “${q}”`
  return `${n} ${n === 1 ? 'result' : 'results'}`
}

/**
 * The second line of the no-results state.
 *
 * WHY IT MATTERS. Search runs AFTER the lifecycle sub-filter, so "No invited people match “doug”"
 * can be true only because Doug sits in a different lifecycle bucket. Saying nothing there invites
 * the operator to conclude the person is not invited at all — the opposite of the truth. When a
 * bucket other than All is active, the copy names it; otherwise it just says where we looked.
 *
 * `lifecycleLabel` is the label of the active sub-filter, or null when the filter is All.
 */
export function invitedNoResultsDetail(lifecycleLabel: string | null | undefined): string {
  return lifecycleLabel
    ? `Only searching name and email within “${lifecycleLabel}”. They may be invited under a different email lifecycle.`
    : 'Searching name and email across the invited people on this page.'
}
