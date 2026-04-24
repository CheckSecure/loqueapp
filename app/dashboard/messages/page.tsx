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
  isOpportunityInitiated?: boolean
  opportunityTitle?: string | null
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
            <div key={i} className="h-20 bg-slate-100 rounded-2xl" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">Messages</h1>
        <p className="text-slate-500 text-sm mt-2">Your active conversations.</p>
      </div>

      {conversations.length === 0 ? (
        <div className="bg-white border border-slate-100 rounded-2xl p-12 text-center shadow-sm">
          <p className="text-slate-900 font-semibold mb-2">No conversations yet</p>
          <p className="text-sm text-slate-500 max-w-sm mx-auto leading-relaxed">
            When you and another member express mutual interest, your conversation will appear here.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-slate-100 rounded-2xl divide-y divide-slate-100 overflow-hidden shadow-sm">
          {conversations.map(conv => (
            <Link
              key={conv.id}
              href={`/dashboard/messages/${conv.id}`}
              className="flex items-center gap-4 p-4 hover:bg-slate-50 transition-colors"
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
                  <div className="w-12 h-12 rounded-full bg-slate-200 flex items-center justify-center text-slate-600 font-medium">
                    {conv.otherUser?.full_name?.[0] || '?'}
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-semibold text-slate-900 truncate">
                    {conv.otherUser?.full_name || 'Unknown'}
                  </h3>
                  {conv.lastMessage && (
                    <span className="text-xs text-slate-400 flex-shrink-0">
                      {formatDistanceToNow(new Date(conv.lastMessage.created_at), { addSuffix: true })}
                    </span>
                  )}
                </div>

                {conv.otherUser?.title && (
                  <p className="text-sm text-slate-500 truncate">
                    {conv.otherUser.title}
                    {conv.otherUser.company && ` · ${conv.otherUser.company}`}
                  </p>
                )}

                {conv.isOpportunityInitiated && (
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="inline-flex items-center rounded-full bg-brand-gold-soft px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-brand-gold">
                      Opportunity
                    </span>
                    {conv.opportunityTitle && (
                      <span className="text-xs text-slate-500 truncate">{conv.opportunityTitle}</span>
                    )}
                  </div>
                )}

                {conv.lastMessage ? (
                  <p className={`text-sm truncate mt-1 ${conv.unreadCount > 0 ? 'font-semibold text-slate-900' : 'text-slate-500'}`}>
                    {conv.lastMessage.is_system
                      ? <span className="italic text-slate-400">Introduction made — say hello</span>
                      : conv.lastMessage.content}
                  </p>
                ) : (
                  <p className="text-sm italic text-slate-400 mt-1">
                    Introduction made — say hello to start the conversation
                  </p>
                )}
              </div>

              {conv.unreadCount > 0 && (
                <div className="flex-shrink-0">
                  <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-brand-gold text-white text-xs font-semibold">
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
