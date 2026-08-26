import { CheckCircle2 } from 'lucide-react'
import { GUIDANCE_COPY } from '@/lib/introductions/guidance'

/**
 * "You're all caught up" — shown in the existing empty-state area, INSTEAD of the
 * "being curated" panel, when the member has answered everything they were sent.
 *
 * REQUIRES A PAST. It is a statement about work the member already did, so the server only selects
 * it when they have previously received an introduction. A brand-new member who has never been sent
 * a card keeps the existing waiting/preparation state — telling them they are caught up on nothing
 * would be nonsense.
 *
 * NO SECOND CALENDAR. It says "the next weekly round" and deliberately carries no date, time or
 * countdown: ThursdayCountdownBanner above it is the single authority for release timing, and a
 * second calculation here could contradict it. It also promises no introduction — "we'll consider
 * you" is the whole claim, because fit, capacity, cooldown and pool availability still decide.
 *
 * Server component. No counterparty state of any kind.
 */
export default function AllCaughtUpNotice() {
  return (
    <section
      role="status"
      className="rounded-2xl border border-slate-200/70 bg-white p-6 sm:p-7"
    >
      <div className="flex items-start gap-4 min-w-0">
        <div className="w-10 h-10 rounded-xl bg-brand-navy/[0.04] text-emerald-600 flex items-center justify-center flex-shrink-0">
          <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg sm:text-xl font-bold text-brand-navy tracking-tight leading-tight break-words">
            {GUIDANCE_COPY.caughtUp.heading}
          </h2>
          <p className="text-sm text-slate-600 mt-2 leading-relaxed max-w-xl break-words">
            {GUIDANCE_COPY.caughtUp.body}
          </p>
        </div>
      </div>
    </section>
  )
}
