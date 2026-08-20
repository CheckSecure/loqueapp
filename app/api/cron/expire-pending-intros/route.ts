import { NextResponse } from 'next/server'
import { runExpiryStage } from '@/lib/introductions/expiryWorker'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const adminClient = createAdminClient()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await adminClient
    .from('intro_requests')
    .update({ status: 'expired', expired_at: new Date().toISOString() })
    .eq('status', 'pending')
    .lt('created_at', thirtyDaysAgo)
    .select('id')

  if (error) {
    console.error('[Expire Pending] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  console.log(`[Expire Pending] Expired ${data?.length ?? 0} pending intro requests`)
  // Shared stage. This route keeps its original 30-day 'pending' sweep above and ALSO runs the
  // suggested-card expiry, but nothing depends on this route being scheduled: engagement-reminders
  // runs the same stage daily. See lib/introductions/expiryWorker.ts.
  const exp = await runExpiryStage(adminClient, { budgetMs: 40_000 })

  return NextResponse.json({
    suggestedExpiry: exp, expired: data?.length ?? 0 })
}
