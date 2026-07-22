'use client'

import Link from 'next/link'
import { SlidersHorizontal, ArrowRight } from 'lucide-react'

/**
 * Shown to a member who received FEWER than the maximum introductions because
 * their stated preferences are too narrow (they HAVE set preferences, so it isn't
 * an incomplete-profile problem — it's a restrictiveness problem). Unlike the
 * "complete your matching profile" card, this explains *why* they got fewer and
 * invites them to broaden — while reaffirming that Andrel prioritizes quality over
 * quantity and never lowers standards.
 */
export default function BroadenPreferencesNotice() {
  const suggestions = [
    'Add more roles you’re open to meeting',
    'Add more industries and topics of interest',
    'Add additional networking goals',
    'Add more areas of your expertise',
  ]
  return (
    <div className="rounded-2xl border border-brand-navy/12 bg-white p-5 mb-4">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-brand-navy/[0.06] ring-1 ring-brand-navy/10 flex items-center justify-center flex-shrink-0">
          <SlidersHorizontal className="w-4 h-4 text-brand-navy" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-brand-navy">We found fewer high-quality matches for your current preferences</h3>
          <p className="mt-1.5 text-xs text-slate-500 leading-relaxed">
            Andrel prioritizes <span className="font-medium text-slate-600">quality over quantity</span> — we only
            introduce you to people who are a genuinely strong fit, so we&rsquo;d rather send a few excellent
            introductions than pad your list with weaker ones. Your preferences are a little specific right now, which
            narrowed the pool. To receive more introductions, consider broadening who you&rsquo;re open to meeting:
          </p>
          <ul className="mt-2.5 grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
            {suggestions.map((s) => (
              <li key={s} className="flex items-center gap-2 text-sm text-slate-700">
                <span className="w-1.5 h-1.5 rounded-full bg-brand-gold flex-shrink-0" />
                {s}
              </li>
            ))}
          </ul>
          <Link
            href="/dashboard/profile"
            className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 bg-brand-navy text-white text-sm font-semibold rounded-lg hover:bg-brand-navy/90 transition-colors"
          >
            Edit matching preferences
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </div>
  )
}
