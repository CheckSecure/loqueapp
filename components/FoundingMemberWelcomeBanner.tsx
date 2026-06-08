'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Sparkles, X } from 'lucide-react'

// One-time welcome banner for active founding members in their first 30 days.
// Server-side determines eligibility (`show`); this component handles the
// localStorage dismissal and the hydration-safe reveal — same pattern as
// components/PageHint.tsx.
const STORAGE_KEY = 'andrel:hint:dismissed:founding-welcome'

export default function FoundingMemberWelcomeBanner({ show }: { show: boolean }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!show) return
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setVisible(true)
    } catch {
      // localStorage unavailable (e.g. private mode) — show the banner anyway;
      // it just won't persist as dismissed.
      setVisible(true)
    }
  }, [show])

  if (!visible) return null

  const dismiss = () => {
    try { localStorage.setItem(STORAGE_KEY, '1') } catch {}
    setVisible(false)
  }

  return (
    <div className="mb-6 p-5 sm:p-6 rounded-2xl border border-brand-gold/30 bg-brand-gold-soft relative">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss founding member welcome"
        className="absolute top-3 right-3 text-slate-400 hover:text-slate-700 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
      <div className="flex items-center gap-2 mb-3 text-brand-gold">
        <Sparkles className="w-4 h-4" />
        <span className="text-xs font-semibold uppercase tracking-[0.2em]">Founding member</span>
      </div>
      <h2 className="text-lg font-bold text-brand-navy tracking-tight mb-3">Welcome to Andrel</h2>
      <p className="text-sm text-slate-700 leading-relaxed mb-3">
        You&apos;re among our founding members and one of the first professionals invited into the network.
      </p>
      <p className="text-sm text-slate-700 leading-relaxed mb-3">
        New members are joining daily as we continue onboarding the community in phases. Our introduction engine works in batches, and as the network grows, your matches will surface here automatically.
      </p>
      <p className="text-sm text-slate-700 leading-relaxed mb-3">
        In the meantime, take a few minutes to complete your profile and review your professional interests so we can make stronger introductions.
      </p>
      <p className="text-sm text-slate-700 leading-relaxed mb-5">
        Thank you for helping build the founding community.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/dashboard/profile"
          className="inline-flex items-center gap-2 rounded-xl font-medium transition-colors px-4 py-2 text-sm bg-brand-navy text-white hover:bg-brand-navy-dark"
        >
          Complete Profile
        </Link>
        <button
          type="button"
          onClick={dismiss}
          className="inline-flex items-center gap-2 rounded-xl font-medium transition-colors px-4 py-2 text-sm bg-transparent text-slate-600 hover:bg-slate-100"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
