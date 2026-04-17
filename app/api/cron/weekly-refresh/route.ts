import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateOnboardingRecommendations } from '@/lib/generate-recommendations'

const TIER_ACTIVE_SLOTS: Record<string, number> = {
  free: 3,
  professional: 5,
  executive: 8
}

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  const adminClient = createAdminClient()
  
  console.log('[Weekly Refresh] Starting weekly batch generation...')
  
  const { data: users } = await adminClient
    .from('profiles')
    .select('id, email, subscription_tier')
    .eq('account_status', 'active')
    .eq('profile_complete', true)
  
  if (!users) return NextResponse.json({ error: 'No users found' }, { status: 500 })
  
  let processed = 0
  
  for (const user of users) {
    try {
      const tier = user.subscription_tier || 'free'
      const targetSlots = TIER_ACTIVE_SLOTS[tier]
      
      // Count current active suggestions
      const { data: activeIntros } = await adminClient
        .from('intro_requests')
        .select('id')
        .eq('requester_id', user.id)
        .eq('status', 'suggested')
      
      const currentCount = activeIntros?.length || 0
      
      // Archive stale suggestions (>72 hours old)
      const staleDate = new Date()
      staleDate.setHours(staleDate.getHours() - 72)
      
      const { data: archivedIntros, error: archiveError } = await adminClient
        .from('intro_requests')
        .update({ status: 'archived' })
        .eq('requester_id', user.id)
        .eq('status', 'suggested')
        .lt('created_at', staleDate.toISOString())
        .select()
      
      if (archivedIntros && archivedIntros.length > 0) {
        console.log(`[Weekly Refresh] Archived ${archivedIntros.length} stale intros for ${user.email}`)
      }
      
      // Recount after archiving
      const { data: activeAfterArchive } = await adminClient
        .from('intro_requests')
        .select('id')
        .eq('requester_id', user.id)
        .eq('status', 'suggested')
      
      const currentCountAfterArchive = activeAfterArchive?.length || 0
      
      // Generate new recommendations if below target
      if (currentCountAfterArchive < targetSlots) {
        await generateOnboardingRecommendations(user.id)
        processed++
      }
      
    } catch (err) {
      console.error(`[Weekly Refresh] Error for ${user.email}:`, err)
    }
  }
  
  console.log(`[Weekly Refresh] Complete. Processed ${processed} users.`)
  
  return NextResponse.json({ success: true, processed })
}
