'use client'

import { useState } from 'react'
import { Loader2, ExternalLink } from 'lucide-react'

export default function ManageBillingButton() {
  const [loading, setLoading] = useState(false)

  const handleClick = async () => {
    setLoading(true)
    const res = await fetch('/api/stripe/portal', { method: 'POST' })
    const data = await res.json()
    if (data.url) window.location.href = data.url
    else { console.error(data.error); setLoading(false) }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="flex items-center gap-2 text-sm font-semibold text-[#1B2850] border border-[#1B2850]/20 hover:bg-[#F5F6FB] px-4 py-2 rounded-xl transition-colors disabled:opacity-60"
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
      Manage billing
    </button>
  )
}
