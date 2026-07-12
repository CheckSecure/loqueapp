'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import FormerMemberBadge from '@/components/FormerMemberBadge'
import PageHint from '@/components/PageHint'

interface Conversation {
  id: string
  otherUser: {
    id: string
    full_name: string
    title: string | null
    exact_job_title: string | null
    role_type: string | null
    company: string | null
    avatar_url: string | null
    subscription_tier: string | null | null
    account_status: string | null
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
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-20 bg-slate-100 rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
      <div className="mb-10">
        <h1 className="text-2xl sm:text-3xl font-bold text-brand-navy tracking-tight">Messages</h1>
        <p className="text-slate-500 text-sm mt-2">Private conversations with your professional network.</p>
      </div>

      <PageHint hintKey="messages">
        Conversations open here once you and another member are connected — there&apos;s no cold outreach on Andrel.
      </PageHint>

      {conversations.length === 0 ? (
        <div className="bg-white border border-slate-200/70 rounded-2xl p-14 text-center shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-brand-gold mb-3">Your network</p>
          <p className="text-slate-900 font-semibold mb-2">No conversations yet</p>
          <p className="text-sm text-slate-500 max-w-sm mx-auto leading-relaxed">
            When you and another member express mutual interest, your conversation will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {conversations.map(conv => {
            const isUnread = conv.unreadCount > 0
            const isFormer = conv.otherUser?.account_status === 'deactivated'
            return (
            <Link
              key={conv.id}
              href={`/dashboard/messages/${conv.id}`}
              className={`group flex items-center gap-4 rounded-xl px-5 py-4 transition-all hover:shadow-sm ${
                isUnread
                  ? 'border-y border-r border-slate-200/70 border-l-[3px] border-l-brand-gold bg-brand-cream/20'
                  : isFormer
                    ? 'border border-slate-200/60 bg-slate-50/60'
                    : 'border border-slate-200/70 bg-white hover:border-slate-300'
              }`}
            >
              <div className="flex-shrink-0">
                {conv.otherUser?.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={conv.otherUser.avatar_url}
                    alt={conv.otherUser.full_name}
                    className={`w-14 h-14 rounded-full object-cover ring-1 ring-slate-200 ${isFormer ? 'grayscale opacity-70' : ''}`}
                  />
                ) : (
                  <div className={`w-14 h-14 rounded-full bg-brand-navy/[0.06] ring-1 ring-brand-navy/10 flex items-center justify-center text-brand-navy font-semibold text-lg ${isFormer ? 'opacity-70 grayscale' : ''}`}>
                    {conv.otherUser?.full_name?.[0] || '?'}
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className={`text-[15px] font-semibold truncate ${isFormer ? 'text-slate-500' : 'text-brand-navy'}`}>
                    {isFormer ? 'Former member' : (conv.otherUser?.full_name || 'Unknown')}
                  </h3>
                  {conv.lastMessage && (
                    <span className="text-[11px] text-slate-400/80 tabular-nums flex-shrink-0">
                      {formatDistanceToNow(new Date(conv.lastMessage.created_at), { addSuffix: true })}
                    </span>
                  )}
                </div>

                {!isFormer && (conv.otherUser?.exact_job_title || conv.otherUser?.title || conv.otherUser?.role_type) && (
                  <p className="text-xs text-slate-500 truncate mt-0.5">
                    {conv.otherUser.exact_job_title || conv.otherUser.title || conv.otherUser.role_type}
                    {conv.otherUser.company && ` · ${conv.otherUser.company}`}
                  </p>
                )}

                {isFormer && (
                  <FormerMemberBadge />
                )}

                {conv.isOpportunityInitiated && (
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <span className="inline-flex items-center rounded-full border border-brand-gold/30 bg-brand-gold-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-gold">
                      Opportunity
                    </span>
                    {conv.opportunityTitle && (
                      <span className="text-xs text-slate-500 truncate">{conv.opportunityTitle}</span>
                    )}
                  </div>
                )}

                {conv.lastMessage ? (
                  <p className={`text-sm truncate mt-2 ${conv.unreadCount > 0 ? 'font-semibold text-slate-900' : 'text-slate-500'}`}>
                    {conv.lastMessage.is_system
                      ? <span className="italic text-slate-400">Introduction made — say hello</span>
                      : conv.lastMessage.content}
                  </p>
                ) : (
                  <p className="text-sm italic text-slate-400 mt-2">
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
            )
          })}
        </div>
      )}
    </div>
  )
}
