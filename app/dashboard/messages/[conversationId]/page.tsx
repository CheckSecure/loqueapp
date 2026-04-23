'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import ConversationView from '@/components/messages/ConversationView'

interface ConversationData {
  id: string
  otherUser: {
    id: string
    full_name: string
    title: string | null
    company: string | null
    avatar_url: string | null
    subscription_tier: string | null | null
  }
  isOpportunityInitiated?: boolean
  opportunityTitle?: string | null
}

export default function ConversationPage() {
  const params = useParams()
  const conversationId = params.conversationId as string

  const [conversation, setConversation] = useState<ConversationData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchConversation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  async function fetchConversation() {
    try {
      const res = await fetch(`/api/messages/conversations/${conversationId}`)
      if (!res.ok) {
        if (res.status === 404) setError('Conversation not found')
        else if (res.status === 403) setError('You do not have access to this conversation')
        else setError('Failed to load conversation')
        return
      }
      const data = await res.json()
      setConversation(data.conversation)
    } catch (err) {
      console.error('Failed to fetch conversation:', err)
      setError('Failed to load conversation')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-16 bg-gray-100 rounded-lg" />
          <div className="h-96 bg-gray-100 rounded-lg" />
        </div>
      </div>
    )
  }

  if (error || !conversation) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600 mb-4">{error || 'Conversation not found'}</p>
          <Link href="/dashboard/messages" className="text-blue-600 hover:underline">
            ← Back to introductions
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link
          href="/dashboard/messages"
          className="text-sm text-gray-500 hover:text-gray-700 inline-flex items-center gap-1"
        >
          ← Introductions
        </Link>
      </div>

      <div className="bg-white border border-gray-200 rounded-t-lg p-4 flex items-center gap-3">
        {conversation.otherUser.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={conversation.otherUser.avatar_url}
            alt={conversation.otherUser.full_name}
            className="w-10 h-10 rounded-full object-cover"
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-600 font-medium">
            {conversation.otherUser.full_name[0]}
          </div>
        )}
        <div>
          <h1 className="font-medium text-gray-900">{conversation.otherUser.full_name}</h1>
          {conversation.otherUser.title && (
            <p className="text-sm text-gray-500">
              {conversation.otherUser.title}
              {conversation.otherUser.company && ` · ${conversation.otherUser.company}`}
            </p>
          )}
          {conversation.isOpportunityInitiated && (
            <div className="mt-1 flex items-center gap-1.5">
              <span className="inline-flex items-center rounded-full bg-[#C4922A]/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[#C4922A]">
                Opportunity
              </span>
              {conversation.opportunityTitle && (
                <span className="text-xs text-gray-500">{conversation.opportunityTitle}</span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white border border-t-0 border-gray-200 rounded-b-lg">
        <ConversationView conversationId={conversationId} />
      </div>
    </div>
  )
}
