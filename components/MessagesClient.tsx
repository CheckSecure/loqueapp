'use client'

import { useState } from 'react'
import { Send, Search, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sendMessage } from '@/app/actions'
import { useRouter } from 'next/navigation'

interface Profile {
  id: string
  full_name: string
  role?: string
  company?: string
  avatar_color?: string
}

interface Message {
  id: string
  content: string
  sender_id: string
  created_at: string
}

interface Conversation {
  id: string
  other: Profile | null
  messages: Message[]
  lastMessage: string
  lastTime: string
}

function timeAgo(date: string | null | undefined) {
  if (!date) return ''
  const ms = new Date(date).getTime()
  if (isNaN(ms)) return ''
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function formatTime(date: string) {
  return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function MessagesClient({
  conversations,
  currentUserId,
}: {
  conversations: Conversation[]
  currentUserId: string
}) {
  const [selected, setSelected] = useState<Conversation | null>(conversations[0] ?? null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [localMessages, setLocalMessages] = useState<Message[]>(selected?.messages ?? [])
  const router = useRouter()

  const selectConversation = (c: Conversation) => {
    setSelected(c)
    setLocalMessages(c.messages)
    setInput('')
  }

  const handleSend = async () => {
    if (!input.trim() || !selected || sending) return
    const content = input.trim()
    setInput('')
    setSending(true)

    const optimistic: Message = {
      id: `tmp-${Date.now()}`,
      content,
      sender_id: currentUserId,
      created_at: new Date().toISOString(),
    }
    setLocalMessages(prev => [...prev, optimistic])

    await sendMessage(selected.id, content)
    setSending(false)
    router.refresh()
  }

  const initials = (name?: string) =>
    name?.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase() || '?'

  return (
    <div className="flex h-screen md:h-screen pt-14 md:pt-0">
      {/* Conversation list */}
      <div className="w-full md:w-72 bg-white border-r border-slate-200 flex flex-col shrink-0">
        <div className="p-4 border-b border-slate-100">
          <h1 className="text-lg font-bold text-slate-900 mb-3">Messages</h1>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search messages..."
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {conversations.length === 0 ? (
            <div className="p-8 text-center">
              <MessageSquare className="w-8 h-8 text-slate-300 mx-auto mb-3" />
              <p className="text-sm font-medium text-slate-500">No messages yet</p>
              <p className="text-xs text-slate-400 mt-1">Accept an introduction to start a conversation.</p>
            </div>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => selectConversation(c)}
                className={cn(
                  'w-full text-left px-4 py-3.5 hover:bg-[#F5F6FB] transition-colors flex items-start gap-3',
                  selected?.id === c.id && 'bg-[#F5F6FB] border-l-2 border-[#1B2850]'
                )}
              >
                <div className={`w-9 h-9 rounded-full ${c.other?.avatar_color || 'bg-[#1B2850]'} flex items-center justify-center text-white text-xs font-bold flex-shrink-0 mt-0.5`}>
                  {initials(c.other?.full_name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-0.5">
                    <p className="text-sm font-semibold text-slate-900 truncate">{c.other?.full_name || 'Unknown'}</p>
                    <span suppressHydrationWarning className="text-xs text-slate-400 ml-2 flex-shrink-0">{timeAgo(c.lastTime)}</span>
                  </div>
                  <p className="text-xs text-slate-500 truncate">{c.lastMessage || 'No messages yet'}</p>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Message thread */}
      <div className="hidden md:flex flex-1 flex-col bg-[#F5F6FB]">
        {selected ? (
          <>
            <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center gap-3">
              <div className={`w-9 h-9 rounded-full ${selected.other?.avatar_color || 'bg-[#1B2850]'} flex items-center justify-center text-white text-xs font-bold`}>
                {initials(selected.other?.full_name)}
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">{selected.other?.full_name || 'Unknown'}</p>
                {(selected.other?.role || selected.other?.company) && (
                  <p className="text-xs text-slate-400">
                    {[selected.other?.role, selected.other?.company].filter(Boolean).join(' at ')}
                  </p>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-3">
              {localMessages.length === 0 ? (
                <div className="h-full flex items-center justify-center">
                  <p className="text-sm text-slate-400">Say hello to {selected.other?.full_name?.split(' ')[0] || 'them'}!</p>
                </div>
              ) : (
                localMessages.map((m) => {
                  const isMe = m.sender_id === currentUserId
                  return (
                    <div key={m.id} className={cn('flex', isMe ? 'justify-end' : 'justify-start')}>
                      <div className={cn(
                        'max-w-xs lg:max-w-md px-4 py-2.5 rounded-2xl text-sm',
                        isMe
                          ? 'bg-[#1B2850] text-white rounded-br-sm'
                          : 'bg-white text-slate-800 border border-slate-100 shadow-sm rounded-bl-sm'
                      )}>
                        <p>{m.content}</p>
                        <p suppressHydrationWarning className={cn('text-xs mt-1', isMe ? 'text-white/60' : 'text-slate-400')}>
                          {formatTime(m.created_at)}
                        </p>
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            <div className="bg-white border-t border-slate-200 px-4 py-3">
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  placeholder={`Message ${selected.other?.full_name?.split(' ')[0] || 'them'}...`}
                  className="flex-1 px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || sending}
                  className="w-10 h-10 bg-[#1B2850] rounded-xl flex items-center justify-center hover:bg-[#2E4080] transition-colors disabled:opacity-50"
                >
                  <Send className="w-4 h-4 text-white" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <MessageSquare className="w-10 h-10 text-slate-300 mx-auto mb-3" />
              <p className="text-sm text-slate-400">Select a conversation to read messages</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
