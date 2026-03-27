'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

export default function WithdrawInterestButton({ targetId }: { targetId: string }) {
  const [confirming, setConfirming] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleWithdraw = async () => {
    alert('Withdraw clicked! targetId: ' + targetId)
    setLoading(true)
    try {
      const res = await fetch('/api/intro/rescind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId }),
      })
      const data = await res.json()
      console.log('Withdraw response:', data)
      alert('API response: ' + JSON.stringify(data))
      if (data.success) {
        window.location.reload()
      }
    } catch (err) {
      console.error('Failed to withdraw:', err)
      alert('Error: ' + err)
    }
    setLoading(false)
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          onClick={handleWithdraw}
          disabled={loading}
          className="text-xs font-semibold text-slate-600 border border-slate-200 px-2.5 py-1.5 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-60"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Yes, withdraw'}
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
      className="text-xs text-slate-500 hover:text-slate-700 font-medium transition-colors"
    >
      Withdraw
    </button>
  )
}
