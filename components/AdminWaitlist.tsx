'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { adminApproveWaitlist, adminDeclineWaitlist, adminSendWaitlistInvite } from '@/app/actions'
import { CheckCircle, Loader2, Clock, UserCheck, XCircle, Mail } from 'lucide-react'

interface WaitlistEntry {
  id: string
  full_name: string
  email: string
  company: string | null
  role_type: string | null
  referral_source: string | null
  status: string
  created_at: string
}

const ROLE_LABELS: Record<string, string> = {
  in_house_counsel: 'In-house Counsel',
  law_firm_attorney: 'Law Firm Attorney',
  legal_operations: 'Legal Operations',
  compliance_risk: 'Compliance / Risk',
  privacy_data: 'Privacy / Data',
  regulatory_affairs: 'Regulatory Affairs',
  government_affairs: 'Government Affairs',
  strategy_consulting: 'Strategy / Consulting',
  legal_tech_startup: 'Legal Tech / Startup',
  executive_csuite: 'Executive / C-Suite',
  investor_vc: 'Investor / VC',
  government_policy: 'Government / Policy',
  finance_professional: 'Finance Professional',
  healthcare_professional: 'Healthcare Professional',
  other: 'Other',
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'approved') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full">
        <UserCheck className="w-2.5 h-2.5" />
        Approved
      </span>
    )
  }
  if (status === 'declined') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-red-50 text-red-600 border border-red-200 px-2 py-0.5 rounded-full">
        <XCircle className="w-2.5 h-2.5" />
        Declined
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full">
      <Clock className="w-2.5 h-2.5" />
      Pending
    </span>
  )
}

type ActionType = 'approve' | 'decline' | 'invite'

export default function AdminWaitlist({ initial }: { initial: WaitlistEntry[] }) {
  const [entries, setEntries] = useState(initial)
  const [loading, setLoading] = useState<Record<string, ActionType>>({})
  const [invited, setInvited] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const router = useRouter()

  const handle = async (id: string, action: ActionType) => {
    setLoading(prev => ({ ...prev, [id]: action }))
    setErrors(prev => { const next = { ...prev }; delete next[id]; return next })
    let result: { error?: string }
    if (action === 'approve') result = await adminApproveWaitlist(id)
    else if (action === 'decline') result = await adminDeclineWaitlist(id)
    else result = await adminSendWaitlistInvite(id)

    setLoading(prev => { const next = { ...prev }; delete next[id]; return next })
    if (result.error) {
      setErrors(prev => ({ ...prev, [id]: result.error! }))
    } else {
      if (action === 'approve') {
        setEntries(prev => prev.map(e => e.id === id ? { ...e, status: 'approved' } : e))
      } else if (action === 'decline') {
        setEntries(prev => prev.map(e => e.id === id ? { ...e, status: 'declined' } : e))
      } else {
        setEntries(prev => prev.map(e => e.id === id ? { ...e, status: 'approved' } : e))
        setInvited(prev => ({ ...prev, [id]: true }))
      }
      router.refresh()
    }
  }

  const pending  = entries.filter(e => e.status === 'pending')
  const approved = entries.filter(e => e.status === 'approved')
  const declined = entries.filter(e => e.status === 'declined')

  if (entries.length === 0) {
    return (
      <div className="bg-white border border-slate-100 rounded-xl p-12 text-center shadow-sm">
        <Clock className="w-10 h-10 text-[#C4922A] mx-auto mb-3" />
        <p className="text-sm font-semibold text-slate-700">No waitlist entries yet</p>
        <p className="text-xs text-slate-400 mt-1">Applications will appear here once people request access.</p>
      </div>
    )
  }

  const Table = ({ rows, dimmed = false }: { rows: WaitlistEntry[]; dimmed?: boolean }) => (
    <div className={`bg-white border border-slate-100 rounded-xl shadow-sm overflow-hidden ${dimmed ? 'opacity-60' : ''}`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead>
            <tr className="border-b border-slate-100 bg-[#F5F6FB]">
              <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Name</th>
              <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Email</th>
              <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Company</th>
              <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Role</th>
              <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Signed up</th>
              <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(entry => {
              const busy = loading[entry.id]
              const actionable = entry.status === 'pending'
              return (
                <tr key={entry.id} className="hover:bg-[#F5F6FB] transition-colors">
                  <td className="px-5 py-4">
                    <p className="font-semibold text-slate-900 text-sm">{entry.full_name}</p>
                    {entry.referral_source && (
                      <p className="text-[11px] text-slate-400 mt-0.5">via: {entry.referral_source}</p>
                    )}
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-600">{entry.email}</td>
                  <td className="px-5 py-4 text-sm text-slate-600">{entry.company || '—'}</td>
                  <td className="px-5 py-4 text-sm text-slate-600">
                    {entry.role_type ? (ROLE_LABELS[entry.role_type] ?? entry.role_type) : '—'}
                  </td>
                  <td className="px-5 py-4 text-xs text-slate-400">{formatDate(entry.created_at)}</td>
                  <td className="px-5 py-4"><StatusBadge status={entry.status} /></td>
                  <td className="px-5 py-4">
                    <div className="flex flex-col items-end gap-1.5">
                      <div className="flex items-center gap-2 justify-end">
                        {actionable && (
                          <>
                            <button
                              disabled={!!busy}
                              onClick={() => handle(entry.id, 'approve')}
                              className="flex items-center gap-1.5 text-xs font-semibold text-white bg-[#1B2850] hover:bg-[#2E4080] px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                            >
                              {busy === 'approve' ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                              Approve
                            </button>
                            <button
                              disabled={!!busy}
                              onClick={() => handle(entry.id, 'invite')}
                              className="flex items-center gap-1.5 text-xs font-semibold text-[#C4922A] border border-[#e8c88a] hover:bg-[#FDF3E3] px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                            >
                              {busy === 'invite' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
                              Invite
                            </button>
                            <button
                              disabled={!!busy}
                              onClick={() => handle(entry.id, 'decline')}
                              className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-red-600 border border-slate-200 hover:border-red-200 hover:bg-red-50 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                            >
                              {busy === 'decline' ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                              Decline
                            </button>
                          </>
                        )}
                        {entry.status === 'approved' && (
                          invited[entry.id]
                            ? <span className="text-xs text-green-600 font-semibold flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Sent</span>
                            : <button
                                disabled={!!busy}
                                onClick={() => handle(entry.id, 'invite')}
                                className="flex items-center gap-1.5 text-xs font-semibold text-[#C4922A] border border-[#e8c88a] hover:bg-[#FDF3E3] px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                              >
                                {busy === 'invite' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
                                Send invite
                              </button>
                        )}
                      </div>
                      {errors[entry.id] && (
                        <p className="text-[11px] text-red-600 text-right max-w-[200px]">{errors[entry.id]}</p>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )

  return (
    <div className="space-y-8">
      {pending.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
            Pending · {pending.length}
          </h3>
          <Table rows={pending} />
        </div>
      )}
      {approved.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
            Approved · {approved.length}
          </h3>
          <Table rows={approved} />
        </div>
      )}
      {declined.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
            Declined · {declined.length}
          </h3>
          <Table rows={declined} dimmed />
        </div>
      )}
    </div>
  )
}
