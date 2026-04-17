import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateOnboardingRecommendations } from '@/lib/generate-recommendations'

const TIER_CREDIT_FLOORS: Record<string, number> = {
  free: 3,
  professional: 5,
  executive: 8
}

const TIER_ACTIVE_SLOTS: Record<string, number> = {
  free: 3,
  professional: 5,
  executive: 8
}

export async function GET(req: Request) {
  // Verify this is from Vercel Cron
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  const adminClient = createAdminClient()
  
  console.log('[Weekly Batch] Starting weekly refresh...')
  
  // Get all active users
  const { data: users, error: usersError } = await adminClient
    .from('profiles')
    .select('id, email, subscription_tier')
    .eq('account_status', 'active')
    .eq('profile_complete', true)
  
  if (usersError || !users) {
    console.error('[Weekly Batch] Error fetching users:', usersError)
    return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 })
  }
  
  console.log(`[Weekly Batch] Processing ${users.length} users`)
  
  let processedCount = 0
  let errorCount = 0
  
  for (const user of users) {
    try {
      const tier = user.subscription_tier || 'free'
      const creditFloor = TIER_CREDIT_FLOORS[tier]
      const targetSlots = TIER_ACTIVE_SLOTS[tier]
      
      // 1. Refill credits to floor (not additive)
      const { data: currentCredits } = await adminClient
        .from('meeting_credits')
        .select('balance, lifetime_earned')
        .eq('user_id', user.id)
        .single()
      
      const currentBalance = currentCredits?.balance || 0
      const newBalance = Math.max(currentBalance, creditFloor)
      
      if (newBalance > currentBalance) {
        await adminClient
          .from('meeting_credits')
          .upsert({
            user_id: user.id,
            balance: newBalance,
            lifetime_earned: (currentCredits?.lifetime_earned || 0) + (newBalance - currentBalance)
          })
        console.log(`[Weekly Batch] ${user.email}: Credits ${currentBalance} → ${newBalance}`)
      }
      
      // 2. Count active suggestions (preserve important states)
      const { data: activeIntros, error: activeError } = await adminClient
        .from('intro_requests')
        .select('id, status')
        .eq('requester_id', user.id)
        .in('status', ['suggested', 'pending', 'accepted', 'matched'])
      
      if (activeError) {
        console.error(`[Weekly Batch] Error fetching intros for ${user.email}:`, activeError)
        errorCount++
        continue
      }
      
      const activeSuggestions = activeIntros?.filter(i => i.status === 'suggested') || []
      const activeCount = activeSuggestions.length
      
      console.log(`[Weekly Batch] ${user.email}: ${activeCount} active suggestions, target: ${targetSlots}`)
      
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
        console.error(`[Weekly Batch] Error archiving for ${user.email}:`, archiveError)
      }
      
      // 4. Generate new suggestions to fill target slots
      const slotsNeeded = targetSlots - activeCount
      
      if (slotsNeeded > 0) {
        console.log(`[Weekly Batch] ${user.email}: Generating ${slotsNeeded} new suggestions`)
        
        // Generate recommendations (it will create up to targetSlots total)
        await generateOnboardingRecommendations(user.id)
      }
      
      processedCount++
      
    } catch (err) {
      console.error(`[Weekly Batch] Error processing ${user.email}:`, err)
      errorCount++
    }
  }
  
  console.log(`[Weekly Batch] Complete. Processed: ${processedCount}, Errors: ${errorCount}`)
  
  return NextResponse.json({
    success: true,
    processed: processedCount,
    errors: errorCount,
    total: users.length
  })
}
