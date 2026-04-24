'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

interface Message {
  id: string
  conversation_id: string
  sender_id: string | null
  content: string
  is_system: boolean
  created_at: string
  read_at?: string | null
  sender?: {
    id: string
    full_name: string | null
    title: string | null
    company: string | null
  } | null
}

interface ConversationViewProps {
  conversationId: string
}

export default function ConversationView({ conversationId }: ConversationViewProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [suggestedPrompts, setSuggestedPrompts] = useState<string[]>([])
  const [matchInsights, setMatchInsights] = useState<Array<{text: string; kind: string}>>([])
  const [firstMessageSentAt, setFirstMessageSentAt] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const router = useRouter()

  const scrollRef = useRef<HTMLDivElement>(null)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null)
    })
  }, [])

  useEffect(() => {
    fetchMessages(true)

    // Mark inbound unread messages as read. Fire-and-forget: if it fails,
    // the sidebar unread count won't update but nothing else breaks.
    fetch('/api/messages/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    })
      .then(res => {
        if (res.ok) router.refresh()
      })
      .catch(() => {
        /* non-fatal */
      })

    intervalRef.current = setInterval(() => fetchMessages(false), 5000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  useEffect(() => {
    // Scroll to bottom whenever new messages arrive
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length])

  async function fetchMessages(showLoading: boolean) {
    if (showLoading) setLoading(true)
    try {
      const res = await fetch(`/api/messages/list?conversationId=${conversationId}`)
      if (!res.ok) {
        if (showLoading) setError('Failed to load messages')
        return
      }
      const data = await res.json()
      setMessages(data.messages || [])
      setSuggestedPrompts(data.suggestedPrompts || [])
      setMatchInsights(data.matchInsights || [])
      setFirstMessageSentAt(data.conversationMetadata?.firstMessageSentAt ?? null)
      setError(null)
    } catch (err) {
      console.error('[ConversationView] fetch error:', err)
      if (showLoading) setError('Failed to load messages')
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  async function handleSend() {
    const trimmed = input.trim()
    if (!trimmed || sending) return

    setSending(true)
    try {
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, content: trimmed })
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'Failed to send message')
        return
      }
      setInput('')
      await fetchMessages(false)
    } catch (err) {
      console.error('[ConversationView] send error:', err)
      setError('Failed to send message')
    } finally {
      setSending(false)
    }
  }

  function handlePromptClick(prompt: string) {
    setInput(prompt)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const showPrompts = !firstMessageSentAt && suggestedPrompts.length > 0

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-3">
          <div className="h-20 bg-gray-100 rounded-lg" />
          <div className="h-12 bg-gray-100 rounded-lg w-2/3" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col" style={{ height: '60vh', minHeight: 400 }}>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 space-y-4"
      >
        {!firstMessageSentAt && (
          <div className="text-center text-xs text-gray-500 italic pt-1 pb-2">
            This introduction was made based on shared professional alignment.
          </div>
        )}

        {matchInsights.length > 0 && (
          <div className="bg-[#FDF9F3] border border-[#C4922A]/25 rounded-lg px-4 py-3">
            <p className="text-[11px] font-semibold text-[#C4922A] uppercase tracking-wider mb-1.5">Why you were introduced</p>
            <ul className="text-xs text-slate-700 space-y-1">
              {matchInsights.map((insight, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="text-[#C4922A] mt-0.5">•</span>
                  <span>{insight.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {messages.length === 0 && !showPrompts && (
          <p className="text-center text-sm text-gray-400 italic py-8">
            No messages yet. Say hello to get the conversation started.
          </p>
        )}

        {messages.map(msg => {
          if (msg.is_system) {
            return (
              <div
                key={msg.id}
                className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-sm text-gray-700 whitespace-pre-line"
              >
                {msg.content}
              </div>
            )
          }

          const isMine = msg.sender_id === currentUserId
          return (
            <div
              key={msg.id}
              className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
                  isMine
                    ? 'bg-[#1B2850] text-white'
                    : 'bg-gray-100 text-gray-900'
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
              </div>
            </div>
          )
        })}
      </div>

      {showPrompts && (
        <div className="px-4 pb-3 pt-2 border-t border-gray-100">
          <p className="text-xs text-gray-500 mb-2">Suggested conversation starters</p>
          <div className="flex flex-wrap gap-2">
            {suggestedPrompts.map((prompt, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handlePromptClick(prompt)}
                className="text-xs px-3 py-1.5 border border-gray-300 rounded-full text-gray-700 hover:bg-gray-50 hover:border-gray-400 transition-colors text-left"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="px-4 py-2 border-t border-red-100 bg-red-50 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="border-t border-gray-200 p-3 flex gap-2 items-end">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Write a message..."
          rows={1}
          className="flex-1 resize-none border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent"
          style={{ maxHeight: 120 }}
          disabled={sending}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!input.trim() || sending}
          className="px-4 py-2 bg-[#1B2850] text-white text-sm font-medium rounded-lg hover:bg-[#2E4080] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
