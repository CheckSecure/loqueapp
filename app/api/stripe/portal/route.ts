import { NextRequest, NextResponse } from 'next/server'
import { readProfileById } from '@/lib/profiles/serverProfile'
import { createClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe'

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    // Read as service_role: migration 058 revoked authenticated SELECT on public.profiles, and
    // this read was silently failing — every member saw "No billing account found" whether or not
    // they had one. `unavailable` must not be reported as "no billing account".
    const read = await readProfileById<{ stripe_customer_id: string | null }>(
      user.id, 'stripe_customer_id', 'stripe-portal')
    if (!read.ok && read.reason === 'unavailable') {
      return NextResponse.json({ error: 'Billing is temporarily unavailable. Please try again.' }, { status: 503 })
    }
    const profile = read.ok ? read.profile : null

    if (!profile?.stripe_customer_id) {
      return NextResponse.json({ error: 'No billing account found' }, { status: 400 })
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${process.env.NEXT_PUBLIC_SITE_URL}/dashboard/billing`,
    })

    return NextResponse.json({ url: portalSession.url })
  } catch (err: any) {
    console.error('[stripe/portal]', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
