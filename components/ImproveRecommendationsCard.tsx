'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Sparkles, ArrowRight, Loader2 } from 'lucide-react'

export type MissingArea = { key: string; label: string }

/**
 * The single Introductions-page guidance card for members whose RECOMMENDATION-
 * relevant profile fields are still missing (from matchProfileCompletion.missing).
 * Dismissible via "Not now" — persists per member (profiles.intro_profile_prompt_
 * dismissed_at). The server decides whether to render it (missing > 0 AND not
 * dismissed AND matching profile not complete), so a completed profile retires it
 * automatically regardless of dismissal. Dismissal is UI-only — it never touches
 * matching, eligibility, or profile data.
 */
export default function ImproveRecommendationsCard({ missing }: { missing: MissingArea[] }) {
  const router = useRouter()
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)

  if (hidden || missing.length === 0) return null

  const dismiss = async () => {
    setBusy(true)
    try {
      // Best-effort persist; hide locally regardless (fails open pre-migration).
      await fetch('/api/profile/dismiss-intro-prompt', { method: 'POST' }).catch(() => {})
    } finally {
      setHidden(true)
      router.refresh() // re-render the server page so the card stays gone
    }
  }

  return (
    <div className="mb-6 rounded-2xl border border-brand-gold/25 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-brand-navy/[0.06] ring-1 ring-brand-navy/10 flex items-center justify-center flex-shrink-0">
          <Sparkles className="w-4 h-4 text-brand-gold" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-brand-navy">Improve your recommendations</h3>
          <p className="mt-1.5 text-xs sm:text-sm text-slate-600 leading-relaxed">
            Adding more detail about your expertise, interests, networking goals, and the people you&rsquo;re open to
            meeting can help Andrel find stronger introductions.
          </p>

          {/* Only the SPECIFIC missing areas */}
          <ul className="mt-2.5 grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
            {missing.map((m) => (
              <li key={m.key} className="flex items-center gap-2 text-sm text-slate-700">
                <span className="w-1.5 h-1.5 rounded-full bg-brand-gold flex-shrink-0" />
                {m.label}
              </li>
            ))}
          </ul>

          <div className="mt-5 flex items-center gap-3">
            <Link
              href="/dashboard/profile"
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-navy px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-navy/90"
            >
              Improve profile <ArrowRight className="w-3.5 h-3.5" />
            </Link>
            <button
              type="button"
              onClick={dismiss}
              disabled={busy}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-700 disabled:opacity-60"
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
