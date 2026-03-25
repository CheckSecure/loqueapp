'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles, Loader2, CheckCircle, Users } from 'lucide-react'

interface MutualPair {
  user_a_id: string
  user_a_name: string
  user_a_role: string
  user_b_id: string
  user_b_name: string
  user_b_role: string
  request_a_id: string
  request_b_id: string
}

export default function AdminMutualInterest({ pairs }: { pairs: MutualPair[] }) {
  const router = useRouter()
  const [facilitating, setFacilitating] = useState<string | null>(null)
  const [facilitated, setFacilitated] = useState<Set<string>>(new Set())

  const handleFacilitate = async (pair: MutualPair) => {
    const key = `${pair.user_a_id}-${pair.user_b_id}`
    setFacilitating(key)
    try {
      const res = await fetch('/api/admin/facilitate-intro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: pair.request_a_id,
          userAId: pair.user_a_id,
          userBId: pair.user_b_id,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setFacilitated(prev => new Set([...prev, key]))
        router.refresh()
      }
    } catch (err) {
      console.error('Failed to facilitate intro')
    }
    setFacilitating(null)
  }

  if (pairs.length === 0) return null

  return (
    <section className="mb-12">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="w-4 h-4 text-[#C4922A]" />
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
          Mutual Interest · {pairs.length} pair{pairs.length !== 1 ? 's' : ''}
        </h2>
      </div>
      <div className="space-y-3">
        {pairs.map(pair => {
          const key = `${pair.user_a_id}-${pair.user_b_id}`
          const done = facilitated.has(key)
          return (
            <div key={key} className="bg-white border border-amber-100 rounded-xl p-4 shadow-sm flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Users className="w-4 h-4 text-[#C4922A] flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900">
                    {pair.user_a_name} <span className="text-slate-400 font-normal">↔</span> {pair.user_b_name}
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {pair.user_a_role} · {pair.user_b_role}
                  </p>
                </div>
              </div>
              {done ? (
                <div className="flex items-center gap-1.5 text-xs text-green-700 bg-green-50 border border-green-200 px-3 py-1.5 rounded-lg flex-shrink-0">
                  <CheckCircle className="w-3.5 h-3.5" />
                  Facilitated
                </div>
              ) : (
                <button
                  onClick={() => handleFacilitate(pair)}
                  disabled={facilitating === key}
                  className="flex items-center gap-1.5 text-xs font-semibold text-white bg-[#C4922A] px-4 py-1.5 rounded-lg hover:bg-[#b07e21] transition-colors disabled:opacity-60 flex-shrink-0"
                >
                  {facilitating === key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  {facilitating === key ? 'Facilitating…' : 'Facilitate intro'}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
