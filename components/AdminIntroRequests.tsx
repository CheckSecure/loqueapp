'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { adminApproveIntro, adminRejectIntro } from '@/app/actions'
import { CheckCircle, XCircle, Loader2 } from 'lucide-react'

interface Request {
  id: string
  note: string | null
  created_at: string
  requester: { id: string; full_name: string; title?: string; company?: string } | null
  target: { id: string; full_name: string; title?: string; company?: string } | null
}

const AVATAR_COLORS = [
  'bg-violet-500','bg-emerald-500','bg-amber-500','bg-rose-500',
  'bg-cyan-500','bg-indigo-500','bg-pink-500','bg-teal-500',
]

function pickColor(id: string) {
  const n = (id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

function initials(name?: string) {
  return (name || '?').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()
}

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function ProfileCell({ profile }: { profile: Request['requester'] }) {
  if (!profile) return <span className="text-slate-400 text-sm">Unknown</span>
  return (
    <div className="flex items-center gap-2.5">
      <div className={`w-8 h-8 rounded-full ${pickColor(profile.id)} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
        {initials(profile.full_name)}
      </div>
      <div>
        <p className="text-sm font-semibold text-slate-900">{profile.full_name}</p>
        {(profile.title || profile.company) && (
          <p className="text-xs text-slate-500">
            {[profile.title, profile.company].filter(Boolean).join(' at ')}
          </p>
        )}
      </div>
    </div>
  )
}

export default function AdminIntroRequests({ initial }: { initial: Request[] }) {
  const [requests, setRequests] = useState(initial)
  const [loading, setLoading] = useState<Record<string, 'approve' | 'reject'>>({})
  const router = useRouter()

  const handle = async (id: string, action: 'approve' | 'reject') => {
    setLoading(prev => ({ ...prev, [id]: action }))
    const result = action === 'approve'
      ? await adminApproveIntro(id)
      : await adminRejectIntro(id)

    if (!result.error) {
      setRequests(prev => prev.filter(r => r.id !== id))
    }
    setLoading(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    router.refresh()
  }

  if (requests.length === 0) {
    return (
      <div className="bg-white border border-slate-100 rounded-xl p-12 text-center shadow-sm">
        <CheckCircle className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
        <p className="text-sm font-semibold text-slate-700">No pending requests</p>
        <p className="text-xs text-slate-400 mt-1">All intro requests have been handled.</p>
      </div>
    )
  }

  return (
    <div className="bg-white border border-slate-100 rounded-xl shadow-sm overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50">
            <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Requester</th>
            <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Requesting intro to</th>
            <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Note</th>
            <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Received</th>
            <th className="px-5 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {requests.map(r => {
            const busy = loading[r.id]
            return (
              <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                <td className="px-5 py-4">
                  <ProfileCell profile={r.requester} />
                </td>
                <td className="px-5 py-4">
                  <ProfileCell profile={r.target} />
                </td>
                <td className="px-5 py-4 max-w-xs">
                  {r.note
                    ? <p className="text-xs text-slate-500 italic line-clamp-2">"{r.note}"</p>
                    : <span className="text-xs text-slate-300">—</span>}
                </td>
                <td className="px-5 py-4">
                  <span className="text-xs text-slate-400">{timeAgo(r.created_at)}</span>
                </td>
                <td className="px-5 py-4">
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      disabled={!!busy}
                      onClick={() => handle(r.id, 'approve')}
                      className="flex items-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                    >
                      {busy === 'approve'
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <CheckCircle className="w-3 h-3" />}
                      Approve
                    </button>
                    <button
                      disabled={!!busy}
                      onClick={() => handle(r.id, 'reject')}
                      className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-red-600 border border-slate-200 hover:border-red-200 hover:bg-red-50 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                    >
                      {busy === 'reject'
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <XCircle className="w-3 h-3" />}
                      Reject
                    </button>
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
