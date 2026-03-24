'use client'

import { useState } from 'react'
import { Sparkles, Loader2, CheckCircle, Eye } from 'lucide-react'
import { useRouter } from 'next/navigation'

export default function AdminBatchButton() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ batchId?: string; batchNumber?: number; totalSuggestions?: number; usersMatched?: number; error?: string } | null>(null)
  const router = useRouter()

  const handleGenerate = async () => {
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch('/api/admin/generate-batch', { method: 'POST' })
      const data = await res.json()
      setResult(data)
      if (data.success) router.refresh()
    } catch (err: any) {
      setResult({ error: err.message })
    }
    setLoading(false)
  }

  return (
    <div className="flex flex-col items-end gap-2 flex-shrink-0">
      <button
        disabled={loading}
        onClick={handleGenerate}
        className="flex items-center gap-2 text-sm font-semibold bg-[#1B2850] text-white px-4 py-2 rounded-xl hover:bg-[#2E4080] transition-colors disabled:opacity-60"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        {loading ? 'Generating...' : 'Generate batch'}
      </button>
      {result?.success && (
        <div className="flex items-center gap-1.5 text-xs text-green-700 bg-green-50 border border-green-200 px-3 py-1.5 rounded-lg">
          <CheckCircle className="w-3.5 h-3.5" />
          Batch {result.batchNumber} ready for review · {result.totalSuggestions} suggestions across {result.usersMatched} members
        </div>
      )}
      {result?.error && (
        <p className="text-xs text-red-600">{result.error}</p>
      )}
    </div>
  )
}
