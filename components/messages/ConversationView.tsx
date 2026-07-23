'use client'

import { useEffect, useLayoutEffect, useCallback, useRef, useState, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatMessageTime, formatDaySeparator, shouldShowDaySeparator } from '@/lib/messageTime'
import { canEditMessage } from '@/lib/messaging/editWindow'
import { clampComposerHeight, COMPOSER_MIN_HEIGHT, COMPOSER_MAX_HEIGHT, COMPOSER_MIN_ROWS } from '@/lib/messaging/composerHeight'

// useLayoutEffect runs before paint (no resize flicker) but warns during SSR;
// fall back to useEffect on the server.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

interface Message {
  id: string
  conversation_id: string
  sender_id: string | null
  content: string
  is_system: boolean
  created_at: string
  edited_at?: string | null
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
  isDeactivated?: boolean
}

export default function ConversationView({ conversationId, isDeactivated }: ConversationViewProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [suggestedPrompts, setSuggestedPrompts] = useState<string[]>([])
  const [matchInsights, setMatchInsights] = useState<Array<{text: string; kind: string}>>([])
  const [firstMessageSentAt, setFirstMessageSentAt] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Inline message editing (own messages, within the 60-minute window).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const router = useRouter()

  const scrollRef = useRef<HTMLDivElement>(null)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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

  // Auto-resize the composer to fit its content, clamped between the 5-line
  // default and the ~12-line max (after which it scrolls internally). Reset to
  // 'auto' first so the textarea can shrink as well as grow.
  const applyAutosize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const { height, overflowY } = clampComposerHeight(el.scrollHeight)
    el.style.height = `${height}px`
    el.style.overflowY = overflowY
  }, [])

  // Runs before paint so the height is correct on the first frame (no flicker),
  // on every draft change (typing, clearing after send, prompt clicks).
  useIsomorphicLayoutEffect(() => {
    applyAutosize()
  }, [input, applyAutosize])

  // Re-measure when the viewport width changes — text re-wraps, so the number of
  // lines (and thus the height) can change without the draft changing.
  useEffect(() => {
    window.addEventListener('resize', applyAutosize)
    return () => window.removeEventListener('resize', applyAutosize)
  }, [applyAutosize])

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

  function startEdit(msg: Message) {
    setEditingId(msg.id)
    setEditText(msg.content)
    setEditError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditText('')
    setEditError(null)
  }

  async function handleEditSave(messageId: string) {
    const trimmed = editText.trim()
    if (!trimmed || savingEdit) return
    setSavingEdit(true)
    setEditError(null)
    try {
      const res = await fetch('/api/messages/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, content: trimmed }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        setEditError(data.error || 'Could not save your edit.')
        return
      }
      // Update immediately — no hard refresh. The recipient sees it on the next
      // poll. created_at is untouched; edited_at now marks it as edited.
      setMessages(prev => prev.map(m =>
        m.id === messageId ? { ...m, content: data.message.content, edited_at: data.message.edited_at } : m
      ))
      cancelEdit()
    } catch {
      setEditError('Could not save your edit.')
    } finally {
      setSavingEdit(false)
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

        {messages.map((msg, i) => {
          // Centered day separator before the first message and whenever the
          // viewer's local calendar day changes (Today / Yesterday / full date).
          const separatorLabel = shouldShowDaySeparator(messages, i)
            ? formatDaySeparator(msg.created_at)
            : null
          const daySeparator = separatorLabel ? (
            <div className="flex items-center justify-center py-2">
              <span className="rounded-full bg-gray-100 px-3 py-1 text-[11px] font-medium text-gray-500">
                {separatorLabel}
              </span>
            </div>
          ) : null

          const time = formatMessageTime(msg.created_at)

          if (msg.is_system) {
            return (
              <Fragment key={msg.id}>
                {daySeparator}
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-sm text-gray-700 whitespace-pre-line">
                  {msg.content}
                </div>
              </Fragment>
            )
          }

          const isMine = msg.sender_id === currentUserId
          const editable = canEditMessage(msg, currentUserId)
          const isEditing = editingId === msg.id
          return (
            <Fragment key={msg.id}>
              {daySeparator}
              <div className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}>
                <div
                  className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
                    isMine
                      ? 'bg-[#1B2850] text-white'
                      : 'bg-gray-100 text-gray-900'
                  }`}
                >
                  {isEditing ? (
                    <div className="min-w-[220px]">
                      <textarea
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        rows={2}
                        autoFocus
                        className="w-full rounded-lg border border-white/30 bg-white/95 px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#C4922A]"
                      />
                      {editError && <p className="mt-1 text-[11px] text-red-200">{editError}</p>}
                      <div className="mt-1.5 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={savingEdit}
                          className={`text-[11px] font-medium ${isMine ? 'text-white/70 hover:text-white' : 'text-gray-500 hover:text-gray-700'} disabled:opacity-50`}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleEditSave(msg.id)}
                          disabled={savingEdit || !editText.trim()}
                          className="rounded-md bg-[#C4922A] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#b0821f] disabled:opacity-50"
                        >
                          {savingEdit ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                      {time && (
                        <p
                          className={`mt-0.5 text-[10px] leading-none text-right ${
                            isMine ? 'text-white/60' : 'text-gray-400'
                          }`}
                        >
                          {msg.edited_at ? 'Edited · ' : ''}{time}
                        </p>
                      )}
                    </>
                  )}
                </div>
                {isMine && editable && !isEditing && (
                  <button
                    type="button"
                    onClick={() => startEdit(msg)}
                    className="mt-0.5 px-1 py-0.5 text-[11px] font-medium text-gray-400 hover:text-gray-600"
                  >
                    Edit
                  </button>
                )}
              </div>
            </Fragment>
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

      {isDeactivated ? (
        <div className="border-t border-gray-200 p-3">
          <textarea
            placeholder=""
            rows={COMPOSER_MIN_ROWS}
            disabled
            className="w-full resize-none border border-gray-200 rounded-2xl px-4 py-2 text-sm leading-5 bg-slate-50 text-slate-400 cursor-not-allowed"
            style={{ minHeight: COMPOSER_MIN_HEIGHT }}
          />
          <p className="text-xs text-slate-400 mt-2">This member is no longer active. You can no longer send messages.</p>
        </div>
      ) : (
        <div className="border-t border-gray-200 p-3">
          <div className="flex items-end gap-2 rounded-2xl border border-gray-300 bg-white px-3 py-2 transition-colors focus-within:border-transparent focus-within:ring-2 focus-within:ring-[#1B2850]">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Write a message..."
              rows={COMPOSER_MIN_ROWS}
              className="flex-1 resize-none bg-transparent px-1 py-1 text-sm leading-5 text-gray-900 placeholder:text-gray-400 focus:outline-none"
              style={{ minHeight: COMPOSER_MIN_HEIGHT, maxHeight: COMPOSER_MAX_HEIGHT }}
              disabled={sending}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="mb-0.5 shrink-0 px-4 py-2 bg-[#1B2850] text-white text-sm font-medium rounded-lg hover:bg-[#2E4080] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
