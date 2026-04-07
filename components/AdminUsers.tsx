'use client'

import { useState } from 'react'
import { adminAdjustCredits } from '@/app/actions'
import { Loader2, Plus, Minus, CreditCard } from 'lucide-react'
import { cn } from '@/lib/utils'

interface UserRow {
  id: string
  full_name: string | null
  email: string | null
  role_type: string | null
  subscription_tier: string | null
  balance: number
}

const TIER_BADGE: Record<string, string> = {
  executive:    'bg-[#FDF3E3] text-[#C4922A] border-[#e8c88a]',
  professional: 'bg-[#F5F6FB] text-[#1B2850] border-[#1B2850]/20',
  free:         'bg-slate-50 text-slate-500 border-slate-200',
}

function TierBadge({ tier }: { tier: string | null }) {
  const t = tier ?? 'free'
  return (
    <span className={cn('text-[10px] font-semibold border px-2 py-0.5 rounded-full capitalize', TIER_BADGE[t] ?? TIER_BADGE.free)}>
      {t}
    </span>
  )
}

function CreditAdjuster({ userId, initial }: { userId: string; initial: number }) {
  const [balance, setBalance] = useState(initial)
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const submit = async (sign: 1 | -1) => {
    const n = parseInt(delta)
    if (!n || n <= 0) return
    setLoading(true)
    setMsg(null)
    const result = await adminAdjustCredits(userId, sign * n, reason || `Admin adjustment ${sign > 0 ? '+' : '-'}${n}`)
    setLoading(false)
    if (result.error) {
      setMsg(`Error: ${result.error}`)
    } else {
      setBalance(result.newBalance ?? balance)
      setDelta('')
      setReason('')
      setMsg('Updated')
      setTimeout(() => { setMsg(null); setOpen(false) }, 1500)
    }
  }

  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs font-semibold text-[#C4922A] hover:text-[#b07d24] transition-colors"
      >
        <CreditCard className="w-3.5 h-3.5" />
        {balance} cr
      </button>
      {open && (
        <div className="absolute z-50 right-0 mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-lg p-4">
          <p className="text-xs font-semibold text-slate-700 mb-3">Adjust credits</p>
          <input
            type="number"
            min="1"
            value={delta}
            onChange={e => setDelta(e.target.value)}
            placeholder="Amount"
            className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs mb-2 focus:outline-none focus:ring-1 focus:ring-[#1B2850]"
          />
          <input
            type="text"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Reason (optional)"
            className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs mb-3 focus:outline-none focus:ring-1 focus:ring-[#1B2850]"
          />
          <div className="flex gap-2">
            <button
              disabled={loading || !delta}
              onClick={() => submit(1)}
              className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold bg-[#1B2850] text-white px-2 py-1.5 rounded-lg hover:bg-[#2E4080] disabled:opacity-50"
            >
              <Plus className="w-3 h-3" /> Add
            </button>
            <button
              disabled={loading || !delta}
              onClick={() => submit(-1)}
              className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold border border-slate-200 text-slate-600 px-2 py-1.5 rounded-lg hover:bg-red-50 hover:text-red-600 hover:border-red-200 disabled:opacity-50"
            >
              <Minus className="w-3 h-3" /> Remove
            </button>
          </div>
          {loading && <div className="flex justify-center mt-2"><Loader2 className="w-3 h-3 animate-spin text-slate-400" /></div>}
          {msg && <p className="text-xs text-center mt-2 text-green-600">{msg}</p>}
        </div>
      )}
    </div>
  )
}

export default function AdminUsers({ users }: { users: UserRow[] }) {
  if (users.length === 0) {
    return (
      <div className="bg-white border border-slate-100 rounded-xl p-10 text-center shadow-sm">
        <p className="text-sm text-slate-500">No members yet.</p>
      </div>
    )
  }

  return (
    <div className="bg-white border border-slate-100 rounded-xl shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead>
            <tr className="border-b border-slate-100 bg-[#F5F6FB]">
              <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Member</th>
              <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Role</th>
              <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Tier</th>
              <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Credits</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {users.map(u => (
              <tr key={u.id} className="hover:bg-[#F5F6FB] transition-colors">
                <td className="px-5 py-3.5">
                  <p className="text-sm font-semibold text-slate-900">{u.full_name || '—'}</p>
                  <p className="text-xs text-slate-400">{u.email || '—'}</p>
                </td>
                <td className="px-5 py-3.5 text-xs text-slate-500">{u.role_type?.replace(/_/g, ' ') || '—'}</td>
                <td className="px-5 py-3.5"><TierBadge tier={u.subscription_tier} /></td>
                <td className="px-5 py-3.5 relative">
                  <CreditAdjuster userId={u.id} initial={u.balance} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>
    </div>
  )
}
