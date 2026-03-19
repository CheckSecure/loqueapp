'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

interface Props {
  priceId: string
  mode?: 'subscription' | 'payment'
  label: string
  className?: string
  disabled?: boolean
}

export default function CheckoutButton({ priceId, mode = 'subscription', label, className, disabled }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleClick = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId, mode }),
      })
      const data = await res.json()
      if (data.error) { setError(data.error); setLoading(false); return }
      if (data.url) window.location.href = data.url
    } catch (e: any) {
      setError(e.message)
      setLoading(false)
    }
  }

  return (
    <div className="w-full">
      <button
        onClick={handleClick}
        disabled={disabled || loading}
        className={className ?? 'w-full flex items-center justify-center gap-2 text-sm font-semibold bg-[#1B2850] text-white px-4 py-2.5 rounded-xl hover:bg-[#2E4080] transition-colors disabled:opacity-60'}
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : label}
      </button>
      {error && <p className="text-xs text-red-600 mt-1.5 text-center">{error}</p>}
    </div>
  )
}
