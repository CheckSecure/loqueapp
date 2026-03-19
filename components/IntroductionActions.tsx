'use client'

import { useState } from 'react'
import { updateIntroStatus } from '@/app/actions'
import { CreditCard, CheckCircle } from 'lucide-react'
import Link from 'next/link'

export default function IntroductionActions({ introId }: { introId: string }) {
  const [loading, setLoading] = useState<'accepted' | 'declined' | null>(null)
  const [result, setResult] = useState<'accepted' | 'declined' | 'accepted_pending_payment' | null>(null)

  if (result === 'accepted') {
    return (
      <div className="w-full flex items-center gap-1.5 text-xs font-semibold text-green-700 bg-green-50 border border-green-200 px-3 py-1.5 rounded-lg">
        <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
        Connected — you can now message each other
      </div>
    )
  }

  if (result === 'declined') {
    return <span className="text-xs text-slate-400 font-medium">Declined</span>
  }

  if (result === 'accepted_pending_payment') {
    return (
      <div className="w-full space-y-2">
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
          <CreditCard className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-800 leading-relaxed">
            You accepted this request, but the other member has no credits. Their connection is on hold — they have 7 days to add credits.
          </p>
        </div>
      </div>
    )
  }

  const handle = async (status: 'accepted' | 'declined') => {
    setLoading(status)
    const res = await updateIntroStatus(introId, status)
    setLoading(null)
    if (!res.error) {
      setResult((res as any).status ?? status)
    }
  }

  return (
    <>
      <button
        disabled={!!loading}
        onClick={() => handle('accepted')}
        className="flex-1 text-xs font-semibold text-white bg-[#1B2850] hover:bg-[#2E4080] px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60 text-center"
      >
        {loading === 'accepted' ? '...' : 'Accept'}
      </button>
      <button
        disabled={!!loading}
        onClick={() => handle('declined')}
        className="flex-1 text-xs font-semibold text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-lg border border-slate-200 hover:border-slate-300 transition-colors disabled:opacity-60 text-center"
      >
        {loading === 'declined' ? '...' : 'Decline'}
      </button>
    </>
  )
}
