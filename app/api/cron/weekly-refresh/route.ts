import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateBatchForMember } from '@/lib/generate-recommendations'
import { weeklyEligibilityCheck } from '@/lib/introductions/queue'

/**
 * THE weekly recommendation GENERATION cadence for the unified queue.
 *
 * Generation and promotion are separate concerns: this cron only GENERATES. It never
 * promotes — promotion (revealing a queued batch) happens immediately when a member
 * resolves their active batch (see promoteIfResolved in the pass / express-interest
 * paths). For each active, profile-complete member it generates ONE new batch, but
 * only when weeklyEligibilityCheck passes: no queued batch already waiting, and not
 * sitting behind an incomplete admin reciprocal batch. This bounds the queue to
 * "current + optional next" — no backlog, no rapid cycling through the network.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const adminClient = createAdminClient()
  console.log('[Weekly Generation] Starting weekly recommendation generation...')

  const { data: users } = await adminClient
    .from('profiles')
    .select('id, email')
    .eq('account_status', 'active')
    .eq('profile_complete', true)
    .not('is_test_account', 'is', true)

  if (!users) return NextResponse.json({ error: 'No users found' }, { status: 500 })

  let generated = 0
  let skippedIneligible = 0
  let placedNothing = 0
  for (const user of users) {
    try {
      const eligible = await weeklyEligibilityCheck(adminClient, user.id)
      if (!eligible) { skippedIneligible++; continue }
      const result = await generateBatchForMember(user.id, 'weekly')
      if (result.placed) generated++
      else placedNothing++
    } catch (err) {
      console.error(`[Weekly Generation] Error for ${user.email}:`, err)
    }
  }

  console.log(`[Weekly Generation] Complete. Generated for ${generated} members; ${skippedIneligible} ineligible (queued/behind admin); ${placedNothing} had no candidates.`)
  return NextResponse.json({ success: true, generated, skippedIneligible, placedNothing })
}
