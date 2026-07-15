'use client'

import { useState, useEffect, useRef } from 'react'
import { Bell, X, CheckCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  realtimeFilterForUser,
  isOwnNotification,
  scopedNotificationsQuery,
  markAllReadQuery,
  markOneReadQuery,
} from '@/lib/notifications/bell'

interface Notification {
  id: string
  user_id?: string
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
  const [userId, setUserId] = useState<string | null>(null)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)
  const ref = useRef<HTMLDivElement>(null)
  const router = useRouter()

  const unreadCount = notifications.filter(n => !n.read_at).length

  // Resolve the signed-in user, then load only their notifications.
  useEffect(() => {
    let active = true
    const supabase = createClient()
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!active) return
      const uid = user?.id ?? null
      setUserId(uid)
      if (!uid) {
        setNotifications([])
        setLoading(false)
        return
      }
      const { data } = await scopedNotificationsQuery(supabase, uid)
      if (!active) return
      setNotifications((data ?? []) as Notification[])
      setLoading(false)
    })()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Realtime: subscribe only once we know the user, filter server-side to their
  // rows, and defensively re-check ownership before touching local state.
  useEffect(() => {
    if (!userId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: realtimeFilterForUser(userId) },
        payload => {
          const row = payload.new as Notification
          if (!isOwnNotification(row, userId)) return
          setNotifications(prev => (prev.some(n => n.id === row.id) ? prev : [row, ...prev]))
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [userId])

  const markAllRead = async () => {
    if (!userId) return
    const supabase = createClient()
    const unread = notifications.filter(n => !n.read_at)
    if (unread.length === 0) return
    await markAllReadQuery(supabase, userId, unread.map(n => n.id), new Date().toISOString())
    setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })))
  }

  const handleNotificationClick = async (n: Notification) => {
    if (userId) {
      const supabase = createClient()
      await markOneReadQuery(supabase, userId, n.id, new Date().toISOString())
      setNotifications(prev => prev.map(item => item.id === n.id ? { ...item, read_at: new Date().toISOString() } : item))
    }
    setOpen(false)
    if (n.link) window.location.href = n.link
  }

  // Mark all as read when bell is opened
  const handleBellClick = async () => {
    setOpen(v => !v)
    if (!open && unreadCount > 0) {
      await markAllRead()
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={handleBellClick}
        className="relative p-1.5 text-slate-400 hover:text-slate-600 transition-colors rounded-lg hover:bg-slate-100"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute top-0.5 right-0.5 w-3.5 h-3.5 bg-brand-gold text-white text-[8px] font-bold rounded-full flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 md:left-0 md:right-auto top-full mt-2 w-80 sm:w-96 max-w-[calc(100vw-1rem)] bg-white border border-slate-100 rounded-2xl shadow-xl z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900">Notifications</p>
            <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto divide-y divide-slate-50">
            {loading && <div className="px-4 py-8 text-center text-xs text-slate-400">Loading...</div>}
            {!loading && notifications.length === 0 && (
              <div className="px-4 py-8 text-center">
                <Bell className="w-6 h-6 text-slate-200 mx-auto mb-2" />
                <p className="text-xs text-slate-400">No notifications yet</p>
              </div>
            )}
            {notifications.map(n => (
              <div
                key={n.id}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && handleNotificationClick(n)}
                onClick={() => handleNotificationClick(n)}
                className={cn(
                  'px-4 py-3 transition-colors relative',
                  n.link ? 'cursor-pointer hover:bg-slate-50' : '',
                  !n.read_at ? 'bg-brand-gold-soft' : ''
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-slate-900 mb-0.5">{n.title}</p>
                    <p className="text-xs text-slate-500 leading-relaxed">{n.body}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{timeAgo(n.created_at)}</p>
                  </div>
                  {!n.read_at && (
                    <div className="w-1.5 h-1.5 bg-brand-gold rounded-full flex-shrink-0 mt-1.5" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
