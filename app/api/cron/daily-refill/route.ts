import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateOnboardingRecommendations } from '@/lib/generate-recommendations'
import { getEffectiveTier } from '@/lib/tier-override'

const TIER_ACTIVE_SLOTS: Record<string, number> = {
  free: 3,
  professional: 5,
  executive: 8,
  founding: 5  // Same as professional for weekly batches
}

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  const adminClient = createAdminClient()
  
  console.log('[Daily Refill] Starting daily top-up...')
  
  const { data: users } = await adminClient
    .from('profiles')
    .select('id, email, subscription_tier')
    .eq('account_status', 'active')
    .eq('profile_complete', true)
  
  if (!users) return NextResponse.json({ error: 'No users found' }, { status: 500 })
  
  let topped = 0
  
  for (const user of users) {
    try {
      const tier = getEffectiveTier(user)
      const targetSlots = TIER_ACTIVE_SLOTS[tier]
      
      const { data: activeIntros } = await adminClient
        .from('intro_requests')
        .select('id')
        .or(`requester_id.eq.${user.id},target_user_id.eq.${user.id}`)
        .in('status', ['suggested', 'accepted', 'admin_pending', 'approved'])

      const currentCount = activeIntros?.length || 0
      const slotsNeeded = targetSlots - currentCount
      
      // If significantly below target (2+ slots missing), add 1-2 new candidates
      if (slotsNeeded >= 2) {
        // Rotate out oldest suggestion first
        const { data: oldest } = await adminClient
          .from('intro_requests')
          .select('id')
          .eq('requester_id', user.id)
          .eq('status', 'suggested')
          .order('created_at', { ascending: true })
          .limit(1)
          .single()
        
        if (oldest) {
          await adminClient
            .from('intro_requests')
            .update({ status: 'archived' })
            .eq('id', oldest.id)
        }
        
        // Recount after rotation — slotsNeeded is stale after archive
        const { data: activeAfterRotate } = await adminClient
          .from('intro_requests')
          .select('id')
          .or(`requester_id.eq.${user.id},target_user_id.eq.${user.id}`)
          .in('status', ['suggested', 'accepted', 'admin_pending', 'approved'])

        const slotsToFill = Math.max(0, targetSlots - (activeAfterRotate?.length || 0))
        if (slotsToFill > 0) {
          await generateOnboardingRecommendations(user.id, slotsToFill)
        }
        topped++
      }
      
    } catch (err) {
      console.error(`[Daily Refill] Error for ${user.email}:`, err)
    }
  }
  
  console.log(`[Daily Refill] Topped up ${topped} users`)
  
  return NextResponse.json({ success: true, topped })
}
