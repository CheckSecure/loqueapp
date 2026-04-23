'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'

interface Conversation {
  id: string
  otherUser: {
    id: string
    full_name: string
    title: string | null
    company: string | null
    avatar_url: string | null
    subscription_tier: string | null | null
  } | null
  lastMessage: {
    id: string
    content: string
    sender_id: string
    is_system: boolean
    created_at: string
  } | null
  unreadCount: number
  firstMessageSentAt: string | null
  lastMessageAt: string | null
  messageCount: number
  createdAt: string
}

export default function MessagesPage() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchConversations()
  }, [])

  async function fetchConversations() {
    try {
      const res = await fetch('/api/messages/conversations')
      const data = await res.json()
      setConversations(data.conversations || [])
    } catch (err) {
      console.error('Failed to fetch conversations:', err)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-20 bg-gray-100 rounded-lg" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-serif text-gray-900">Introductions</h1>
        <p className="text-gray-600 mt-1">Your active conversations</p>
      </div>

      {conversations.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
          <p className="text-gray-700 font-medium mb-2">No introductions yet</p>
          <p className="text-sm text-gray-500">
            When you and another member express mutual interest, your conversation will appear here.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100 overflow-hidden">
          {conversations.map(conv => (
            <Link
              key={conv.id}
              href={`/dashboard/messages/${conv.id}`}
              className="flex items-center gap-4 p-4 hover:bg-gray-50 transition-colors"
            >
              <div className="flex-shrink-0">
                {conv.otherUser?.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={conv.otherUser.avatar_url}
                    alt={conv.otherUser.full_name}
                    className="w-12 h-12 rounded-full object-cover"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center text-gray-600 font-medium">
                    {conv.otherUser?.full_name?.[0] || '?'}
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-medium text-gray-900 truncate">
                    {conv.otherUser?.full_name || 'Unknown'}
                  </h3>
                  {conv.lastMessage && (
                    <span className="text-xs text-gray-400 flex-shrink-0">
                      {formatDistanceToNow(new Date(conv.lastMessage.created_at), { addSuffix: true })}
                    </span>
                  )}
                </div>

                {conv.otherUser?.title && (
                  <p className="text-sm text-gray-500 truncate">
                    {conv.otherUser.title}
                    {conv.otherUser.company && ` · ${conv.otherUser.company}`}
                  </p>
                )}

                {conv.lastMessage ? (
                  <p className={`text-sm truncate mt-1 ${conv.unreadCount > 0 ? 'font-medium text-gray-900' : 'text-gray-500'}`}>
                    {conv.lastMessage.is_system
                      ? <span className="italic text-gray-400">Introduction made — say hello</span>
                      : conv.lastMessage.content}
                  </p>
                ) : (
                  <p className="text-sm italic text-gray-400 mt-1">
                    Introduction made — say hello to start the conversation
                  </p>
                )}
              </div>

              {conv.unreadCount > 0 && (
                <div className="flex-shrink-0">
                  <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-blue-600 text-white text-xs font-medium">
                    {conv.unreadCount}
                  </span>
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
