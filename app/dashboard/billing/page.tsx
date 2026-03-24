'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Loader2, Check, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

const PLANS = [
  {
    tier: 'free',
    name: 'Free',
    monthlyPrice: 0,
    annualPrice: 0,
    credits: 3,
    features: ['Curated introductions each week', '3 credits/month', 'Standard matching'],
  },
  {
    tier: 'professional',
    name: 'Professional',
    monthlyPrice: 49,
    annualPrice: 470,
    credits: 15,
    features: ['Expanded introductions each week', '15 credits/month', 'Priority matching', 'Express interest in members'],
    monthlyPriceId: process.env.NEXT_PUBLIC_STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID,
    annualPriceId: process.env.NEXT_PUBLIC_STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID,
  },
  {
    tier: 'executive',
    name: 'Executive',
    monthlyPrice: 99,
    annualPrice: 990,
    credits: 30,
    features: ['Maximum introductions each week', '30 credits/month', 'Highest priority matching', 'Concierge curation'],
    monthlyPriceId: process.env.NEXT_PUBLIC_STRIPE_EXECUTIVE_MONTHLY_PRICE_ID,
    annualPriceId: process.env.NEXT_PUBLIC_STRIPE_EXECUTIVE_ANNUAL_PRICE_ID,
  },
]

const CREDIT_PACKS = [
  { name: '5 Credits', credits: 5, amount: 25, priceId: process.env.NEXT_PUBLIC_STRIPE_CREDIT_5_PRICE_ID },
  { name: '10 Credits', credits: 10, amount: 45, priceId: process.env.NEXT_PUBLIC_STRIPE_CREDIT_10_PRICE_ID },
  { name: '25 Credits', credits: 25, amount: 99, priceId: process.env.NEXT_PUBLIC_STRIPE_CREDIT_25_PRICE_ID },
]

function BillingInner() {
  const searchParams = useSearchParams()
  const [currentTier, setCurrentTier] = useState('free')
  const [credits, setCredits] = useState(0)
  const [periodEnd, setPeriodEnd] = useState<string | null>(null)
  const [annual, setAnnual] = useState(false)
  const [loading, setLoading] = useState(true)
  const [checkingOut, setCheckingOut] = useState<string | null>(null)

  const success = searchParams.get('success')
  const cancelled = searchParams.get('cancelled')

  useEffect(() => {
    const load = async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const [{ data: profile }, { data: creditRow }] = await Promise.all([
        supabase.from('profiles').select('subscription_tier, current_period_end').eq('id', user.id).single(),
        supabase.from('meeting_credits').select('balance').eq('user_id', user.id).single(),
      ])

      setCurrentTier(profile?.subscription_tier ?? 'free')
      setCredits(creditRow?.balance ?? 0)
      if (profile?.current_period_end) {
        setPeriodEnd(new Date(profile.current_period_end).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))
      }
      setLoading(false)
    }
    load()
  }, [])

  const handleCheckout = async (priceId: string, mode: 'subscription' | 'payment') => {
    setCheckingOut(priceId)
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId, mode }),
      })
      const { url, error } = await res.json()
      if (error) { alert(error); setCheckingOut(null); return }
      window.location.href = url
    } catch {
      alert('Something went wrong. Please try again.')
      setCheckingOut(null)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
    </div>
  )

  return (
    <div className="max-w-3xl mx-auto px-6 py-10 space-y-10">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Billing</h1>
        <p className="text-slate-500 text-sm mt-1">Manage your membership and credits.</p>
      </div>

      {success && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 text-sm font-medium px-4 py-3 rounded-lg">
          <Check className="w-4 h-4" /> Payment successful — your membership has been updated.
        </div>
      )}
      {cancelled && (
        <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm px-4 py-3 rounded-lg">
          Checkout was cancelled. No changes were made.
        </div>
      )}

      {/* Current plan */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-900">Current Membership</h2>
          {currentTier !== 'free' && periodEnd && (
            <span className="text-xs text-slate-400">Renews {periodEnd}</span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-[#1B2850] flex items-center justify-center">
            <Zap className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-900 capitalize">{currentTier}</p>
            <p className="text-xs text-slate-500">{credits} credits remaining</p>
          </div>
        </div>
      </div>

      {/* Plan selector */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-900">Membership Plans</h2>
          <div className="flex items-center gap-2">
            <span className={cn('text-xs font-medium', !annual ? 'text-slate-900' : 'text-slate-400')}>Monthly</span>
            <button onClick={() => setAnnual(v => !v)} className={cn('relative w-9 h-5 rounded-full transition-colors', annual ? 'bg-[#1B2850]' : 'bg-slate-200')}>
              <span className={cn('absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform', annual && 'translate-x-4')} />
            </button>
            <span className={cn('text-xs font-medium', annual ? 'text-slate-900' : 'text-slate-400')}>Annual <span className="text-[#C4922A]">2mo free</span></span>
          </div>
        </div>

        <div className="space-y-3">
          {PLANS.map((plan) => {
            const isCurrent = currentTier === plan.tier
            const priceId = annual ? plan.annualPriceId : plan.monthlyPriceId
            return (
              <div key={plan.tier} className={cn('bg-white rounded-xl border p-5 flex items-center justify-between gap-4', isCurrent ? 'border-[#1B2850] ring-1 ring-[#1B2850]' : 'border-slate-100')}>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-sm font-bold text-slate-900">{plan.name}</p>
                    {isCurrent && <span className="text-xs bg-[#1B2850] text-white px-2 py-0.5 rounded-full">Current</span>}
                  </div>
                  <p className="text-xs text-slate-500">{plan.credits} credits/month · {plan.features[2]}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  {plan.monthlyPrice === 0 ? (
                    <p className="text-sm font-bold text-slate-900">Free</p

cat > ~/loqueapp/app/dashboard/billing/page.tsx << 'ENDOFFILE'
'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Loader2, Check, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

const PLANS = [
  {
    tier: 'free',
    name: 'Free',
    monthlyPrice: 0,
    annualPrice: 0,
    credits: 3,
    features: ['Curated introductions each week', '3 credits/month', 'Standard matching'],
  },
  {
    tier: 'professional',
    name: 'Professional',
    monthlyPrice: 49,
    annualPrice: 470,
    credits: 15,
    features: ['Expanded introductions each week', '15 credits/month', 'Priority matching', 'Express interest in members'],
    monthlyPriceId: process.env.NEXT_PUBLIC_STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID,
    annualPriceId: process.env.NEXT_PUBLIC_STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID,
  },
  {
    tier: 'executive',
    name: 'Executive',
    monthlyPrice: 99,
    annualPrice: 990,
    credits: 30,
    features: ['Maximum introductions each week', '30 credits/month', 'Highest priority matching', 'Concierge curation'],
    monthlyPriceId: process.env.NEXT_PUBLIC_STRIPE_EXECUTIVE_MONTHLY_PRICE_ID,
    annualPriceId: process.env.NEXT_PUBLIC_STRIPE_EXECUTIVE_ANNUAL_PRICE_ID,
  },
]

const CREDIT_PACKS = [
  { name: '5 Credits', credits: 5, amount: 25, priceId: process.env.NEXT_PUBLIC_STRIPE_CREDIT_5_PRICE_ID },
  { name: '10 Credits', credits: 10, amount: 45, priceId: process.env.NEXT_PUBLIC_STRIPE_CREDIT_10_PRICE_ID },
  { name: '25 Credits', credits: 25, amount: 99, priceId: process.env.NEXT_PUBLIC_STRIPE_CREDIT_25_PRICE_ID },
]

function BillingInner() {
  const searchParams = useSearchParams()
  const [currentTier, setCurrentTier] = useState('free')
  const [credits, setCredits] = useState(0)
  const [periodEnd, setPeriodEnd] = useState<string | null>(null)
  const [annual, setAnnual] = useState(false)
  const [loading, setLoading] = useState(true)
  const [checkingOut, setCheckingOut] = useState<string | null>(null)

  const success = searchParams.get('success')
  const cancelled = searchParams.get('cancelled')

  useEffect(() => {
    const load = async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const [{ data: profile }, { data: creditRow }] = await Promise.all([
        supabase.from('profiles').select('subscription_tier, current_period_end').eq('id', user.id).single(),
        supabase.from('meeting_credits').select('balance').eq('user_id', user.id).single(),
      ])

      setCurrentTier(profile?.subscription_tier ?? 'free')
      setCredits(creditRow?.balance ?? 0)
      if (profile?.current_period_end) {
        setPeriodEnd(new Date(profile.current_period_end).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))
      }
      setLoading(false)
    }
    load()
  }, [])

  const handleCheckout = async (priceId: string, mode: 'subscription' | 'payment') => {
    setCheckingOut(priceId)
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId, mode }),
      })
      const { url, error } = await res.json()
      if (error) { alert(error); setCheckingOut(null); return }
      window.location.href = url
    } catch {
      alert('Something went wrong. Please try again.')
      setCheckingOut(null)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
    </div>
  )

  return (
    <div className="max-w-3xl mx-auto px-6 py-10 space-y-10">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Billing</h1>
        <p className="text-slate-500 text-sm mt-1">Manage your membership and credits.</p>
      </div>

      {success && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 text-sm font-medium px-4 py-3 rounded-lg">
          <Check className="w-4 h-4" /> Payment successful — your membership has been updated.
        </div>
      )}
      {cancelled && (
        <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm px-4 py-3 rounded-lg">
          Checkout was cancelled. No changes were made.
        </div>
      )}

      {/* Current plan */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-900">Current Membership</h2>
          {currentTier !== 'free' && periodEnd && (
            <span className="text-xs text-slate-400">Renews {periodEnd}</span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-[#1B2850] flex items-center justify-center">
            <Zap className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-900 capitalize">{currentTier}</p>
            <p className="text-xs text-slate-500">{credits} credits remaining</p>
          </div>
        </div>
      </div>

      {/* Plan selector */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-900">Membership Plans</h2>
          <div className="flex items-center gap-2">
            <span className={cn('text-xs font-medium', !annual ? 'text-slate-900' : 'text-slate-400')}>Monthly</span>
            <button onClick={() => setAnnual(v => !v)} className={cn('relative w-9 h-5 rounded-full transition-colors', annual ? 'bg-[#1B2850]' : 'bg-slate-200')}>
              <span className={cn('absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform', annual && 'translate-x-4')} />
            </button>
            <span className={cn('text-xs font-medium', annual ? 'text-slate-900' : 'text-slate-400')}>Annual <span className="text-[#C4922A]">2mo free</span></span>
          </div>
        </div>

        <div className="space-y-3">
          {PLANS.map((plan) => {
            const isCurrent = currentTier === plan.tier
            const priceId = annual ? plan.annualPriceId : plan.monthlyPriceId
            return (
              <div key={plan.tier} className={cn('bg-white rounded-xl border p-5 flex items-center justify-between gap-4', isCurrent ? 'border-[#1B2850] ring-1 ring-[#1B2850]' : 'border-slate-100')}>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-sm font-bold text-slate-900">{plan.name}</p>
                    {isCurrent && <span className="text-xs bg-[#1B2850] text-white px-2 py-0.5 rounded-full">Current</span>}
                  </div>
                  <p className="text-xs text-slate-500">{plan.credits} credits/month · {plan.features[2]}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  {plan.monthlyPrice === 0 ? (
                    <p className="text-sm font-bold text-slate-900">Free</p>
                  ) : (
                    <div>
                      <p className="text-sm font-bold text-slate-900">${annual ? Math.round(plan.annualPrice / 12) : plan.monthlyPrice}<span className="text-xs font-normal text-slate-400">/mo</span></p>
                      {annual && <p className="text-xs text-[#C4922A]">${plan.annualPrice}/yr</p>}
                    </div>
                  )}
                  {!isCurrent && plan.monthlyPrice > 0 && priceId && (
                    <button
                      onClick={() => handleCheckout(priceId, 'subscription')}
                      disabled={!!checkingOut}
                      className="mt-2 px-4 py-1.5 bg-[#1B2850] text-white text-xs font-semibold rounded-lg hover:bg-[#162040] transition-colors disabled:opacity-60 flex items-center gap-1.5"
                    >
                      {checkingOut === priceId && <Loader2 className="w-3 h-3 animate-spin" />}
                      Upgrade
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Credit packs */}
      <div>
        <h2 className="text-sm font-semibold text-slate-900 mb-4">Purchase Credits</h2>
        <div className="grid grid-cols-3 gap-3">
          {CREDIT_PACKS.map((pack) => (
            <div key={pack.name} className="bg-white rounded-xl border border-slate-100 p-4 text-center">
              <p className="text-lg font-bold text-slate-900 mb-0.5">{pack.credits}</p>
              <p className="text-xs text-slate-400 mb-3">credits</p>
              <p className="text-sm font-semibold text-slate-700 mb-3">${pack.amount}</p>
              {pack.priceId ? (
                <button
                  onClick={() => handleCheckout(pack.priceId!, 'payment')}
                  disabled={!!checkingOut}
                  className="w-full py-1.5 bg-[#C4922A] text-white text-xs font-semibold rounded-lg hover:bg-[#b07e21] transition-colors disabled:opacity-60"
                >
                  {checkingOut === pack.priceId ? <Loader2 className="w-3 h-3 animate-spin mx-auto" /> : 'Purchase'}
                </button>
              ) : (
                <button disabled className="w-full py-1.5 bg-slate-100 text-slate-400 text-xs font-semibold rounded-lg">
                  Unavailable
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>}>
      <BillingInner />
    </Suspense>
  )
}
