'use client'

import { useState } from 'react'
import { requestIntroduction } from '@/app/actions'

export default function RequestIntroButton({ targetId }: { targetId: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')

  const handleClick = async () => {
    setState('loading')
    const result = await requestIntroduction(targetId)
    setState(result.error ? 'error' : 'done')
  }

  if (state === 'done') {
    return (
      <div className="w-full text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 py-1.5 rounded-lg text-center">
        Request sent!
      </div>
    )
  }

  return (
    <button
      onClick={handleClick}
      disabled={state === 'loading'}
      className="w-full text-xs font-semibold bg-indigo-600 text-white py-1.5 rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-60"
    >
      {state === 'loading' ? 'Sending...' : state === 'error' ? 'Try again' : 'Request intro'}
    </button>
  )
}
