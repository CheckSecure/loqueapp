'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface PendingIntroduction {
  matchId: string
  createdAt: string
  otherUser: {
    id: string
    name: string
    title: string | null
    company: string | null
  }
}

export default function PendingIntroductionsPage() {
  const router = useRouter()
  const [pending, setPending] = useState<PendingIntroduction[]>([])
  const [loading, setLoading] = useState(true)
  const [activating, setActivating] = useState<string | null>(null)

  useEffect(() => {
    loadPending()
  }, [])

  const loadPending = async () => {
    try {
      const res = await fetch('/api/pending-introductions/list')
      const data = await res.json()
      setPending(data.pendingIntroductions || [])
    } catch (error) {
      console.error('Failed to load pending introductions:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleActivate = async (matchId: string) => {
    setActivating(matchId)
    try {
      const res = await fetch('/api/pending-introductions/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId })
      })

      const data = await res.json()

      if (res.ok) {
        // Success - redirect to network
        router.push('/dashboard/network')
      } else {
        alert(data.message || 'Unable to activate introduction.')
      }
    } catch (error) {
      alert('Failed to activate introduction')
    } finally {
      setActivating(null)
    }
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <div className="animate-pulse">Loading pending introductions...</div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Pending Introductions</h1>
        <p className="text-gray-600">
          Confirmed introductions ready to activate
        </p>
      </div>

      {pending.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <p className="text-gray-500">No pending introductions</p>
        </div>
      ) : (
        <div className="space-y-4">
          {pending.map((intro) => (
            <div
              key={intro.matchId}
              className="bg-white rounded-lg border border-gray-200 p-6 hover:border-gray-300 transition"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">
                    {intro.otherUser.name}
                  </h3>
                  {intro.otherUser.title && (
                    <p className="text-gray-600 text-sm mb-1">
                      {intro.otherUser.title}
                      {intro.otherUser.company && ` at ${intro.otherUser.company}`}
                    </p>
                  )}
                  <p className="text-gray-500 text-sm mt-2">
                    Confirmed introduction waiting
                  </p>
                </div>

                <div className="ml-4">
                  <button
                    onClick={() => handleActivate(intro.matchId)}
                    disabled={activating === intro.matchId}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    {activating === intro.matchId ? 'Activating...' : 'Activate Introduction'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-sm text-blue-900">
            These introductions are ready to activate at no additional charge. You already paid when expressing interest.
          </p>
        </div>
      )}
    </div>
  )
}
