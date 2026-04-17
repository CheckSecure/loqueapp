import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateOnboardingRecommendations } from '@/lib/generate-recommendations'

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  
  try {
    // Archive old suggestions
    await supabase
      .from('intro_requests')
      .update({ status: 'archived' })
      .eq('requester_id', user.id)
      .eq('status', 'suggested')
    
    // Generate fresh recommendations
    const result = await generateOnboardingRecommendations(user.id)
    
    return NextResponse.json({ 
      success: true, 
      count: result.count,
      message: 'Fresh recommendations generated'
    })
  } catch (error) {
    console.error('[refresh-recommendations] Error:', error)
    return NextResponse.json({ error: 'Failed to refresh' }, { status: 500 })
  }
}
