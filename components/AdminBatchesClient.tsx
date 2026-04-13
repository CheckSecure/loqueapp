'use client'

import { useState } from 'useRouter'
import { useRouter } from 'next/navigation'
import { Sparkles, Trash2, CheckCircle, Clock, Calendar, Users, TrendingUp } from 'lucide-react'

interface Batch {
  id: string
  batch_number: number
  status: string
  created_at: string
  approved_at: string | null
  start_date: string | null
  end_date: string | null
  suggestion_count: number
  member_count: number
}

export default function AdminBatchesClient({ batches }: { batches: Batch[] }) {
  const router = useRouter()
  const [generating, setGenerating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const handleGenerateBatch = async () => {
    setGenerating(true)
    const res = await fetch('/api/admin/generate-batch', { method: 'POST' })
    if (res.ok) {
      router.refresh()
    } else {
      const data = await res.json()
      alert(data.error || 'Failed to generate batch')
    }
    setGenerating(false)
  }

  const handleApproveBatch = async (batchId: string) => {
    const res = await fetch('/api/admin/approve-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId })
    })
    if (res.ok) router.refresh()
  }

  const handleDeleteBatch = async (batchId: string) => {
    if (!confirm('Are you sure you want to delete this batch?')) return
    
    setDeleting(batchId)
    const res = await fetch('/api/admin/delete-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId })
    })
    if (res.ok) router.refresh()
    setDeleting(null)
  }

  const activeBatch = batches.find(b => b.status === 'active')
  const pendingBatches = batches.filter(b => b.status === 'pending')
  const completedBatches = batches.filter(b => b.status === 'completed')

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Batch Management</h1>
            <p className="text-sm text-slate-500 mt-1">Generate and manage weekly recommendation batches</p>
          </div>
          <button
            onClick={handleGenerateBatch}
            disabled={generating}
            className="flex items-center gap-2 px-4 py-2 bg-[#1B2850] text-white text-sm font-semibold rounded-lg hover:bg-[#162040] disabled:opacity-50"
          >
            <Sparkles className="w-4 h-4" />
            {generating ? 'Generating...' : 'Generate New Batch'}
          </button>
        </div>

        {/* Active Batch */}
        {activeBatch && (
          <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-xl border border-green-200 p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-lg bg-green-600 flex items-center justify-center">
                  <CheckCircle className="w-6 h-6 text-white" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-slate-900">Batch #{activeBatch.batch_number}</h3>
                  <p className="text-sm text-green-700 font-medium">Active</p>
                </div>
              </div>
              <button
                onClick={() => handleDeleteBatch(activeBatch.id)}
                disabled={deleting === activeBatch.id}
                className="px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
              >
                Close Batch
              </button>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="bg-white rounded-lg p-4 border border-green-200">
                <div className="flex items-center gap-2 mb-2">
                  <Users className="w-4 h-4 text-slate-600" />
                  <p className="text-xs text-slate-500">Members</p>
                </div>
                <p className="text-2xl font-bold text-slate-900">{activeBatch.member_count}</p>
              </div>

              <div className="bg-white rounded-lg p-4 border border-green-200">
                <div className="flex items-center gap-2 mb-2">
                  <TrendingUp className="w-4 h-4 text-slate-600" />
                  <p className="text-xs text-slate-500">Suggestions</p>
                </div>
                <p className="text-2xl font-bold text-slate-900">{activeBatch.suggestion_count}</p>
              </div>

              <div className="bg-white rounded-lg p-4 border border-green-200">
                <div className="flex items-center gap-2 mb-2">
                  <Calendar className="w-4 h-4 text-slate-600" />
                  <p className="text-xs text-slate-500">Created</p>
                </div>
                <p className="text-sm font-semibold text-slate-900">
                  {new Date(activeBatch.created_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric'
                  })}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Pending Batches */}
        {pendingBatches.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-6">
            <h3 className="text-lg font-bold text-slate-900 mb-4">Pending Review</h3>
            <div className="space-y-4">
              {pendingBatches.map(batch => (
                <div key={batch.id} className="bg-amber-50 rounded-lg p-4 border border-amber-200">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-amber-500 flex items-center justify-center">
                        <Clock className="w-5 h-5 text-white" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-900">Batch #{batch.batch_number}</p>
                        <p className="text-xs text-slate-500">
                          {batch.suggestion_count} suggestions • {batch.member_count} members
                        </p>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => handleApproveBatch(batch.id)}
                        className="px-4 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700"
                      >
                        Approve & Go Live
                      </button>
                      <button
                        onClick={() => handleDeleteBatch(batch.id)}
                        disabled={deleting === batch.id}
                        className="px-4 py-2 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50"
                      >
                        {deleting === batch.id ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Completed Batches */}
        {completedBatches.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-6">
            <h3 className="text-lg font-bold text-slate-900 mb-4">Past Batches</h3>
            <div className="space-y-3">
              {completedBatches.map(batch => (
                <div key={batch.id} className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">Batch #{batch.batch_number}</p>
                      <p className="text-xs text-slate-500">
                        {batch.suggestion_count} suggestions • {batch.member_count} members • 
                        {' '}{new Date(batch.created_at).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric'
                        })}
                      </p>
                    </div>
                    <span className="px-3 py-1 bg-slate-200 text-slate-700 text-xs font-semibold rounded">
                      Completed
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {batches.length === 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
            <Sparkles className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-600 text-sm mb-2">No batches yet</p>
            <p className="text-slate-400 text-xs">Generate your first batch to start sending recommendations</p>
          </div>
        )}
      </div>
    </div>
  )
}
