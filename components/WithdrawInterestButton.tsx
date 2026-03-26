'use client'

import { useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'

export default function WithdrawInterestButton({ targetId }: { targetId: string }) {
  const [confirming, setConfirming] = useState(false)
  const [loading, setLoading] = useState(false)
  const [withdrawn, setWithdrawn] = useState(false)
  const router = useRouter()

  const handleWithdraw = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/intro/rescind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId }),
      })
      const data = await res.json()
      if (data.success) {
        setWithdrawn(true)
        router.refresh()
      }
    } catch (err) {
      console.error('Failed to withdraw interest')
    }
    setLoading(false)
    setConfirming(false)
  }

  if (withdrawn) return null

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          onClick={handleWithdraw}
          disabled={loading}
          className="text-xs font-semibold text-red-600 border border-red-200 px-2.5 py-1.5 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-60"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Confirm'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="text-xs text-slate-400 hover:text-slate-600 px-2 py-1.5"
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="flex-shrink-0 text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1 py-1 transition-colors"
      title="Withdraw interest"
    >
      <X className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">Withdraw</span>
    </button>
  )
}
