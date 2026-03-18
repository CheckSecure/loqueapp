'use client'

import { useState } from 'react'
import { Calendar, Clock, Video, Plus, ChevronLeft, ChevronRight, MapPin } from 'lucide-react'
import { cn } from '@/lib/utils'

const meetings = [
  {
    id: 1,
    title: 'Intro call with Sarah Chen',
    date: 'Today',
    time: '2:00 PM – 2:30 PM',
    type: 'video',
    with: 'Sarah Chen',
    initials: 'SC',
    color: 'bg-violet-500',
    status: 'upcoming',
  },
  {
    id: 2,
    title: 'Coffee chat — Marcus Rivera',
    date: 'Tomorrow',
    time: '10:00 AM – 10:45 AM',
    type: 'in-person',
    location: 'Blue Bottle Coffee, SF',
    with: 'Marcus Rivera',
    initials: 'MR',
    color: 'bg-emerald-500',
    status: 'upcoming',
  },
  {
    id: 3,
    title: 'Investor meeting — Priya Mehta',
    date: 'Thu, Mar 21',
    time: '3:00 PM – 3:30 PM',
    type: 'video',
    with: 'Priya Mehta',
    initials: 'PM',
    color: 'bg-amber-500',
    status: 'upcoming',
  },
  {
    id: 4,
    title: 'Follow-up call — Derek Lam',
    date: 'Mon, Mar 17',
    time: '11:00 AM – 11:30 AM',
    type: 'video',
    with: 'Derek Lam',
    initials: 'DL',
    color: 'bg-indigo-500',
    status: 'past',
  },
]

const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
const dates = [17, 18, 19, 20, 21]
const today = 18

export default function MeetingsPage() {
  const [view, setView] = useState<'list' | 'calendar'>('list')
  const upcoming = meetings.filter((m) => m.status === 'upcoming')
  const past = meetings.filter((m) => m.status === 'past')

  return (
    <div className="p-6 md:p-8 pt-20 md:pt-8">
      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Meetings</h1>
            <p className="text-slate-500 text-sm mt-0.5">Your scheduled conversations and calls.</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex bg-slate-100 p-0.5 rounded-lg">
              {(['list', 'calendar'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors',
                    view === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
            <button className="flex items-center gap-2 bg-indigo-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors">
              <Plus className="w-4 h-4" />
              Schedule
            </button>
          </div>
        </div>

        {view === 'calendar' && (
          <div className="bg-white border border-slate-100 rounded-xl shadow-sm mb-8 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-900">March 2026</h2>
              <div className="flex items-center gap-1">
                <button className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors"><ChevronLeft className="w-4 h-4 text-slate-500" /></button>
                <button className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors"><ChevronRight className="w-4 h-4 text-slate-500" /></button>
              </div>
            </div>
            <div className="grid grid-cols-5 divide-x divide-slate-100">
              {days.map((day, i) => (
                <div key={day} className={cn('px-3 py-3 text-center', dates[i] === today && 'bg-indigo-50')}>
                  <p className="text-xs text-slate-400 font-medium mb-1">{day}</p>
                  <p className={cn('text-sm font-bold', dates[i] === today ? 'text-indigo-600' : 'text-slate-700')}>{dates[i]}</p>
                  {meetings.some((m) => m.date.includes(String(dates[i])) || (dates[i] === today && m.date === 'Today') || (dates[i] === 19 && m.date === 'Tomorrow')) && (
                    <div className="mt-2 space-y-1">
                      <div className="w-full h-1.5 bg-indigo-400 rounded-full" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-6">
          <div>
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Upcoming</h2>
            <div className="space-y-3">
              {upcoming.map((m) => (
                <div key={m.id} className="bg-white border border-slate-100 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center flex-shrink-0">
                    <Calendar className="w-5 h-5 text-indigo-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-900 truncate">{m.title}</p>
                    <div className="flex flex-wrap items-center gap-3 mt-1">
                      <span className="flex items-center gap-1 text-xs text-slate-500">
                        <Clock className="w-3 h-3" />
                        {m.date} · {m.time}
                      </span>
                      {m.type === 'video' ? (
                        <span className="flex items-center gap-1 text-xs text-indigo-600 font-medium">
                          <Video className="w-3 h-3" /> Video call
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-slate-500">
                          <MapPin className="w-3 h-3" /> {m.location}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className={`w-7 h-7 rounded-full ${m.color} flex items-center justify-center text-white text-xs font-bold`}>
                      {m.initials}
                    </div>
                    {m.type === 'video' && (
                      <button className="text-xs font-semibold bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700 transition-colors">
                        Join
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Past</h2>
            <div className="space-y-3">
              {past.map((m) => (
                <div key={m.id} className="bg-white border border-slate-100 rounded-xl p-5 shadow-sm opacity-60 flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                    <Calendar className="w-5 h-5 text-slate-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-700 truncate">{m.title}</p>
                    <span className="flex items-center gap-1 text-xs text-slate-400 mt-1">
                      <Clock className="w-3 h-3" />
                      {m.date} · {m.time}
                    </span>
                  </div>
                  <div className={`w-7 h-7 rounded-full ${m.color} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
                    {m.initials}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
