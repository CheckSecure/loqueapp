'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Users, MessageSquare, Calendar, UserCircle, MoreHorizontal, CreditCard, Settings, ShieldCheck, LogOut, X, Network, Sparkles, UserPlus } from 'lucide-react'
import NotificationBell from './NotificationBell'
import { cn } from '@/lib/utils'
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

const bottomNavItems = [
  { href: '/dashboard/introductions', label: 'Intros', icon: Users },
  { href: '/dashboard/network', label: 'Network', icon: Network },
  { href: '/dashboard/messages', label: 'Messages', icon: MessageSquare },
  { href: '/dashboard/meetings', label: 'Meetings', icon: Calendar },
  { href: '/dashboard/profile', label: 'Profile', icon: UserCircle },
]

export default function MobileNav({ credits, unreadCount = 0, meetingNotifCount = 0, opportunityBadgeCount = 0 }: { credits: number; unreadCount?: number; meetingNotifCount?: number; opportunityBadgeCount?: number }) {
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

  // Compact credit chip styling
  const creditStyle =
    credits === 0
      ? 'bg-red-50 text-red-600 border-red-200'
      : credits < 5
      ? 'bg-amber-50 text-amber-600 border-amber-200'
      : 'bg-[#FDF3E3] text-[#C4922A] border-[#e8c88a]'

  return (
    <>
      {/* Top header - REDESIGNED: Logo + Credits + Bell */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50 bg-white border-b border-slate-100 h-14 flex items-center justify-between px-4 gap-3">
        <span className="text-lg font-bold text-[#1B2850] tracking-tight flex-shrink-0">Andrel</span>
        
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Compact credits chip */}
          <Link
            href="/dashboard/billing"
            className={cn(
              'px-2 py-1 rounded-full border text-[11px] font-semibold transition-colors hover:opacity-80',
              creditStyle
            )}
          >
            ✦ {credits}
          </Link>
          
          <NotificationBell />
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
              href="/dashboard/opportunities"
              onClick={() => setShowMore(false)}
              className="flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <Sparkles className="w-5 h-5 text-slate-400" />
              <span className="flex-1">Opportunities</span>
              {opportunityBadgeCount > 0 && (
                <span className="w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                  {opportunityBadgeCount > 9 ? '9+' : opportunityBadgeCount}
                </span>
              )}
            </Link>

            <Link
              href="/dashboard/referrals"
              onClick={() => setShowMore(false)}
              className="flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <UserPlus className="w-5 h-5 text-slate-400" />
              Referrals
            </Link>

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
