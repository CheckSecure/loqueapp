'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Loader2, Check, Zap, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

const TIERS = [
  {
    tier: 'free',
    name: 'Free',
    tagline: 'Explore the network',
    bullets: ['Curated introductions each week', '3 introduction credits per month', 'Standard matching priority'],
    monthlyPrice: 0,
    annualPrice: 0,
    highlight: false,
  },
  {
    tier: 'professional',
    name: 'Professional',
    tagline: 'Build high-value relationships',
    bullets: ['Priority matching with higher-quality members', 'More frequent introductions each week', 'Increased visibility in the network'],
    monthlyPrice: 49,
    annualPrice: 470,
    highlight: true,
    monthlyPriceId: process.env.NEXT_PUBLIC_STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID,
    annualPriceId: process.env.NEXT_PUBLIC_STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID,
  },
  {
    tier: 'executive',
    name: 'Executive',
    tagline: 'Access the highest-value connections',
    bullets: ['Concierge-level curation by the Andrel team', 'Top placement in the matching system', 'The most meaningful introductions, more often'],
    monthlyPrice: 99,
    annualPrice: 990,
    highlight: false,
    monthlyPriceId: process.env.NEXT_PUBLIC_STRIPE_EXECUTIVE_MONTHLY_PRICE_ID,
    annualPriceId: process.env.NEXT_PUBLIC_STRIPE_EXECUTIVE_ANNUAL_PRICE_ID,
  },
]

const CREDIT_PACKS = [
  { name: '5 Credits', credits: 5, amount: 25, priceId: process.env.NEXT_PUBLIC_STRIPE_CREDIT_5_PRICE_ID },
  { name: '10 Credits', credits: 10, amount: 45, priceId: process.env.NEXT_PUBLIC_STRIPE_CREDIT_10_PRICE_ID },
  { name: '25 Credits', credits: 25, amount: 99, priceId: process.env.NEXT_PUBLIC_STRIPE_CREDIT_25_PRICE_ID },
]

const TIER_VALUE: Record<string, string> = {
  free: 'You have access to a curated set of introductions each week based on your profile and goals.',
  professional: 'You receive priority matching with higher-quality members and increased visibility in the network.',
  executive: 'You have top placement in the matching system with concierge-level curation and the highest-value introductions.',
}

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
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 space-y-10">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">Membership</h1>
        <p className="text-slate-500 text-sm mt-2">Your membership determines the quality, priority, and frequency of your introductions.</p>
      </div>

      {success && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 text-sm font-medium px-4 py-3 rounded-lg">
          <Check className="w-4 h-4" /> Your membership has been updated.
        </div>
      )}
      {cancelled && (
        <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm px-4 py-3 rounded-lg">
          Checkout was cancelled. No changes were made.
        </div>
      )}

      {/* Current membership */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900">Current Membership</h2>
        </div>
        <div className="px-6 py-5">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-brand-navy flex items-center justify-center flex-shrink-0">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-sm font-bold text-slate-900 capitalize">{currentTier}</p>
                {currentTier !== 'free' && periodEnd && (
                  <span className="text-xs text-slate-400">· Renews {periodEnd}</span>
                )}
              </div>
              <p className="text-sm text-slate-500 leading-relaxed">{TIER_VALUE[currentTier]}</p>
              <p className="text-xs text-slate-400 mt-2">{credits} credit{credits !== 1 ? 's' : ''} remaining</p>
            </div>
          </div>
        </div>
      </div>

      {/* Tier selector */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-900">Upgrade Membership</h2>
          <div className="flex items-center gap-2">
            <span className={cn('text-xs font-medium', !annual ? 'text-slate-900' : 'text-slate-400')}>Monthly</span>
            <button onClick={() => setAnnual(v => !v)} className={cn('relative w-9 h-5 rounded-full transition-colors', annual ? 'bg-brand-navy' : 'bg-slate-200')}>
              <span className={cn('absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform', annual && 'translate-x-4')} />
            </button>
            <span className={cn('text-xs font-medium', annual ? 'text-slate-900' : 'text-slate-400')}>Annual <span className="text-brand-gold">2mo free</span></span>
          </div>
        </div>

        <div className="space-y-3">
          {TIERS.map((plan) => {
            const isCurrent = currentTier === plan.tier
            const priceId = annual ? plan.annualPriceId : plan.monthlyPriceId
            return (
              <div key={plan.tier} className={cn(
                'bg-white rounded-2xl border p-5',
                isCurrent ? 'border-brand-navy ring-1 ring-brand-navy' : 'border-slate-100',
                plan.highlight && !isCurrent ? 'shadow-md' : 'shadow-sm'
              )}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-sm font-bold text-slate-900">{plan.name}</p>
                      {isCurrent && <span className="text-xs bg-brand-navy text-white px-2 py-0.5 rounded-full">Current</span>}
                      {plan.highlight && !isCurrent && <span className="text-xs bg-brand-gold-soft text-brand-gold border border-brand-gold/20 px-2 py-0.5 rounded-full">Most popular</span>}
                    </div>
                    <p className="text-xs text-slate-500 mb-3 leading-relaxed">{plan.tagline}</p>
                    <ul className="space-y-2">
                      {(plan as any).bullets?.map((b: string) => (
                        <li key={b} className="flex items-start gap-2 text-xs text-slate-600 leading-relaxed">
                          <Check className="w-3.5 h-3.5 text-brand-gold mt-0.5 flex-shrink-0" />
                          <span>{b}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="text-right flex-shrink-0">
                    {plan.monthlyPrice === 0 ? (
                      <p className="text-sm font-bold text-slate-900">Free</p>
                    ) : (
                      <div>
                        <p className="text-sm font-bold text-slate-900">
                          ${annual ? Math.round(plan.annualPrice / 12) : plan.monthlyPrice}
                          <span className="text-xs font-normal text-slate-400">/mo</span>
                        </p>
                        {annual && <p className="text-xs text-brand-gold">${plan.annualPrice}/yr</p>}
                      </div>
                    )}
                    {!isCurrent && plan.monthlyPrice > 0 && priceId && (
                      <button
                        onClick={() => handleCheckout(priceId, 'subscription')}
                        disabled={!!checkingOut}
                        className="mt-2 inline-flex items-center gap-1 px-4 py-1.5 bg-brand-navy text-white text-xs font-semibold rounded-xl hover:bg-brand-navy-dark transition-colors disabled:opacity-60"
                      >
                        {checkingOut === priceId ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRight className="w-3 h-3" />}
                        Upgrade
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Credits */}
      <div>
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-slate-900">Introduction Credits</h2>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed">Credits keep introductions intentional. A credit is used when a connection is successfully made. Credit packs unlock additional introductions when you want more access.</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {CREDIT_PACKS.map((pack) => (
            <div key={pack.name} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 text-center">
              <p className="text-lg font-bold text-slate-900 mb-0.5">{pack.credits}</p>
              <p className="text-xs text-slate-400 mb-3">credits</p>
              <p className="text-sm font-semibold text-slate-700 mb-3">${pack.amount}</p>
              {pack.priceId ? (
                <button
                  onClick={() => handleCheckout(pack.priceId!, 'payment')}
                  disabled={!!checkingOut}
                  className="w-full py-1.5 bg-brand-gold text-white text-xs font-semibold rounded-xl hover:bg-[#b07e21] transition-colors disabled:opacity-60"
                >
                  {checkingOut === pack.priceId ? <Loader2 className="w-3 h-3 animate-spin mx-auto" /> : 'Purchase'}
                </button>
              ) : (
                <button disabled className="w-full py-1.5 bg-slate-100 text-slate-400 text-xs font-semibold rounded-xl">Unavailable</button>
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
