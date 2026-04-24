'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import Link from 'next/link'
import { Check } from 'lucide-react'

const PLANS = [
  {
    name: 'Free',
    monthlyPrice: 0,
    annualPrice: 0,
    description: 'Begin your Andrel journey with curated introductions.',
    features: [
      'Curated introductions each week',
      '3 credits per month',
      'Standard matching priority',
      'Up to 2 active opportunities in your For You feed',
      'Respond to opportunities sent your way',
    ],
    cta: 'Get Started',
    href: '/signup',
    highlight: false,
    tier: 'free',
  },
  {
    name: 'Professional',
    monthlyPrice: 49,
    annualPrice: 470,
    description: 'Priority access and the ability to signal your needs.',
    features: [
      'More frequent curated introductions',
      '15 credits per month',
      'Priority matching',
      'Up to 5 active opportunities in your For You feed',
      'Signal hiring or business needs — 1 active at a time',
      'Higher ranking in opportunity matching',
    ],
    cta: 'Upgrade to Professional',
    highlight: true,
    tier: 'professional',
  },
  {
    name: 'Executive',
    monthlyPrice: 99,
    annualPrice: 990,
    description: 'Concierge-level curation for senior leaders and executives.',
    features: [
      'Most frequent curated introductions',
      '30 credits per month',
      'Highest matching priority',
      'Up to 5 active opportunities in your For You feed',
      'Signal hiring or business needs — 2 active at a time',
      'Strongest opportunity ranking boost',
      'Best for senior leaders, rainmakers, and hiring managers',
    ],
    cta: 'Upgrade to Executive',
    highlight: false,
    tier: 'executive',
  },
]

export default function PricingPage() {
  const [annual, setAnnual] = useState(false)
  const router = useRouter()

  const handleUpgrade = async (tier: string) => {
    if (tier === 'free') { router.push('/signup'); return }
    router.push(`/dashboard/billing?upgrade=${tier}&cadence=${annual ? 'annual' : 'monthly'}`)
  }

  return (
    <div className="min-h-screen bg-brand-cream px-4 sm:px-6 py-12 sm:py-16">
      <div className="max-w-5xl mx-auto">

        <div className="text-center mb-12">
          <Link href="/" className="text-xl font-bold text-brand-navy tracking-tight block mb-8">Andrel</Link>
          <h1 className="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight mb-3">Membership</h1>
          <p className="text-slate-500 max-w-lg mx-auto leading-relaxed">Access to Andrel is invitation-only. Your membership level determines the depth and frequency of your introductions.</p>

          {/* Billing toggle */}
          <div className="flex items-center justify-center gap-3 mt-8">
            <span className={cn('text-sm font-medium', !annual ? 'text-slate-900' : 'text-slate-400')}>Monthly</span>
            <button
              onClick={() => setAnnual(v => !v)}
              className={cn('relative w-11 h-6 rounded-full transition-colors', annual ? 'bg-brand-navy' : 'bg-slate-200')}
            >
              <span className={cn('absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform', annual && 'translate-x-5')} />
            </button>
            <span className={cn('text-sm font-medium', annual ? 'text-slate-900' : 'text-slate-400')}>
              Annual <span className="text-brand-gold font-semibold">2 months free</span>
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                'bg-white rounded-2xl border shadow-sm overflow-hidden flex flex-col',
                plan.highlight ? 'border-brand-navy shadow-lg ring-1 ring-brand-navy' : 'border-slate-100'
              )}
            >
              {plan.highlight && (
                <div className="bg-brand-navy text-white text-xs font-semibold text-center py-1.5 tracking-wide uppercase">
                  Most Popular
                </div>
              )}
              <div className="p-6 flex-1 flex flex-col">
                <div className="mb-6">
                  <h2 className="text-lg font-bold text-slate-900 mb-1">{plan.name}</h2>
                  <p className="text-xs text-slate-500 leading-relaxed">{plan.description}</p>
                </div>

                <div className="mb-6">
                  {plan.monthlyPrice === 0 ? (
                    <span className="text-3xl font-bold text-slate-900">Free</span>
                  ) : (
                    <div>
                      <span className="text-3xl font-bold text-slate-900">
                        ${annual ? Math.round(plan.annualPrice / 12) : plan.monthlyPrice}
                      </span>
                      <span className="text-slate-400 text-sm ml-1">/month</span>
                      {annual && (
                        <p className="text-xs text-brand-gold font-medium mt-1">
                          ${plan.annualPrice} billed annually
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <ul className="space-y-3 mb-8 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-brand-gold flex-shrink-0 mt-0.5" />
                      <span className="text-sm text-slate-600">{f}</span>
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => handleUpgrade(plan.tier)}
                  className={cn(
                    'w-full py-2.5 rounded-xl text-sm font-semibold transition-colors',
                    plan.highlight
                      ? 'bg-brand-navy text-white hover:bg-brand-navy-dark'
                      : plan.monthlyPrice === 0
                      ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                      : 'bg-brand-gold text-white hover:bg-[#b07e21]'
                  )}
                >
                  {plan.cta}
                </button>
              </div>
            </div>
          ))}
        </div>

        <p className="text-center text-xs text-slate-400 mt-10">
          All memberships are subject to Andrel's{' '}
          <Link href="/terms" className="underline hover:text-slate-600">Terms of Service</Link>.
          Cancel anytime.
        </p>
      </div>
    </div>
  )
}
