import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateOnboardingRecommendations } from '@/lib/generate-recommendations'
import { getEffectiveTier, getMonthlyCredits } from '@/lib/tier-override'

const TIER_CREDIT_FLOORS: Record<string, number> = {
  free: 3,
  professional: 10,
  executive: 20,
  founding: 30
}
const TIER_CREDIT_CAPS: Record<string, number> = {
  free: 6,
  professional: 20,
  executive: 40
}

const TIER_ACTIVE_SLOTS: Record<string, number> = {
  free: 3,
  professional: 5,
  executive: 8,
  founding: 5  // Same as professional for weekly batches
}

export async function GET(req: Request) {
  // Verify this is from Vercel Cron
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  const adminClient = createAdminClient()
  
  console.log('[Monthly Refill] Starting monthly credit refill...')
  
  // Get all active users
  const { data: users, error: usersError } = await adminClient
    .from('profiles')
    .select('id, email, subscription_tier, is_founding_member, founding_member_expires_at')
    .eq('account_status', 'active')
    .eq('profile_complete', true)
  
  if (usersError || !users) {
    console.error('[Monthly Refill] Error fetching users:', usersError)
    return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 })
  }
  
  console.log(`[Monthly Refill] Processing ${users.length} users`)
  
  let processedCount = 0
  let errorCount = 0
  
  for (const user of users) {
    try {
      const effectiveTier = getEffectiveTier(user)
      const creditFloor = getMonthlyCredits(effectiveTier)
      const targetSlots = TIER_ACTIVE_SLOTS[effectiveTier]
      
      // 1. Refill credits to floor (not additive)
      const { data: currentCredits } = await adminClient
        .from('meeting_credits')
        .select('free_credits, premium_credits, balance, lifetime_earned')
        .eq('user_id', user.id)
        .single()
      
      const currentFree = currentCredits?.free_credits || 0
      const currentPremium = currentCredits?.premium_credits || 0
      const newFreeBalance = Math.max(currentFree, creditFloor)
      
      // Only refill FREE credits, premium credits never auto-refill
      if (newFreeBalance > currentFree) {
        const { error: creditError } = await adminClient
          .from('meeting_credits')
          .upsert({
            user_id: user.id,
            free_credits: newFreeBalance,
            premium_credits: currentPremium, // Keep premium unchanged
            balance: newFreeBalance + currentPremium, // Keep legacy field in sync
            lifetime_earned: (currentCredits?.lifetime_earned || 0) + (newFreeBalance - currentFree)
          }, { onConflict: 'user_id' })
        
        if (creditError) {
          console.error(`[Monthly Refill] Credit update error for ${user.email}:`, creditError)
          errorCount++
        } else {
          console.log(`[Monthly Refill] ${user.email}: Free credits ${currentFree} → ${newFreeBalance} (Premium: ${currentPremium})`)
        }
      }
      
      // 2. Count active suggestions (preserve important states)
      const { data: activeIntros, error: activeError } = await adminClient
        .from('intro_requests')
        .select('id, status')
        .eq('requester_id', user.id)
        .in('status', ['suggested', 'pending', 'accepted', 'matched'])
      
      if (activeError) {
        console.error(`[Monthly Refill] Error fetching intros for ${user.email}:`, activeError)
        errorCount++
        continue
      }
      
      const activeSuggestions = activeIntros?.filter(i => i.status === 'suggested') || []
      const activeCount = activeSuggestions.length
      
      console.log(`[Monthly Refill] ${user.email}: ${activeCount} active suggestions, target: ${targetSlots}`)
      
      // 3. Archive stale untouched suggestions (older than 7 days)
      const sevenDaysAgo = new Date()
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
      
      const { error: archiveError } = await adminClient
        .from('intro_requests')
        .update({ status: 'archived' })
        .eq('requester_id', user.id)
        .eq('status', 'suggested')
        .lt('created_at', sevenDaysAgo.toISOString())
      
      if (archiveError) {
        console.error(`[Monthly Refill] Error archiving for ${user.email}:`, archiveError)
      }
      
      // 4. Generate new suggestions to fill target slots
      const slotsNeeded = targetSlots - activeCount
      
      if (slotsNeeded > 0) {
        console.log(`[Monthly Refill] ${user.email}: Generating ${slotsNeeded} new suggestions`)
        
        // Generate recommendations (it will create up to targetSlots total)
        await generateOnboardingRecommendations(user.id)
      }
      
      processedCount++
      
    } catch (err) {
      console.error(`[Monthly Refill] Error processing ${user.email}:`, err)
      errorCount++
    }
  }
  
  console.log(`[Monthly Refill] Complete. Processed: ${processedCount}, Errors: ${errorCount}`)
  
  return NextResponse.json({
    success: true,
    processed: processedCount,
    errors: errorCount,
    total: users.length
  })
}
