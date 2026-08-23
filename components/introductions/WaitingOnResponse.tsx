/**
 * "Waiting on their response" — the compact, NON-INTERACTIVE state for a card the member has
 * already answered.
 *
 * WHY THIS EXISTS AT ALL. Once a member expresses interest, the feed hides the card. After the
 * 72-hour capacity release the member starts receiving replacement cards, and without this line
 * their own action would have vanished with no trace — inviting them to express interest again, or
 * to assume nothing happened. So the card does not disappear; it stops being a card.
 *
 * THREE PROPERTIES IT MUST KEEP:
 *   1. NOT ACTIONABLE. No Express Interest control, no Pass control, no link that changes state.
 *      It renders outside the actionable card list precisely so it cannot be mistaken for one.
 *   2. NO PROMISE. "We'll let you know if they're interested" — never "pending match", never a
 *      likelihood, never a timeframe. The counterparty may never answer, and the copy must survive
 *      that outcome honestly.
 *   3. NO CAPACITY. This is display only; capacity is decided in the database by
 *      capacity_released_at, and rendering this component neither reads nor affects it.
 *
 * The counterparty's experience is untouched: their card stays visible and actionable.
 */
export interface WaitingEntry {
  /** Stable key. The suggested row's id; never rendered. */
  id: string
  /** Display name of the person the member is waiting on. */
  name: string
}

export default function WaitingOnResponse({ entries }: { entries: WaitingEntry[] }) {
  if (!entries || entries.length === 0) return null

  return (
    <section
      aria-label="Introductions awaiting a response"
      className="mt-8 rounded-xl border border-slate-200 bg-white/60 px-4 py-3"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Waiting on their response
      </p>
      <ul className="mt-2 space-y-1">
        {entries.map((e) => (
          <li key={e.id} className="text-sm text-slate-700">
            {e.name}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-500">
        We&rsquo;ll let you know if they&rsquo;re interested.
      </p>
    </section>
  )
}
