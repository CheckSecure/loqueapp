'use client'

import { useState } from 'react'
import { Loader2, RefreshCw, CheckCircle } from 'lucide-react'

export default function ComputeScoresButton() {
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const handleCompute = async () => {
    setLoading(true)
    setDone(false)
    try {
      const res = await fetch('/api/admin/compute-scores', { method: 'POST' })
      const data = await res.json()
      if (data.success) setDone(true)
    } catch (err) {
      console.error('Failed to compute scores')
    }
    setLoading(false)
    setTimeout(() => setDone(false), 3000)
  }

  return (
    <button
      onClick={handleCompute}
      disabled={loading}
      className="flex items-center gap-1.5 text-xs font-semibold text-[#1B2850] border border-slate-200 px-4 py-2 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-60"
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : done ? <CheckCircle className="w-3.5 h-3.5 text-green-500" /> : <RefreshCw className="w-3.5 h-3.5" />}
      {loading ? 'Computing…' : done ? 'Done' : 'Compute now'}
    </button>
  )
}
