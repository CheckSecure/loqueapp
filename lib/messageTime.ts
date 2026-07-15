/**
 * Shared date/time formatting for conversation message lists.
 *
 * All grouping and labels use the VIEWER'S LOCAL timezone/calendar date (these
 * run in the browser), so messages group by the day the viewer perceives — not
 * the UTC date — and behave correctly around midnight. Invalid/missing
 * timestamps degrade gracefully to empty output rather than throwing.
 */

function toDate(input: string | number | Date | null | undefined): Date | null {
  if (input == null) return null
  const d = input instanceof Date ? input : new Date(input)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Concise local time, e.g. "3:42 PM". Empty string for invalid input. */
export function formatMessageTime(input: string | number | Date | null | undefined): string {
  const d = toDate(input)
  if (!d) return ''
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Stable key for a date's LOCAL calendar day (year-month-day). */
export function localDayKey(input: string | number | Date | null | undefined): string | null {
  const d = toDate(input)
  if (!d) return null
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** True when both timestamps fall on the same LOCAL calendar day. */
export function isSameLocalDay(
  a: string | number | Date | null | undefined,
  b: string | number | Date | null | undefined,
): boolean {
  const ka = localDayKey(a)
  const kb = localDayKey(b)
  return ka !== null && ka === kb
}

/**
 * Friendly centered-separator label for a message's local day:
 *   - "Today"     — same local day as `now`
 *   - "Yesterday" — the local day before `now`
 *   - otherwise   — "July 15, 2026"
 * Returns null for invalid input (caller renders no separator).
 */
export function formatDaySeparator(
  input: string | number | Date | null | undefined,
  now: Date = new Date(),
): string | null {
  const d = toDate(input)
  if (!d) return null

  const key = localDayKey(d)
  if (key === localDayKey(now)) return 'Today'

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (key === localDayKey(yesterday)) return 'Yesterday'

  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

/**
 * Decide whether a centered day separator should render before message `index`
 * in a chronologically-ordered list. True for the first message and whenever
 * the local day changes from the previous message.
 */
export function shouldShowDaySeparator(
  messages: Array<{ created_at: string | number | Date | null | undefined }>,
  index: number,
): boolean {
  if (index <= 0) return true
  return !isSameLocalDay(messages[index - 1]?.created_at, messages[index]?.created_at)
}
