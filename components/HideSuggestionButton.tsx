'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import { useRouter } from 'next/navigation'

export default function HideSuggestionButton({ rowId }: { rowId: string }) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleHide = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/intro/hide-suggestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowId }),
      })
      const data = await res.json()
      if (data.success) {
        // Hide the card immediately
        const card = document.querySelector(`[data-row-id="${rowId}"]`)
        if (card) {
          card.classList.add('hidden')
        }
      }
    } catch (err) {
      console.error('Failed to hide suggestion')
    }
    setLoading(false)
  }

  return (
    <button
      onClick={handleHide}
      disabled={loading}
      className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-colors disabled:opacity-50"
      title="Don't show this again"
    >
      <X className="w-3.5 h-3.5" />
    </button>
  )
}
