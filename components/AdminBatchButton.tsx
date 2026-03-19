'use client'

import { useState } from 'react'
import { adminGenerateBatch } from '@/app/actions'
import { Sparkles, Loader2, CheckCircle } from 'lucide-react'

export default function AdminBatchButton() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ batchNumber?: number; suggestionCount?: number; error?: string } | null>(null)

  const handleGenerate = async () => {
    setLoading(true)
    setResult(null)
    const res = await adminGenerateBatch()
    setLoading(false)
    setResult(res as any)
  }

  return (
    <div className="flex flex-col items-end gap-2 flex-shrink-0">
      <button
        disabled={loading}
        onClick={handleGenerate}
        className="flex items-center gap-2 text-sm font-semibold bg-[#1B2850] text-white px-4 py-2 rounded-xl hover:bg-[#2E4080] transition-colors disabled:opacity-60"
      >
        {loading
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : <Sparkles className="w-4 h-4" />}
        {loading ? 'Generating...' : 'Generate batch'}
      </button>
      {result && !result.error && (
        <div className="flex items-center gap-1.5 text-xs text-green-700 bg-green-50 border border-green-200 px-3 py-1.5 rounded-lg">
          <CheckCircle className="w-3.5 h-3.5" />
          Batch {result.batchNumber} created · {result.suggestionCount} suggestions
        </div>
      )}
      {result?.error && (
        <p className="text-xs text-red-600">{result.error}</p>
      )}
    </div>
  )
}
