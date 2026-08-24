import { Link2 } from 'lucide-react'
import { ANDREL_CONNECTOR_LABEL, ANDREL_CONNECTOR_TOOLTIP } from '@/lib/recognition/andrelConnector'

/**
 * AndrelConnectorBadge — the ONE rendering of this recognition. Every surface uses it, so the
 * wording, the tokens and the accessible description cannot drift between profile, Network and
 * Introductions.
 *
 * RESTRAINT IS THE DESIGN. A small gold-bordered pill in brand navy, matching FoundingMemberBadge
 * and the Pill primitive. No animation, no glow, no medal, no count, no leaderboard styling — this
 * recognizes a person, it does not rank them.
 *
 * ACCESSIBILITY.
 *   - The visible words carry the meaning; colour is never the signal.
 *   - The icon is aria-hidden — it decorates, it does not inform.
 *   - The explanation is reachable by KEYBOARD, not hover alone: the pill is focusable (tabIndex 0)
 *     and carries the sentence as its accessible description, so screen readers and keyboard users
 *     get it without a pointer. `title` covers hover and long-press.
 *   - `whitespace-nowrap` + `shrink-0` keep it on one line and stop it competing with a long name
 *     for space, which is what caused truncation when it sat inline.
 */
export function AndrelConnectorBadge({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const isSm = size === 'sm'
  const padding = isSm ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'
  const iconSize = isSm ? 'w-2.5 h-2.5' : 'w-3 h-3'
  return (
    <span
      tabIndex={0}
      title={ANDREL_CONNECTOR_TOOLTIP}
      aria-label={`${ANDREL_CONNECTOR_LABEL}. ${ANDREL_CONNECTOR_TOOLTIP}`}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-brand-gold/30 bg-brand-gold/[0.08] font-semibold tracking-wide text-brand-navy ${padding} focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold focus-visible:ring-offset-1`}
    >
      <Link2 aria-hidden className={`${iconSize} text-brand-gold`} />
      {ANDREL_CONNECTOR_LABEL}
    </span>
  )
}
