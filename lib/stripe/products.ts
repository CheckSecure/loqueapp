import { getUncachableStripeClient } from './stripeClient'

export interface LoquePrice {
  priceId: string
  amount: number
  interval: 'month' | 'year' | 'one_time'
}

export interface LoqueProduct {
  id: string
  name: string
  description: string | null
  metadata: Record<string, string>
  prices: LoquePrice[]
}

export async function getLoqueProducts(): Promise<LoqueProduct[]> {
  try {
    const stripe = await getUncachableStripeClient()
    const products = await stripe.products.list({ active: true, limit: 20, expand: ['data.default_price'] })

    const result: LoqueProduct[] = []

    for (const product of products.data) {
      const prices = await stripe.prices.list({ product: product.id, active: true })
      result.push({
        id: product.id,
        name: product.name,
        description: product.description,
        metadata: (product.metadata as Record<string, string>) ?? {},
        prices: prices.data.map(p => ({
          priceId: p.id,
          amount: p.unit_amount ?? 0,
          interval: p.recurring ? (p.recurring.interval as 'month' | 'year') : 'one_time',
        })),
      })
    }

    return result
  } catch (err: any) {
    console.error('[getLoqueProducts]', err.message)
    return []
  }
}
