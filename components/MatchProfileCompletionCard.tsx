'use client'

import Link from 'next/link'
import { Sparkles, ArrowRight, Check } from 'lucide-react'
import { matchProfileCompletion } from '@/lib/matching/profile-completion'

/**
 * Surfaces "Match Profile Completion" — readiness for high-quality matching based
 * ONLY on the recommendation-engine fields. Two uses:
 *   - variant="card"  → a calm nudge on the profile page.
 *   - variant="empty" → the empty/low-match experience on the introductions page,
 *     shown when a member has few/no introductions because their matching profile
 *     is incomplete (instead of a bare empty state).
 * Renders nothing once the matching profile is complete.
 */
export default function MatchProfileCompletionCard({
  profile,
  variant = 'card',
}: {
  profile: any
  variant?: 'card' | 'empty'
}) {
  const m = matchProfileCompletion(profile)
  if (m.complete) return null

  const empty = variant === 'empty'
  const headline = empty
    ? 'Complete your matching profile to unlock more high-quality introductions'
    : 'Improve your introductions'

  return (
    <div className={`rounded-2xl border ${empty ? 'border-brand-gold/30 bg-brand-gold-soft/60' : 'border-slate-200/70 bg-white'} p-5 mb-4`}>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-brand-navy/[0.06] ring-1 ring-brand-navy/10 flex items-center justify-center flex-shrink-0">
          <Sparkles className="w-4 h-4 text-brand-gold" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-brand-navy">{headline}</h3>
            <span className="text-xs font-semibold text-slate-400 tabular-nums flex-shrink-0">
              {m.completedCount}/{m.totalCount}
            </span>
          </div>

          {/* Progress */}
          <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full bg-brand-gold rounded-full transition-all" style={{ width: `${m.percent}%` }} />
          </div>

          <p className="mt-3 text-xs text-slate-500 leading-relaxed">
            Introductions are only as good as the details you share. Completing these directly improves the
            quality and number of introductions you receive:
          </p>

          {/* Missing matchable fields, as prompts */}
          <ul className="mt-2.5 space-y-1.5">
            {m.fields.map((f) => (
              <li key={f.key} className="flex items-center gap-2 text-sm">
                {f.done ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                ) : (
                  <span className="w-3.5 h-3.5 rounded-full border border-brand-gold/50 flex-shrink-0" />
                )}
                <span className={f.done ? 'text-slate-400 line-through' : 'text-slate-700'}>{f.prompt}</span>
              </li>
            ))}
          </ul>

          <Link
            href="/dashboard/profile"
            className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 bg-brand-navy text-white text-sm font-semibold rounded-lg hover:bg-brand-navy/90 transition-colors"
          >
            Complete matching profile
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </div>
  )
}
