'use client'

import { useState } from 'react'
import { Loader2, ChevronUp, ChevronDown } from 'lucide-react'

interface Member {
  id: string
  full_name: string
  email: string
  role_type: string
  subscription_tier: string
  admin_priority: string
  seniority: string
}

const PRIORITY_LABELS: Record<string, { label: string; color: string }> = {
  high_priority: { label: 'High priority', color: 'bg-green-50 text-green-700 border-green-200' },
  standard: { label: 'Standard', color: 'bg-slate-50 text-slate-500 border-slate-200' },
  low_priority: { label: 'Low priority', color: 'bg-red-50 text-red-500 border-red-200' },
}

const TIER_COLORS: Record<string, string> = {
  executive: 'bg-[#1B2850] text-white',
  professional: 'bg-[#C4922A] text-white',
  free: 'bg-slate-100 text-slate-600',
}

export default function AdminMemberList({ members }: { members: Member[] }) {
  const [priorities, setPriorities] = useState<Record<string, string>>(
    Object.fromEntries(members.map(m => [m.id, m.admin_priority]))
  )
  const [saving, setSaving] = useState<string | null>(null)
  const [sortField, setSortField] = useState<'full_name' | 'subscription_tier' | 'admin_priority'>('full_name')
  const [sortAsc, setSortAsc] = useState(true)

  const handleSort = (field: typeof sortField) => {
    if (sortField === field) setSortAsc(v => !v)
    else { setSortField(field); setSortAsc(true) }
  }

  const sorted = [...members].sort((a, b) => {
    const av = sortField === 'subscription_tier'
      ? { executive: 0, professional: 1, free: 2 }[a.subscription_tier] ?? 3
      : a[sortField]?.toLowerCase() ?? ''
    const bv = sortField === 'subscription_tier'
      ? { executive: 0, professional: 1, free: 2 }[b.subscription_tier] ?? 3
      : b[sortField]?.toLowerCase() ?? ''
    if (av < bv) return sortAsc ? -1 : 1
    if (av > bv) return sortAsc ? 1 : -1
    return 0
  })

  const handlePriority = async (userId: string, priority: string) => {
    setSaving(userId)
    setPriorities(prev => ({ ...prev, [userId]: priority }))
    try {
      await fetch('/api/admin/set-priority', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, priority }),
      })
    } catch (err) {
      console.error('Failed to set priority')
    }
    setSaving(null)
  }

  const SortIcon = ({ field }: { field: typeof sortField }) => (
    sortField === field
      ? sortAsc ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
      : <ChevronUp className="w-3 h-3 opacity-20" />
  )

  return (
    <div className="bg-white border border-slate-100 rounded-xl shadow-sm overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50">
            <th className="text-left px-4 py-3 font-semibold text-slate-500 cursor-pointer" onClick={() => handleSort('full_name')}>
              <span className="flex items-center gap-1">Name <SortIcon field="full_name" /></span>
            </th>
            <th className="text-left px-4 py-3 font-semibold text-slate-500">Role</th>
            <th className="text-left px-4 py-3 font-semibold text-slate-500 cursor-pointer" onClick={() => handleSort('subscription_tier')}>
              <span className="flex items-center gap-1">Tier <SortIcon field="subscription_tier" /></span>
            </th>
            <th className="text-left px-4 py-3 font-semibold text-slate-500 cursor-pointer" onClick={() => handleSort('admin_priority')}>
              <span className="flex items-center gap-1">Priority <SortIcon field="admin_priority" /></span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {sorted.map(m => {
            const priority = priorities[m.id] ?? 'standard'
            const priorityMeta = PRIORITY_LABELS[priority]
            return (
              <tr key={m.id} className="hover:bg-slate-50 transition-colors">
                <td className="px-4 py-3">
                  <p className="font-semibold text-slate-900">{m.full_name}</p>
                  <p className="text-slate-400">{m.email}</p>
                </td>
                <td className="px-4 py-3">
                  <p className="text-slate-600">{m.role_type || '—'}</p>
                  {m.seniority && <p className="text-slate-400">{m.seniority}</p>}
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold capitalize ${TIER_COLORS[m.subscription_tier] ?? TIER_COLORS.free}`}>
                    {m.subscription_tier}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <select
                      value={priority}
                      onChange={e => handlePriority(m.id, e.target.value)}
                      disabled={saving === m.id}
                      className={`text-xs border rounded-lg px-2 py-1 font-medium cursor-pointer ${priorityMeta.color}`}
                    >
                      <option value="high_priority">High priority</option>
                      <option value="standard">Standard</option>
                      <option value="low_priority">Low priority</option>
                    </select>
                    {saving === m.id && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
