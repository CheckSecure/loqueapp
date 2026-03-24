import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-02-25.clover',
})

export const PLANS = {
  professional: {
    name: 'Professional',
    monthly: process.env.STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID!,
    annual: process.env.STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID!,
    monthlyAmount: 49,
    annualAmount: 470,
    credits: 15,
    introductions: '4–6 per week',
  },
  executive: {
    name: 'Executive',
    monthly: process.env.STRIPE_EXECUTIVE_MONTHLY_PRICE_ID!,
    annual: process.env.STRIPE_EXECUTIVE_ANNUAL_PRICE_ID!,
    monthlyAmount: 99,
    annualAmount: 990,
    credits: 30,
    introductions: '6–10 per week',
  },
} as const

export const CREDIT_PACKS = [
  { name: '5 Credits', credits: 5, amount: 25, priceId: process.env.STRIPE_CREDIT_5_PRICE_ID },
  { name: '10 Credits', credits: 10, amount: 45, priceId: process.env.STRIPE_CREDIT_10_PRICE_ID },
  { name: '25 Credits', credits: 25, amount: 99, priceId: process.env.STRIPE_CREDIT_25_PRICE_ID },
]
