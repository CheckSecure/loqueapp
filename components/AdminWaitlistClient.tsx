'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { UserPlus, CheckCircle, XCircle, Mail, Clock, Send, MessageSquare } from 'lucide-react'
import { buildRecommendationIntroEmail } from '@/lib/email/recommendationIntro'

interface EmailLifecycle {
  state: string
  label: string
  lastEmail: 'invite' | 'reminder_1' | 'reminder_2' | null
  lastEmailAt: string | null
  nextEmail: 'reminder_1' | 'reminder_2' | null
  nextDueAt: string | null
  canSendActivationEmail: boolean
  receivedFirstMatching: boolean
  excludedReason: string | null
}

// Lifecycle sub-filters for the Invited tab.
type LifecycleFilter = 'all' | 'newly' | 'r1_due' | 'r2_due' | 'seq_done' | 'july_yes' | 'july_no'
const LIFECYCLE_FILTERS: { key: LifecycleFilter; label: string }[] = [
  { key: 'all', label: 'All incomplete' },
  { key: 'newly', label: 'Newly invited / no follow-up' },
  { key: 'r1_due', label: 'Reminder 1 due' },
  { key: 'r2_due', label: 'Reminder 2 due' },
  { key: 'seq_done', label: 'Sequence complete' },
  { key: 'july_yes', label: 'Received July reminder' },
  { key: 'july_no', label: 'No July reminder' },
]

function shortDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Single definition used by both the sub-filter and its per-chip counts. All
// state comes from the server-computed shared lifecycle module.
function matchesLifecycleFilter(entry: WaitlistEntry, key: LifecycleFilter): boolean {
  const lc = entry.lifecycle
  switch (key) {
    case 'all': return true
    // Newly invited / no follow-up: neither reminder sent (July does not disqualify).
    case 'newly': return !entry.invite_reminder_1_sent_at && !entry.invite_reminder_2_sent_at
    case 'r1_due': return lc?.state === 'reminder_1_due'
    case 'r2_due': return lc?.state === 'reminder_2_due'
    case 'seq_done': return lc?.state === 'reminder_2_sent'
    case 'july_yes': return !!lc?.receivedFirstMatching
    case 'july_no': return !lc?.receivedFirstMatching
    default: return true
  }
}

interface WaitlistEntry {
  id: string
  full_name: string | null
  email: string
  company: string | null
  title: string | null
  // Pre-existing silent bug: 'role' and 'seniority' don't exist on the waitlist table.
  // Their values are always undefined. Optional so the type is honest; still flagged for cleanup.
  role?: string | null
  seniority?: string | null
  linkedin_url: string | null
  referral_source: string | null
  status: string
  created_at: string
  invited_at: string | null
  invite_reminder_1_sent_at: string | null
  invite_reminder_2_sent_at: string | null
  first_matching_reminder_sent_at: string | null
  lifecycle?: EmailLifecycle
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
  counts: { pending: number; approved: number; contacted: number; invited: number; declined: number }
}) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<'pending' | 'approved' | 'contacted' | 'invited' | 'declined'>('pending')
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleFilter>('all')
  const [processing, setProcessing] = useState<string | null>(null)

  // Warm recommendation-email preview/confirm modal state.
  const [previewEntry, setPreviewEntry] = useState<WaitlistEntry | null>(null)
  const [sending, setSending] = useState(false)
  const [block, setBlock] = useState<{ reason: string; requiresReason?: boolean; overridable?: boolean } | null>(null)
  const [overrideReason, setOverrideReason] = useState('')
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

  const openPreview = (entry: WaitlistEntry) => {
    setBlock(null)
    setOverrideReason('')
    setPreviewEntry(entry)
  }

  // Send the warm recommendation email (with optional founder override).
  const sendRecommendation = async (override: boolean) => {
    if (!previewEntry) return
    setSending(true)
    try {
      const res = await fetch('/api/admin/send-recommendation-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId: previewEntry.id, override, overrideReason: overrideReason.trim() || undefined }),
      })
      const data = await res.json()
      if (res.status === 409 || (res.status === 400 && data.requiresReason) || res.status === 403) {
        // Duplicate protection blocked the send — surface the reason, offer override.
        setBlock({ reason: data.reason || 'This nominee may be a duplicate.', requiresReason: data.requiresReason, overridable: data.overridable })
        setSending(false)
        return
      }
      if (!res.ok || !data.ok) {
        alert(data.error || 'Could not send the recommendation email.')
        setSending(false)
        return
      }
      setPreviewEntry(null)
      setBlock(null)
      setOverrideReason('')
      router.refresh()
    } catch {
      alert('Network error. Please try again.')
    }
    setSending(false)
  }

  // Invited tab also honors the lifecycle sub-filter (shared matcher).
  const filtered = waitlist
    .filter(entry => entry.status === activeTab)
    .filter(entry => activeTab !== 'invited' || matchesLifecycleFilter(entry, lifecycleFilter))

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
              onClick={() => setActiveTab('contacted')}
              className={`flex-1 px-6 py-3 text-sm font-semibold transition-colors ${
                activeTab === 'contacted'
                  ? 'bg-[#1B2850] text-white'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-center gap-2">
                <MessageSquare className="w-4 h-4" />
                Contacted ({counts.contacted})
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
                <span className="font-semibold">Step 2 · Send Recommendation Email.</span> Send a warm, personal introduction (no login/credentials) to start the relationship — you&apos;ll preview and confirm it first. Send the official access invite later, once they&apos;re interested.
              </div>
            )}
            {activeTab === 'contacted' && (
              <div className="mb-4 rounded-lg border border-slate-200 bg-slate-100 px-4 py-3 text-xs text-slate-700">
                <span className="font-semibold">Step 3 · Send Invite.</span> These nominees have received the warm recommendation email. Once they&apos;re interested, click Send Invite to email official login access.
              </div>
            )}
            {activeTab === 'invited' && (
              <div className="mb-4">
                <p className="text-xs font-medium text-slate-500 mb-2">Email lifecycle</p>
                <div className="flex flex-wrap gap-2">
                  {LIFECYCLE_FILTERS.map(f => {
                    const count = waitlist.filter(e => e.status === 'invited' && matchesLifecycleFilter(e, f.key)).length
                    return (
                      <button
                        key={f.key}
                        onClick={() => setLifecycleFilter(f.key)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                          lifecycleFilter === f.key
                            ? 'bg-[#1B2850] text-white border-[#1B2850]'
                            : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        {f.label} ({count})
                      </button>
                    )
                  })}
                </div>
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

                        {activeTab === 'invited' && entry.lifecycle && (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                            <span className="font-semibold text-slate-700 bg-slate-200 px-2 py-0.5 rounded-full">
                              {entry.lifecycle.label}
                            </span>
                            <span className="text-slate-500">
                              Last: {entry.lifecycle.lastEmail ? `${entry.lifecycle.lastEmail.replace('_', ' ')} · ${shortDate(entry.lifecycle.lastEmailAt)}` : 'none'}
                            </span>
                            <span className="text-slate-400">•</span>
                            <span className="text-slate-500">
                              Next: {entry.lifecycle.nextEmail ? `${entry.lifecycle.nextEmail.replace('_', ' ')} · due ${shortDate(entry.lifecycle.nextDueAt)}` : 'none'}
                            </span>
                            {entry.lifecycle.receivedFirstMatching && (
                              <span className="text-[#C4922A] bg-[#FDF3E3] px-2 py-0.5 rounded-full font-medium">July reminder ✓</span>
                            )}
                          </div>
                        )}
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
                            {/* Primary next step: warm recommendation email (preview + confirm). */}
                            <button
                              onClick={() => openPreview(entry)}
                              disabled={processing === entry.id}
                              className="flex items-center gap-2 px-4 py-2 bg-[#1B2850] text-white text-sm font-semibold rounded-lg hover:bg-[#162040] disabled:opacity-50"
                            >
                              <MessageSquare className="w-4 h-4" />
                              Send Recommendation Email
                            </button>
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
                              className="flex items-center gap-2 px-4 py-1.5 bg-white text-[#1B2850] border border-slate-300 text-xs font-medium rounded-lg hover:bg-slate-50 disabled:opacity-50"
                            >
                              <Send className="w-3.5 h-3.5" />
                              {processing === entry.id ? 'Sending...' : 'Skip to Send Invite'}
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

                        {activeTab === 'contacted' && (
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
                            <button
                              onClick={() => openPreview(entry)}
                              disabled={processing === entry.id}
                              className="flex items-center gap-1.5 px-4 py-1.5 bg-white text-[#1B2850] border border-slate-300 text-xs font-medium rounded-lg hover:bg-slate-50 disabled:opacity-50"
                            >
                              <MessageSquare className="w-3.5 h-3.5" />
                              Resend Recommendation
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

      {previewEntry && (() => {
        const recommender = previewEntry.referrals?.referrer?.full_name || 'A founding member'
        const { subject, text } = buildRecommendationIntroEmail({
          recommenderName: recommender,
          nomineeName: previewEntry.full_name || 'there',
          manageUrl: 'https://www.andrel.app/manage-information',
        })
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-900/50" onClick={() => !sending && setPreviewEntry(null)} />
            <div className="relative bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-lg max-h-[90vh] overflow-y-auto">
              <div className="px-6 py-4 border-b border-slate-100">
                <h3 className="text-sm font-bold text-slate-900">Preview recommendation email</h3>
                <p className="text-xs text-slate-500 mt-0.5">Review, then confirm to send. Nothing sends automatically.</p>
              </div>
              <div className="px-6 py-4 space-y-3">
                <div className="grid grid-cols-[90px_1fr] gap-1 text-xs">
                  <span className="text-slate-400">Recipient</span>
                  <span className="text-slate-800">{previewEntry.full_name || '—'} · {previewEntry.email}</span>
                  <span className="text-slate-400">Recommender</span>
                  <span className="text-slate-800">{recommender}</span>
                  <span className="text-slate-400">Subject</span>
                  <span className="text-slate-800 font-medium">{subject}</span>
                </div>
                <pre className="whitespace-pre-wrap font-sans text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-4">{text}</pre>
                {block && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 space-y-2">
                    <p><span className="font-semibold">Duplicate check:</span> {block.reason}</p>
                    {block.requiresReason && (
                      <input
                        value={overrideReason}
                        onChange={e => setOverrideReason(e.target.value)}
                        placeholder="Reason to re-engage (required)"
                        className="w-full px-2 py-1.5 text-xs border border-amber-300 rounded"
                      />
                    )}
                    {block.overridable === false && (
                      <p className="text-red-600">This cannot be overridden.</p>
                    )}
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2">
                <button
                  onClick={() => setPreviewEntry(null)}
                  disabled={sending}
                  className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                {block ? (
                  block.overridable !== false && (
                    <button
                      onClick={() => sendRecommendation(true)}
                      disabled={sending || (!!block.requiresReason && !overrideReason.trim())}
                      className="px-4 py-2 text-sm font-semibold text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-50"
                    >
                      {sending ? 'Sending…' : 'Override & send'}
                    </button>
                  )
                ) : (
                  <button
                    onClick={() => sendRecommendation(false)}
                    disabled={sending}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-[#1B2850] rounded-lg hover:bg-[#162040] disabled:opacity-50"
                  >
                    <MessageSquare className="w-4 h-4" />
                    {sending ? 'Sending…' : 'Confirm & send'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
