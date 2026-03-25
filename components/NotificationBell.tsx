'use client'

import { useState, useEffect, useRef } from 'react'
import { Bell, X, Check, CheckCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

interface Notification {
  id: string
  type: string
  title: string
  body: string
  link: string | null
  read_at: string | null
  created_at: string
}

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)
  const ref = useRef<HTMLDivElement>(null)

  const unreadCount = notifications.filter(n => !n.read_at).length

  useEffect(() => {
    loadNotifications()
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Real-time subscription
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel('notifications')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
      }, payload => {
        setNotifications(prev => [payload.new as Notification, ...prev])
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  const loadNotifications = async () => {
    const supabase = createClient()
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20)
    setNotifications(data ?? [])
    setLoading(false)
  }

  const markAllRead = async () => {
    const supabase = createClient()
    const unread = notifications.filter(n => !n.read_at)
    if (unread.length === 0) return
    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .in('id', unread.map(n => n.id))
    setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })))
  }

  const markRead = async (id: string) => {
    const supabase = createClient()
    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id)
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { setOpen(v => !v); if (!open) markAllRead() }}
        className="relative p-2 text-slate-400 hover:text-slate-600 transition-colors"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 w-80 bg-white border border-slate-100 rounded-2xl shadow-xl z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900">Notifications</p>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button onClick={markAllRead} className="text-xs text-slate-400 hover:text-[#1B2850] flex items-center gap-1 transition-colors">
                  <CheckCheck className="w-3 h-3" />
                  Mark all read
                </button>
              )}
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto divide-y divide-slate-50">
            {loading && (
              <div className="px-4 py-8 text-center text-xs text-slate-400">Loading...</div>
            )}
            {!loading && notifications.length === 0 && (
              <div className="px-4 py-8 text-center">
                <Bell className="w-6 h-6 text-slate-200 mx-auto mb-2" />
                <p className="text-xs text-slate-400">No notifications yet</p>
              </div>
            )}
            {notifications.map(n => (
              <div
                key={n.id}
                className={cn('px-4 py-3 hover:bg-slate-50 transition-colors', !n.read_at && 'bg-[#FDF9F3]')}
              >
                {n.link ? (
                  <Link href={n.link} onClick={() => { markRead(n.id); setOpen(false) }}>
                    <p className="text-xs font-semibold text-slate-900 mb-0.5">{n.title}</p>
                    <p className="text-xs text-slate-500 leading-relaxed">{n.body}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{timeAgo(n.created_at)}</p>
                  </Link>
                ) : (
                  <div onClick={() => markRead(n.id)}>
                    <p className="text-xs font-semibold text-slate-900 mb-0.5">{n.title}</p>
                    <p className="text-xs text-slate-500 leading-relaxed">{n.body}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{timeAgo(n.created_at)}</p>
                  </div>
                )}
                {!n.read_at && (
                  <div className="w-1.5 h-1.5 bg-[#C4922A] rounded-full absolute right-4 top-1/2 -translate-y-1/2" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
