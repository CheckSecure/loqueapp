'use client'

import { useState } from 'react'
import { Send, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

export const metadata = { title: 'Messages | Cadre' }

const conversations = [
  {
    id: 1,
    name: 'Sarah Chen',
    role: 'Product Lead · Notion',
    initials: 'SC',
    color: 'bg-violet-500',
    lastMessage: 'Would love to connect and hear more about what you\'re building!',
    time: '2m ago',
    unread: 2,
    messages: [
      { from: 'them', text: 'Hi! I saw your intro request come through via Marcus.', time: '10:14 AM' },
      { from: 'them', text: 'Would love to connect and hear more about what you\'re building!', time: '10:15 AM' },
    ],
  },
  {
    id: 2,
    name: 'Marcus Rivera',
    role: 'Eng Manager · Stripe',
    initials: 'MR',
    color: 'bg-emerald-500',
    lastMessage: 'Thanks for the intro to the Arclight team, really appreciated.',
    time: '1h ago',
    unread: 0,
    messages: [
      { from: 'me', text: 'Hey Marcus! Just wanted to follow up on the intro you made last week.', time: 'Yesterday' },
      { from: 'them', text: 'Thanks for the intro to the Arclight team, really appreciated.', time: 'Yesterday' },
    ],
  },
  {
    id: 3,
    name: 'Priya Mehta',
    role: 'VC Investor · Sequoia',
    initials: 'PM',
    color: 'bg-amber-500',
    lastMessage: 'Let\'s schedule a 30-min call this week.',
    time: '3h ago',
    unread: 0,
    messages: [
      { from: 'them', text: 'I\'d love to learn more about your company\'s traction.', time: '9:00 AM' },
      { from: 'me', text: 'Absolutely, I\'ll send over our deck.', time: '9:30 AM' },
      { from: 'them', text: 'Let\'s schedule a 30-min call this week.', time: '10:00 AM' },
    ],
  },
]

export default function MessagesPage() {
  const [selected, setSelected] = useState(conversations[0])
  const [input, setInput] = useState('')

  return (
    <div className="flex h-screen md:h-[calc(100vh)] pt-14 md:pt-0">
      {/* Conversation list */}
      <div className="w-full md:w-72 bg-white border-r border-slate-200 flex flex-col shrink-0">
        <div className="p-4 border-b border-slate-100">
          <h1 className="text-lg font-bold text-slate-900 mb-3">Messages</h1>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search messages..."
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelected(c)}
              className={cn(
                'w-full text-left px-4 py-3.5 hover:bg-slate-50 transition-colors flex items-start gap-3',
                selected.id === c.id && 'bg-indigo-50'
              )}
            >
              <div className={`w-9 h-9 rounded-full ${c.color} flex items-center justify-center text-white text-xs font-bold flex-shrink-0 mt-0.5`}>
                {c.initials}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-0.5">
                  <p className="text-sm font-semibold text-slate-900 truncate">{c.name}</p>
                  <span className="text-xs text-slate-400 ml-2 flex-shrink-0">{c.time}</span>
                </div>
                <p className="text-xs text-slate-500 truncate">{c.lastMessage}</p>
              </div>
              {c.unread > 0 && (
                <div className="w-5 h-5 bg-indigo-600 rounded-full flex items-center justify-center flex-shrink-0">
                  <span className="text-xs text-white font-bold">{c.unread}</span>
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Message thread */}
      <div className="hidden md:flex flex-1 flex-col bg-slate-50">
        <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center gap-3">
          <div className={`w-9 h-9 rounded-full ${selected.color} flex items-center justify-center text-white text-xs font-bold`}>
            {selected.initials}
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-900">{selected.name}</p>
            <p className="text-xs text-slate-400">{selected.role}</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-3">
          {selected.messages.map((m, i) => (
            <div key={i} className={cn('flex', m.from === 'me' ? 'justify-end' : 'justify-start')}>
              <div className={cn(
                'max-w-xs lg:max-w-md px-4 py-2.5 rounded-2xl text-sm',
                m.from === 'me'
                  ? 'bg-indigo-600 text-white rounded-br-sm'
                  : 'bg-white text-slate-800 border border-slate-100 shadow-sm rounded-bl-sm'
              )}>
                <p>{m.text}</p>
                <p className={cn('text-xs mt-1', m.from === 'me' ? 'text-indigo-200' : 'text-slate-400')}>{m.time}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="bg-white border-t border-slate-200 px-4 py-3">
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Message ${selected.name}...`}
              className="flex-1 px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
              onKeyDown={(e) => e.key === 'Enter' && setInput('')}
            />
            <button
              onClick={() => setInput('')}
              className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center hover:bg-indigo-700 transition-colors"
            >
              <Send className="w-4 h-4 text-white" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
