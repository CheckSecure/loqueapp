'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle, XCircle, Clock, Sparkles, AlertCircle } from 'lucide-react'
import { adminApproveIntro, adminRejectIntro } from '@/app/actions'

interface IntroRequest {
  id: string
  status: string
  note: string | null
  created_at: string
  requester: any
  target: any
}

export default function AdminIntrosClient({ introRequests }: { introRequests: IntroRequest[] }) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<'pending' | 'suggested' | 'approved' | 'rejected'>('pending')
  const [processing, setProcessing] = useState<string | null>(null)

  const handleApprove = async (requestId: string) => {
    setProcessing(requestId)
    await adminApproveIntro(requestId)
    router.refresh()
    setProcessing(null)
  }

  const handleReject = async (requestId: string) => {
    setProcessing(requestId)
    await adminRejectIntro(requestId)
    router.refresh()
    setProcessing(null)
  }

  const filtered = introRequests.filter(req => req.status === activeTab)

  const counts = {
    pending: introRequests.filter(r => r.status === 'pending').length,
    suggested: introRequests.filter(r => r.status === 'suggested').length,
    approved: introRequests.filter(r => r.status === 'approved').length,
    rejected: introRequests.filter(r => r.status === 'rejected').length,
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Intro Requests</h1>
          <p className="text-sm text-slate-500 mt-1">Review and manage member introduction requests</p>
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
              onClick={() => setActiveTab('suggested')}
              className={`flex-1 px-6 py-3 text-sm font-semibold transition-colors ${
                activeTab === 'suggested'
                  ? 'bg-[#1B2850] text-white'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-center gap-2">
                <Sparkles className="w-4 h-4" />
                Suggested ({counts.suggested})
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
              onClick={() => setActiveTab('rejected')}
              className={`flex-1 px-6 py-3 text-sm font-semibold transition-colors ${
                activeTab === 'rejected'
                  ? 'bg-[#1B2850] text-white'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-center gap-2">
                <XCircle className="w-4 h-4" />
                Rejected ({counts.rejected})
              </div>
            </button>
          </div>

          {/* Content */}
          <div className="p-6">
            {filtered.length === 0 ? (
              <div className="text-center py-12">
                <AlertCircle className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                <p className="text-slate-500 text-sm">No {activeTab} intro requests</p>
              </div>
            ) : (
              <div className="space-y-4">
                {filtered.map(request => (
                  <div key={request.id} className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-4 mb-3">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">
                              {request.requester?.full_name || 'Unknown'}
                            </p>
                            <p className="text-xs text-slate-500">
                              {request.requester?.title} • {request.requester?.company}
                            </p>
                          </div>
                          <span className="text-slate-400">→</span>
                          <div>
                            <p className="text-sm font-semibold text-slate-900">
                              {request.target?.full_name || 'Unknown'}
                            </p>
                            <p className="text-xs text-slate-500">
                              {request.target?.title} • {request.target?.company}
                            </p>
                          </div>
                        </div>
                        {request.note && (
                          <p className="text-xs text-slate-600 bg-white rounded px-3 py-2 border border-slate-200">
                            "{request.note}"
                          </p>
                        )}
                        <p className="text-xs text-slate-400 mt-2">
                          {new Date(request.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit'
                          })}
                        </p>
                      </div>

                      {activeTab === 'pending' && (
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleApprove(request.id)}
                            disabled={processing === request.id}
                            className="px-4 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700 disabled:opacity-50"
                          >
                            {processing === request.id ? 'Approving...' : 'Approve'}
                          </button>
                          <button
                            onClick={() => handleReject(request.id)}
                            disabled={processing === request.id}
                            className="px-4 py-2 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50"
                          >
                            {processing === request.id ? 'Rejecting...' : 'Reject'}
                          </button>
                        </div>
                      )}

                      {activeTab === 'suggested' && (
                        <span className="px-3 py-1 bg-blue-100 text-blue-700 text-xs font-semibold rounded">
                          Auto-generated
                        </span>
                      )}
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
