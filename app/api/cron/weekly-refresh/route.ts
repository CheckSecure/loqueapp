import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { releaseNextBatchIfComplete } from '@/lib/generate-recommendations'

/**
 * THE weekly recommendation release — the single scheduled cadence for the unified
 * recommendation cycle (onboarding delivers the first batch; this delivers every
 * subsequent one). For each active member it releases the next batch
 * (RECOMMENDATIONS_PER_BATCH) ONLY if their current batch is complete — every
 * recommendation acted on (interest expressed or passed/dismissed). Members with an
 * unresolved batch get nothing, so they can't rapidly cycle through the network.
 * The daily-refill and monthly-batch crons are retired (they no longer produce
 * recommendations) so this is the only release path.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const adminClient = createAdminClient()
  console.log('[Weekly Release] Starting weekly recommendation release...')

  const { data: users } = await adminClient
    .from('profiles')
    .select('id, email')
    .eq('account_status', 'active')
    .eq('profile_complete', true)
    .not('is_test_account', 'is', true)

  if (!users) return NextResponse.json({ error: 'No users found' }, { status: 500 })

  let released = 0
  let skippedIncomplete = 0
  for (const user of users) {
    try {
      const result = await releaseNextBatchIfComplete(adminClient, user.id)
      if (result.released) released++
      else skippedIncomplete++
    } catch (err) {
      console.error(`[Weekly Release] Error for ${user.email}:`, err)
    }
  }

  console.log(`[Weekly Release] Complete. Released to ${released} members; ${skippedIncomplete} still had an open batch.`)
  return NextResponse.json({ success: true, released, skippedIncomplete })
}
