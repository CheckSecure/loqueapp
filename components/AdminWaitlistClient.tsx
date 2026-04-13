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
  role: string | null
  seniority: string | null
  linkedin_url: string | null
  referral_source: string | null
  status: string
  created_at: string
  invited_at: string | null
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

  const handleSendInvite = async (entryId: string, email: string) => {
    setProcessing(entryId)
    const res = await fetch('/api/admin/waitlist/send-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId, email })
    })
    if (res.ok) {
      alert('Invite sent!')
      router.refresh()
    } else {
      alert('Failed to send invite')
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
            {filtered.length === 0 ? (
              <div className="text-center py-12">
                <UserPlus className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                <p className="text-slate-500 text-sm">No {activeTab} entries</p>
              </div>
            ) : (
              <div className="space-y-4">
                {filtered.map(entry => (
                  <div key={entry.id} className="bg-slate-50 rounded-lg p-4 border border-slate-200">
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

                        {entry.referral_source && (
                          <p className="text-xs text-slate-600 bg-white rounded px-3 py-2 border border-slate-200 mb-2">
                            via: {entry.referral_source}
                          </p>
                        )}

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
                          <button
                            onClick={() => handleSendInvite(entry.id, entry.email)}
                            disabled={processing === entry.id}
                            className="flex items-center gap-2 px-4 py-2 bg-[#1B2850] text-white text-sm font-semibold rounded-lg hover:bg-[#162040] disabled:opacity-50"
                          >
                            <Send className="w-4 h-4" />
                            {processing === entry.id ? 'Sending...' : 'Send Invite'}
                          </button>
                        )}

                        {activeTab === 'invited' && (
                          <button
                            onClick={() => handleSendInvite(entry.id, entry.email)}
                            disabled={processing === entry.id}
                            className="px-4 py-2 border border-slate-300 text-slate-700 text-sm font-semibold rounded-lg hover:bg-slate-50 disabled:opacity-50"
                          >
                            Resend
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
