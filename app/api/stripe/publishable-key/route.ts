import { NextResponse } from 'next/server'
import { getStripePublishableKey } from '@/lib/stripe/stripeClient'

export async function GET() {
  try {
    const publishableKey = await getStripePublishableKey()
    return NextResponse.json({ publishableKey })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
