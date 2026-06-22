'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Sparkles, ArrowRight, Send, Clock, CheckCircle2, Lock } from 'lucide-react'
import ConciergeModal from '@/components/ConciergeModal'

type ConciergeStatus = 'pending' | 'reviewing' | 'match_found'

interface Props {
  /** Server-computed gate (getEffectiveTier ∈ professional|executive|founding). UI convenience only. */
  canUseConcierge: boolean
  /** Active request status, if any (pending|reviewing|match_found), else null. */
  activeStatus?: ConciergeStatus | null
  /**
   * 'primary' — the right-rail Concierge card body.
   * 'row'     — the row-style entry inside the no-suggestions empty state.
   */
  variant?: 'primary' | 'row'
}

const STATUS_LABEL: Record<ConciergeStatus, string> = {
  pending: 'Pending review',
  reviewing: 'Under review',
  match_found: 'Match found',
}

/**
 * Tier-gated entry point for the Andrel Concierge flow.
 *
 * Mirrors the server gate (getEffectiveTier) via the canUseConcierge boolean,
 * which is computed server-side and passed in. The server route remains
 * authoritative — this only decides what the user sees.
 *
 * States:
 *   - not eligible        → upgrade panel / upgrade row (no form)
 *   - eligible + active    → status display (no form)
 *   - eligible + no active → CTA that opens the ConciergeModal
 */
export default function ConciergeLauncher({ canUseConcierge, activeStatus = null, variant = 'primary' }: Props) {
  const [open, setOpen] = useState(false)

  // ---- ROW VARIANT (empty-state) ----
  if (variant === 'row') {
    if (!canUseConcierge) {
      return (
        <Link
          href="/pricing"
          className="flex w-full items-start gap-3 rounded-lg border border-brand-gold/30 bg-brand-cream/40 hover:border-brand-gold hover:bg-brand-cream px-4 py-3 transition-colors text-left"
        >
          <Lock className="w-4 h-4 text-brand-gold flex-shrink-0 mt-1" />
          <div className="flex-1">
            <p className="text-sm font-medium text-brand-navy">Andrel Concierge</p>
            <p className="text-xs text-slate-500 mt-0.5">Included with Professional, Executive, and Founding memberships.</p>
          </div>
          <ArrowRight className="w-4 h-4 text-slate-400 mt-1" />
        </Link>
      )
    }
    if (activeStatus) {
      return (
        <div className="flex w-full items-start gap-3 rounded-lg border border-brand-gold/30 bg-brand-cream/40 px-4 py-3">
          <Clock className="w-4 h-4 text-brand-gold flex-shrink-0 mt-1" />
          <div className="flex-1">
            <p className="text-sm font-medium text-brand-navy">Concierge request active</p>
            <p className="text-xs text-slate-500 mt-0.5">{STATUS_LABEL[activeStatus]} — Andrel is identifying the best introduction.</p>
          </div>
        </div>
      )
    }
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-start gap-3 rounded-lg border border-slate-200 hover:border-brand-navy hover:bg-slate-50 px-4 py-3 transition-colors text-left"
        >
          <Sparkles className="w-4 h-4 text-brand-gold flex-shrink-0 mt-1" />
          <div className="flex-1">
            <p className="text-sm font-medium text-slate-900">Request an Andrel introduction</p>
            <p className="text-xs text-slate-500 mt-0.5">Tell Andrel exactly who you want to meet.</p>
          </div>
          <ArrowRight className="w-4 h-4 text-slate-400 mt-1" />
        </button>
        <ConciergeModal open={open} onClose={() => setOpen(false)} />
      </>
    )
  }

  // ---- PRIMARY VARIANT (right-rail card body) ----
  if (!canUseConcierge) {
    return (
      <div className="space-y-3">
        <p className="text-[11px] text-white/70 leading-relaxed">
          Concierge is included with Professional, Executive, and Founding memberships.
        </p>
        <ul className="space-y-1.5 text-[11px] text-white/70">
          <li className="flex items-start gap-1.5"><CheckCircle2 className="w-3 h-3 text-brand-gold flex-shrink-0 mt-0.5" /> Request warm introductions to anyone you name.</li>
          <li className="flex items-start gap-1.5"><CheckCircle2 className="w-3 h-3 text-brand-gold flex-shrink-0 mt-0.5" /> Receive curated recommendations from the network.</li>
          <li className="flex items-start gap-1.5"><CheckCircle2 className="w-3 h-3 text-brand-gold flex-shrink-0 mt-0.5" /> Have Andrel facilitate the connection for you.</li>
        </ul>
        <Link
          href="/pricing"
          className="inline-flex items-center justify-center w-full gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-lg bg-brand-gold text-brand-navy hover:bg-brand-gold/90 transition-colors shadow-md"
        >
          Upgrade to Professional
          <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    )
  }

  if (activeStatus) {
    return (
      <div className="rounded-lg border border-brand-gold/30 bg-white/10 px-3 py-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-brand-gold flex-shrink-0" />
          <span className="text-brand-gold bg-brand-gold/15 border border-brand-gold/40 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
            {STATUS_LABEL[activeStatus]}
          </span>
        </div>
        <p className="text-[11px] text-white/70 mt-2 leading-relaxed">
          Your Concierge request is active. Andrel is identifying the best introduction — we'll let you know.
        </p>
      </div>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center w-full gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-lg bg-brand-gold text-brand-navy hover:bg-brand-gold/90 transition-colors shadow-md"
      >
        <Send className="w-4 h-4" />
        Request an introduction
      </button>
      <ConciergeModal open={open} onClose={() => setOpen(false)} />
    </>
  )
}
