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
    credits: '3 credits / month',
    introductions: 'Based on your membership',
    features: [
      'Curated introductions each week',
      '3 introduction credits per month',
      'Standard matching priority',
      'Messaging after introduction',
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
    description: 'Priority access to a wider network of high-value connections.',
    credits: '15 credits / month',
    introductions: 'Based on your membership',
    features: [
      'Expanded curated introductions each week',
      '15 introduction credits per month',
      'Priority matching',
      'Express interest in specific members',
      'Increased visibility in the matching system',
    ],
    cta: 'Upgrade to Professional',
    highlight: true,
    tier: 'professional',
  },
  {
    name: 'Executive',
    monthlyPrice: 99,
    annualPrice: 990,
    description: 'Concierge-level curation for professionals who demand the best.',
    credits: '30 credits / month',
    introductions: 'Based on your membership',
    features: [
      'Maximum curated introductions each week',
      '30 introduction credits per month',
      'Highest matching priority',
      'Concierge-style manual curation',
      'Top placement in recommendation system',
      'Faster resurfacing of relevant profiles',
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
    <div className="min-h-screen bg-[#F5F6FB] px-4 py-16">
      <div className="max-w-5xl mx-auto">

        <div className="text-center mb-12">
          <Link href="/" className="text-xl font-bold text-[#1B2850] tracking-tight block mb-8">Andrel</Link>
          <h1 className="text-3xl font-bold text-slate-900 mb-3">Membership</h1>
          <p className="text-slate-500 max-w-md mx-auto">Access to Andrel is invitation-only. Your membership level determines the depth and frequency of your introductions.</p>

          {/* Billing toggle */}
          <div className="flex items-center justify-center gap-3 mt-8">
            <span className={cn('text-sm font-medium', !annual ? 'text-slate-900' : 'text-slate-400')}>Monthly</span>
            <button
              onClick={() => setAnnual(v => !v)}
              className={cn('relative w-11 h-6 rounded-full transition-colors', annual ? 'bg-[#1B2850]' : 'bg-slate-200')}
            >
              <span className={cn('absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform', annual && 'translate-x-5')} />
            </button>
            <span className={cn('text-sm font-medium', annual ? 'text-slate-900' : 'text-slate-400')}>
              Annual <span className="text-[#C4922A] font-semibold">2 months free</span>
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                'bg-white rounded-2xl border shadow-sm overflow-hidden flex flex-col',
                plan.highlight ? 'border-[#1B2850] shadow-lg ring-1 ring-[#1B2850]' : 'border-slate-100'
              )}
            >
              {plan.highlight && (
                <div className="bg-[#1B2850] text-white text-xs font-semibold text-center py-1.5 tracking-wide uppercase">
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
                        <p className="text-xs text-[#C4922A] font-medium mt-1">
                          ${plan.annualPrice} billed annually
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <ul className="space-y-3 mb-8 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-[#C4922A] flex-shrink-0 mt-0.5" />
                      <span className="text-sm text-slate-600">{f}</span>
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => handleUpgrade(plan.tier)}
                  className={cn(
                    'w-full py-2.5 rounded-lg text-sm font-semibold transition-colors',
                    plan.highlight
                      ? 'bg-[#1B2850] text-white hover:bg-[#162040]'
                      : plan.monthlyPrice === 0
                      ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                      : 'bg-[#C4922A] text-white hover:bg-[#b07e21]'
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
