/**
 * "Respond to your introductions to stay eligible for new ones."
 *
 * Shown only while the member personally has at least one actionable introduction on screen. It is
 * derived from the same array that renders the cards, so it cannot contradict them.
 *
 * WHAT IT MUST NOT CLAIM. Responding restores ELIGIBILITY. It does not produce an introduction:
 * candidate fit, both members' capacity, the 30-day pair cooldown, prior-intro history, blocking and
 * pool availability all still decide. The second line exists to say that plainly, because the
 * reminder email used to promise the opposite.
 *
 * NOT A CARD, NOT A BANNER. No dismissal, no countdown, no tracking, no fixed or sticky position —
 * it sits in normal flow directly above the grid, so it can never cover the fixed MobileNav. It
 * carries no counterparty state and never reveals whether anyone has responded.
 */
export default function RespondToIntroductionsNotice() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-6 rounded-xl border border-brand-gold/25 bg-brand-gold/[0.06] px-4 py-3"
    >
      <p className="text-sm font-semibold text-brand-navy leading-snug">
        Respond to your introductions to stay eligible for new ones.
      </p>
      <p className="mt-1 text-xs text-slate-600 leading-relaxed">
        Choose Express interest or Pass on each one. Responding keeps you eligible for future curated
        introductions&mdash;it doesn&rsquo;t guarantee a new one in every batch.
      </p>
    </div>
  )
}
