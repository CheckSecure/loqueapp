import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getQueueHealthMetrics, getBatchLifecycleMetrics } from '@/lib/introductions/queue-metrics'

export const dynamic = 'force-dynamic'

/**
 * Recommendation-queue analytics for the admin console: per-member queue-state
 * census (queue health) plus batch lifecycle timing and interest/pass/match rates.
 * Operational only — never member-facing. Auth-gated to the admin account.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== 'bizdev91@gmail.com') {
    return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
  }
  const adminClient = createAdminClient()
  const [health, lifecycle] = await Promise.all([
    getQueueHealthMetrics(adminClient),
    getBatchLifecycleMetrics(adminClient),
  ])
  return NextResponse.json({ health, lifecycle })
}
