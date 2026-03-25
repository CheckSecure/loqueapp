'use client'

import { useState } from 'react'
import { submitIntroRequest, passOnSuggestion } from '@/app/actions'
import { CheckCircle, Loader2, X, EyeOff, Sparkles } from 'lucide-react'
import UpgradeModal from './UpgradeModal'

export default function RequestIntroButton({
  targetId,
  alreadyRequested = false,
  rowId,
  userTier = 'free',
}: {
  targetId: string
  alreadyRequested?: boolean
  rowId?: string
  userTier?: string
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'signaling' | 'facilitating' | 'done' | 'error' | 'passed' | 'hidden'>(
    alreadyRequested ? 'done' : 'idle'
  )
  const [errorMsg, setErrorMsg] = useState('')
  const [showPassMenu, setShowPassMenu] = useState(false)
  const [showUpgrade, setShowUpgrade] = useState(false)
  const [passing, setPassing] = useState(false)

  const handleRequest = async () => {
    setState('loading')
    setErrorMsg('')

    // Show "signaling" state briefly
    await new Promise(r => setTimeout(r, 600))
    setState('signaling')

    const result = await submitIntroRequest(targetId)

    if (result.error) {
      setErrorMsg(result.error)
      setState('error')
      return
    }

    // Show "facilitating" state briefly to reinforce Andrel is in control
    setState('facilitating')
    await new Promise(r => setTimeout(r, 1800))
    setState('done')
  }

  const handlePass = async (permanent: boolean) => {
    setPassing(true)
    setShowPassMenu(false)
    if (rowId) await passOnSuggestion(rowId, permanent)
    setState(permanent ? 'hidden' : 'passed')
    setPassing(false)
  }

  if (state === 'hidden') return null

  if (state === 'passed') {
    return (
      <div className="mt-1 text-center">
        <p className="text-xs text-slate-400">Noted — this profile won't appear in your current batch.</p>
      </div>
    )
  }

  if (state === 'signaling') {
    return (
      <div className="mt-1">
        <div className="w-full flex items-center justify-center gap-2 text-xs font-medium text-slate-500 bg-slate-50 border border-slate-100 py-2 rounded-lg">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Recording your interest…
        </div>
      </div>
    )
  }

  if (state === 'facilitating') {
    return (
      <div className="mt-1">
        <div className="w-full flex items-center justify-center gap-2 text-xs font-medium text-[#C4922A] bg-[#FDF3E3] border border-[#C4922A]/20 py-2 rounded-lg">
          <Sparkles className="w-3.5 h-3.5 animate-pulse" />
          Facilitating introduction…
        </div>
      </div>
    )
  }

  if (state === 'done') {
    return (
      <div className="mt-1">
        <div className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-[#C4922A] bg-[#FDF3E3] border border-[#C4922A]/30 py-2 rounded-lg">
          <CheckCircle className="w-3.5 h-3.5" />
          Interest expressed ✓
        </div>
        <p className="text-xs text-slate-400 text-center mt-1.5 leading-relaxed">
          Andrel will facilitate this introduction based on alignment.
        </p>
      </div>
    )
  }

  return (
    <>
      {showUpgrade && <UpgradeModal onClose={() => setShowUpgrade(false)} />}
      <div className="mt-1 flex gap-2 relative">
        <button
          onClick={handleRequest}
          disabled={state === 'loading' || passing}
          className="flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold bg-[#1B2850] text-white py-2 rounded-lg hover:bg-[#2E4080] transition-colors disabled:opacity-60"
        >
          {state === 'loading' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {state === 'loading' ? 'Recording…' : state === 'error' ? 'Try again' : 'Express interest'}
        </button>

        <div className="relative">
          <button
            onClick={() => setShowPassMenu(v => !v)}
            disabled={passing}
            className="h-full px-2.5 text-slate-400 border border-slate-200 rounded-lg hover:bg-slate-50 hover:text-slate-600 transition-colors disabled:opacity-60"
            title="Pass"
          >
            {passing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
          </button>

          {showPassMenu && (
            <div className="absolute bottom-full right-0 mb-2 w-48 bg-white border border-slate-100 rounded-xl shadow-lg overflow-hidden z-10">
              <button
                onClick={() => handlePass(false)}
                className="w-full text-left px-4 py-2.5 text-xs text-slate-600 hover:bg-slate-50 transition-colors flex items-center gap-2"
              >
                <X className="w-3.5 h-3.5 text-slate-400" />
                Not for me
              </button>
              <button
                onClick={() => handlePass(true)}
                className="w-full text-left px-4 py-2.5 text-xs text-slate-600 hover:bg-slate-50 transition-colors flex items-center gap-2 border-t border-slate-50"
              >
                <EyeOff className="w-3.5 h-3.5 text-slate-400" />
                Don't show again
              </button>
            </div>
          )}
        </div>
      </div>

      {state === 'error' && errorMsg && (
        <p className="text-xs text-red-500 text-center mt-1">{errorMsg}</p>
      )}

      {userTier === 'free' && (
        <button
          onClick={() => setShowUpgrade(true)}
          className="w-full mt-2 text-xs text-[#C4922A] font-medium hover:underline text-center"
        >
          ✦ Upgrade for priority matching →
        </button>
      )}
    </>
  )
}
