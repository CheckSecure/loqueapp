'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Users, MessageSquare, Calendar, UserCircle, MoreHorizontal, CreditCard, Settings, ShieldCheck, LogOut, X, Network } from 'lucide-react'
import NotificationBell from './NotificationBell'
import { cn } from '@/lib/utils'
import { useState, useRef, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

const bottomNavItems = [
  { href: '/dashboard/introductions', label: 'Intros', icon: Users },
  { href: '/dashboard/network', label: 'Network', icon: Network },
  { href: '/dashboard/messages', label: 'Messages', icon: MessageSquare },
  { href: '/dashboard/meetings', label: 'Meetings', icon: Calendar },
  { href: '/dashboard/profile', label: 'Profile', icon: UserCircle },
]

function CreditsChip({ credits }: { credits: number }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const chipStyle =
    credits === 0
      ? 'bg-red-50 text-red-600 border-red-200'
      : credits < 5
      ? 'bg-amber-50 text-amber-600 border-amber-200'
      : 'bg-[#FDF3E3] text-[#C4922A] border-[#e8c88a]'

  const label = credits === 0 ? 'No credits' : `✦ ${credits}`

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={cn('px-2.5 py-1 rounded-full border text-xs font-semibold', chipStyle)}
      >
        {label}
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-lg p-3.5 z-50">
          <p className="text-xs font-semibold text-slate-800 mb-1">Meeting credits</p>
          <p className="text-xs text-slate-500 leading-relaxed">
            Credits are used to request meetings. Purchase more to continue connecting.
          </p>
          {credits < 5 && (
            <p className={cn('text-xs font-medium mt-2', credits === 0 ? 'text-red-600' : 'text-amber-600')}>
              {credits === 0 ? 'No credits left.' : `Only ${credits} remaining.`}
            </p>
          )}
          <div className="mt-3 pt-2.5 border-t border-slate-100">
            <Link href="/dashboard/billing" className="text-xs font-semibold text-[#1B2850]">Purchase credits →</Link>
          </div>
        </div>
      )}
    </div>
  )
}

export default function MobileNav({ credits, unreadCount = 0 }: { credits: number; unreadCount?: number }) {
  const pathname = usePathname()
  const router = useRouter()
  const [showMore, setShowMore] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user } }) => {
      setIsAdmin(user?.email === ADMIN_EMAIL)
    })
  }, [])

  const handleLogout = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/')
    router.refresh()
  }

  return (
    <>
      {/* Top header */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50 bg-white border-b border-slate-200 px-4 h-14 flex items-center justify-between">
        <span className="text-lg font-bold text-[#1B2850] tracking-tight">Andrel</span>
        <div className="flex items-center gap-1">
          <NotificationBell />
          <CreditsChip credits={credits} />
        </div>
      </div>

      {/* More slide-up menu */}
      {showMore && (
        <>
          <div
            className="md:hidden fixed inset-0 z-40 bg-black/30"
            onClick={() => setShowMore(false)}
          />
          <div className="md:hidden fixed bottom-16 left-0 right-0 z-50 bg-white border-t border-slate-100 rounded-t-2xl shadow-xl p-4 space-y-1">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-slate-900">More</p>
              <button onClick={() => setShowMore(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <Link
              href="/dashboard/billing"
              onClick={() => setShowMore(false)}
              className="flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <CreditCard className="w-5 h-5 text-slate-400" />
              Billing
            </Link>

            <Link
              href="/dashboard/settings"
              onClick={() => setShowMore(false)}
              className="flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <Settings className="w-5 h-5 text-slate-400" />
              Settings
            </Link>

            {isAdmin && (
              <Link
                href="/dashboard/admin"
                onClick={() => setShowMore(false)}
                className="flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <ShieldCheck className="w-5 h-5 text-slate-400" />
                Admin
              </Link>
            )}

            <div className="pt-2 border-t border-slate-100 mt-2">
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium text-red-500 hover:bg-red-50 transition-colors"
              >
                <LogOut className="w-5 h-5" />
                Sign out
              </button>
            </div>
          </div>
        </>
      )}

      {/* Bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-slate-200 flex h-16">
        {bottomNavItems.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href)
          const isMessages = href === '/dashboard/messages'
          const showBadge = isMessages && unreadCount > 0
          return (
            <Link
              key={href}
              href={href}
              className="flex-1 flex flex-col items-center justify-center gap-0.5 relative py-2"
            >
              {active && (
                <span className="absolute top-0 left-3 right-3 h-0.5 rounded-full bg-[#C4922A]" />
              )}
              <span className="relative inline-flex">
                <Icon className={cn('w-5 h-5', active ? 'text-[#C4922A]' : 'text-slate-400')} />
                {showBadge && (
                  <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-0.5 leading-none">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </span>
              <span className={cn('text-[10px] font-medium', active ? 'text-[#C4922A]' : 'text-slate-400')}>
                {label}
              </span>
            </Link>
          )
        })}

        {/* More button */}
        <button
          onClick={() => setShowMore(v => !v)}
          className="flex-1 flex flex-col items-center justify-center gap-0.5 relative py-2"
        >
          {showMore && <span className="absolute top-0 left-3 right-3 h-0.5 rounded-full bg-[#C4922A]" />}
          <MoreHorizontal className={cn('w-5 h-5', showMore ? 'text-[#C4922A]' : 'text-slate-400')} />
          <span className={cn('text-[10px] font-medium', showMore ? 'text-[#C4922A]' : 'text-slate-400')}>More</span>
        </button>
      </nav>
    </>
  )
}
