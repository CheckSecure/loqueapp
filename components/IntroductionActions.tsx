'use client'

import { useState } from 'react'
import { updateIntroStatus } from '@/app/actions'

export default function IntroductionActions({ introId }: { introId: string }) {
  const [loading, setLoading] = useState<'accepted' | 'declined' | null>(null)
  const [done, setDone] = useState(false)

  if (done) return <span className="text-xs text-slate-400 font-medium">Done</span>

  const handle = async (status: 'accepted' | 'declined') => {
    setLoading(status)
    await updateIntroStatus(introId, status)
    setDone(true)
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
