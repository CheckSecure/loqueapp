'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { UserPlus, CheckCircle, XCircle, Mail, Clock, Send } from 'lucide-react'

interface WaitlistEntry {
  id: string
  full_name: string | null
  email: string
  company: string | null
  title: string | null
  // Pre-existing silent bug: 'role' and 'seniority' don't exist on the waitlist table.
  // Their values are always undefined. Out of scope for this commit; flagged for cleanup.
  role: string | null
  seniority: string | null
  linkedin_url: string | null
  referral_source: string | null
  status: string
  created_at: string
  invited_at: string | null
  invite_reminder_1_sent_at: string | null
  invite_reminder_2_sent_at: string | null
  referrals?: {
    referral_note: string
    status: string
    referrer: { id: string; full_name: string | null; account_status: string } | null
  } | null
}

export default function AdminWaitlistClient({ 
  waitlist, 
  counts 
}: { 
  waitlist: WaitlistEntry[]
  counts: { pending: number; approved: number; invited: number; declined: number }
}) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<'pending' | 'approved' | 'invited' | 'declined'>('pending')
  const [processing, setProcessing] = useState<string | null>(null)
  // Per-row "Mark as founding member" toggle. Lives client-side only; the value
  // is read at send-invite time and posted to the API. Resets on page refresh.
  const [markFounding, setMarkFounding] = useState<Record<string, boolean>>({})

  const toggleMarkFounding = (entryId: string) => {
    setMarkFounding(prev => ({ ...prev, [entryId]: !prev[entryId] }))
  }

  const handleApprove = async (entryId: string) => {
    setProcessing(entryId)
    const res = await fetch('/api/admin/waitlist/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId })
    })
    if (res.ok) router.refresh()
    setProcessing(null)
  }

  const handleDecline = async (entryId: string) => {
    setProcessing(entryId)
    const res = await fetch('/api/admin/waitlist/decline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId })
    })
    if (res.ok) router.refresh()
    setProcessing(null)
  }

  const postInvite = async (entryId: string, action: 'invite' | 'password_reset') => {
    const res = await fetch('/api/admin/send-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId, markAsFounding: !!markFounding[entryId], action }),
    })
    return res.json()
  }

  const handleSendInvite = async (entryId: string) => {
    setProcessing(entryId)
    try {
      let data = await postInvite(entryId, 'invite')
      // Active member: never silently reset via Resend — offer an explicit reset.
      if (!data.success && data.state === 'active') {
        if (window.confirm(`${data.message}\n\nSend a password reset email instead?`)) {
          data = await postInvite(entryId, 'password_reset')
        } else {
          setProcessing(null)
          return
        }
      }
      if (data.success) {
        alert(
          data.state === 'resent' ? 'Access email resent.'
          : data.state === 'password_reset_sent' ? 'Password reset email sent.'
          : 'Invite sent successfully.'
        )
        router.refresh()
      } else {
        alert(data.message || data.error || 'Could not complete the request.')
      }
    } catch {
      alert('Network error. Please try again.')
    }
    setProcessing(null)
  }

  const filtered = waitlist.filter(entry => entry.status === activeTab)

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Waitlist</h1>
          <p className="text-sm text-slate-500 mt-1">Review applications and send invites</p>
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="flex border-b border-slate-200">
            <button
              onClick={() => setActiveTab('pending')}
              className={`flex-1 px-6 py-3 text-sm font-semibold transition-colors ${
                activeTab === 'pending'
                  ? 'bg-[#1B2850] text-white'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-center gap-2">
                <Clock className="w-4 h-4" />
                Pending ({counts.pending})
              </div>
            </button>
            <button
              onClick={() => setActiveTab('approved')}
              className={`flex-1 px-6 py-3 text-sm font-semibold transition-colors ${
                activeTab === 'approved'
                  ? 'bg-[#1B2850] text-white'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-center gap-2">
                <CheckCircle className="w-4 h-4" />
                Approved ({counts.approved})
              </div>
            </button>
            <button
              onClick={() => setActiveTab('invited')}
              className={`flex-1 px-6 py-3 text-sm font-semibold transition-colors ${
                activeTab === 'invited'
                  ? 'bg-[#1B2850] text-white'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-center gap-2">
                <Mail className="w-4 h-4" />
                Invited ({counts.invited})
              </div>
            </button>
            <button
              onClick={() => setActiveTab('declined')}
              className={`flex-1 px-6 py-3 text-sm font-semibold transition-colors ${
                activeTab === 'declined'
                  ? 'bg-[#1B2850] text-white'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-center gap-2">
                <XCircle className="w-4 h-4" />
                Declined ({counts.declined})
              </div>
            </button>
          </div>

          {/* Content */}
          <div className="p-6">
            {/* Two-step workflow helper — Approve (Step 1) vs Send Invite (Step 2). Copy only. */}
            {activeTab === 'pending' && (
              <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                <span className="font-semibold">Step 1 · Approve.</span> Approving confirms this person and moves them to Approved — <span className="font-bold underline">no email is sent yet</span>. Send the invite from the Approved tab.
              </div>
            )}
            {activeTab === 'approved' && (
              <div className="mb-4 rounded-lg border border-slate-200 bg-slate-100 px-4 py-3 text-xs text-slate-700">
                <span className="font-semibold">Step 2 · Send Invite.</span> Approved members are ready to invite. Click Send Invite to email login access.
              </div>
            )}
            {filtered.length === 0 ? (
              <div className="text-center py-12">
                <UserPlus className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                <p className="text-slate-500 text-sm">No {activeTab} entries</p>
              </div>
            ) : (
              <div className="space-y-4">
                {filtered.map(entry => {
                  const isMarkedFounding = activeTab === 'approved' && !!markFounding[entry.id]
                  return (
                  <div
                    key={entry.id}
                    className={
                      isMarkedFounding
                        ? 'bg-brand-gold-soft rounded-lg p-4 border border-brand-gold/40'
                        : 'bg-slate-50 rounded-lg p-4 border border-slate-200'
                    }
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">
                              {entry.full_name || 'No name provided'}
                            </p>
                            <p className="text-xs text-slate-500">{entry.email}</p>
                          </div>
                        </div>
                        
                        <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                          {entry.title && (
                            <div>
                              <span className="text-slate-500">Title:</span>{' '}
                              <span className="text-slate-700">{entry.title}</span>
                            </div>
                          )}
                          {entry.company && (
                            <div>
                              <span className="text-slate-500">Company:</span>{' '}
                              <span className="text-slate-700">{entry.company}</span>
                            </div>
                          )}
                          {entry.role && (
                            <div>
                              <span className="text-slate-500">Role:</span>{' '}
                              <span className="text-slate-700">{entry.role}</span>
                            </div>
                          )}
                          {entry.seniority && (
                            <div>
                              <span className="text-slate-500">Seniority:</span>{' '}
                              <span className="text-slate-700">{entry.seniority}</span>
                            </div>
                          )}
                        </div>

                        {entry.referral_source === 'referral' && entry.referrals ? (
                          <>
                            <div className="flex items-center gap-1.5 mb-2">
                              <UserPlus className="w-3.5 h-3.5 text-[#C4922A]" />
                              <span className="text-xs font-medium text-[#C4922A] bg-[#FDF3E3] px-2 py-0.5 rounded-full">
                                Nominated by {entry.referrals.referrer?.full_name ?? 'unknown'}
                              </span>
                            </div>
                            {entry.referrals.referral_note && (
                              <div className="border-l-2 border-slate-200 pl-3 mb-2">
                                <p className="text-xs italic text-slate-500">"{entry.referrals.referral_note}"</p>
                              </div>
                            )}
                          </>
                        ) : entry.referral_source ? (
                          <p className="text-xs text-slate-600 bg-white rounded px-3 py-2 border border-slate-200 mb-2">
                            via: {entry.referral_source}
                          </p>
                        ) : null}

                        {entry.linkedin_url && (
                          <a 
                            href={entry.linkedin_url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="text-xs text-blue-600 hover:underline"
                          >
                            LinkedIn Profile →
                          </a>
                        )}

                        <p className="text-xs text-slate-400 mt-2">
                          Applied {new Date(entry.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric'
                          })}
                          {entry.invited_at && ` • Invited ${new Date(entry.invited_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric'
                          })}`}
                          {entry.invite_reminder_1_sent_at && ` • R1 ${new Date(entry.invite_reminder_1_sent_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric'
                          })}`}
                          {entry.invite_reminder_2_sent_at && ` • R2 ${new Date(entry.invite_reminder_2_sent_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric'
                          })}`}
                        </p>
                      </div>

                      <div className="flex gap-2">
                        {activeTab === 'pending' && (
                          <>
                            <button
                              onClick={() => handleApprove(entry.id)}
                              disabled={processing === entry.id}
                              className="px-4 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700 disabled:opacity-50"
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => handleDecline(entry.id)}
                              disabled={processing === entry.id}
                              className="px-4 py-2 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50"
                            >
                              Decline
                            </button>
                          </>
                        )}

                        {activeTab === 'approved' && (
                          <div className="flex flex-col items-end gap-2">
                            <label className="flex items-center gap-1.5 cursor-pointer text-xs font-medium text-slate-700 hover:text-slate-900 select-none">
                              <input
                                type="checkbox"
                                checked={!!markFounding[entry.id]}
                                onChange={() => toggleMarkFounding(entry.id)}
                                className="w-4 h-4 rounded border-slate-400 accent-brand-navy focus:ring-2 focus:ring-brand-gold"
                              />
                              Mark as founding member
                            </label>
                            <button
                              onClick={() => handleSendInvite(entry.id)}
                              disabled={processing === entry.id}
                              className="flex items-center gap-2 px-4 py-2 bg-[#1B2850] text-white text-sm font-semibold rounded-lg hover:bg-[#162040] disabled:opacity-50"
                            >
                              <Send className="w-4 h-4" />
                              {processing === entry.id ? 'Sending...' : 'Send Invite'}
                            </button>
                            {/* Secondary destructive action — reuses the existing handleDecline path
                                (POST /api/admin/waitlist/decline). No new route or decline logic;
                                confirm-gated. Sends the row to Declined, no email, referral synced. */}
                            <button
                              onClick={() => {
                                if (window.confirm('Remove this approved nomination? No email will be sent.')) {
                                  handleDecline(entry.id)
                                }
                              }}
                              disabled={processing === entry.id}
                              className="flex items-center gap-1.5 px-4 py-1.5 bg-white text-red-600 border border-red-200 text-xs font-medium rounded-lg hover:bg-red-50 disabled:opacity-50"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              Remove
                            </button>
                          </div>
                        )}

                        {activeTab === 'invited' && (
                          <button
                            onClick={() => handleSendInvite(entry.id)}
                            disabled={processing === entry.id}
                            className="px-4 py-2 border border-slate-300 text-slate-700 text-sm font-semibold rounded-lg hover:bg-slate-50 disabled:opacity-50"
                          >
                            {processing === entry.id ? 'Sending...' : 'Resend Access Email'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
