'use client'

import { useState } from 'react'
import { submitIntroRequest } from '@/app/actions'
import { CheckCircle, Loader2 } from 'lucide-react'

export default function RequestIntroButton({
  targetId,
  alreadyRequested = false,
}: {
  targetId: string
  alreadyRequested?: boolean
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>(
    alreadyRequested ? 'done' : 'idle'
  )
  const [errorMsg, setErrorMsg] = useState('')

  const handleClick = async () => {
    setState('loading')
    const result = await submitIntroRequest(targetId)
    if (result.error) {
      setErrorMsg(result.error)
      setState('error')
    } else {
      setState('done')
    }
  }

  if (state === 'done') {
    return (
      <div className="mt-1">
        <div className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-[#C4922A] bg-[#FDF3E3] border border-[#C4922A]/30 py-1.5 rounded-lg">
          <CheckCircle className="w-3.5 h-3.5" />
          Requested ✓
        </div>
        <p className="text-xs text-slate-400 text-center mt-1.5">
          Request submitted — Cadre will facilitate this introduction
        </p>
      </div>
    )
  }

  return (
    <div className="mt-1">
      <button
        onClick={handleClick}
        disabled={state === 'loading'}
        className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold bg-[#1B2850] text-white py-1.5 rounded-lg hover:bg-[#2E4080] transition-colors disabled:opacity-60"
      >
        {state === 'loading' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {state === 'loading' ? 'Submitting...' : state === 'error' ? 'Try again' : 'Request intro'}
      </button>
      {state === 'error' && errorMsg && (
        <p className="text-xs text-red-500 text-center mt-1">{errorMsg}</p>
      )}
    </div>
  )
}
