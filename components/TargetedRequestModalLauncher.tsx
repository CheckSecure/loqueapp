'use client'

import { useState } from 'react'
import { Sparkles, ArrowRight, Send } from 'lucide-react'
import TargetedRequestModal from '@/components/TargetedRequestModal'

interface Props {
  premiumCredits: number
  hasPendingRequest: boolean
  /**
   * Visual variant:
   *   'primary' — the right-rail CTA button
   *   'row'     — the row-style entry used inside the no-suggestions empty state
   */
  variant?: 'primary' | 'row'
}

/**
 * Client-component wrapper that opens the TargetedRequestModal.
 *
 * Lives outside the modal itself so the modal stays purely a controlled
 * presentation component (open/onClose), and so the launcher can render in
 * different visual shapes from the same server-rendered page.
 *
 * Does NOT bypass the credit gate — the disabled state mirrors the modal's
 * own canSubmit check (premium_credits >= 1 AND no pending request). The
 * backend (/api/targeted-request/submit) is the authoritative gate; this is
 * UX so the user understands why before they open the modal.
 */
export default function TargetedRequestModalLauncher({ premiumCredits, hasPendingRequest, variant = 'primary' }: Props) {
  const [open, setOpen] = useState(false)

  const insufficient = premiumCredits < 1
  const blocked = hasPendingRequest

  if (variant === 'row') {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-start gap-3 rounded-lg border border-slate-200 hover:border-brand-navy hover:bg-slate-50 px-4 py-3 transition-colors text-left"
        >
          <Sparkles className="w-4 h-4 text-brand-gold flex-shrink-0 mt-1" />
          <div className="flex-1">
            <p className="text-sm font-medium text-slate-900">Request a targeted introduction</p>
            <p className="text-xs text-slate-500 mt-0.5">
              {insufficient
                ? 'Uses one premium credit. You have ' + premiumCredits + '.'
                : blocked
                  ? 'You already have one pending — wait or withdraw before submitting another.'
                  : 'Tell Andrel exactly who you want to meet.'}
            </p>
          </div>
          <ArrowRight className="w-4 h-4 text-slate-400 mt-1" />
        </button>
        <TargetedRequestModal
          premiumCredits={premiumCredits}
          hasPendingRequest={hasPendingRequest}
          open={open}
          onClose={() => setOpen(false)}
        />
      </>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center w-full gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-lg bg-brand-gold text-brand-navy hover:bg-brand-gold/90 transition-colors shadow-md disabled:bg-white/10 disabled:text-white/40 disabled:cursor-not-allowed disabled:shadow-none"
      >
        <Send className="w-4 h-4" />
        Request a targeted intro
      </button>
      <TargetedRequestModal
        premiumCredits={premiumCredits}
        hasPendingRequest={hasPendingRequest}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
