import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function GET() {
  const adminClient = createAdminClient()
  
  try {
    // Mark expired pending requests as 'expired'
    const { data: expiredRequests, error } = await adminClient
      .from('targeted_requests')
      .update({ status: 'expired' })
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString())
      .select('id, user_id, role, created_at, expires_at')
    
    if (error) {
      console.error('[Cleanup] Error marking requests as expired:', error)
      return NextResponse.json({ 
        error: error.message 
      }, { status: 500 })
    }
    
    const expiredCount = expiredRequests?.length || 0
    
    console.log('[Cleanup] Expired requests processed:', {
      count: expiredCount,
      timestamp: new Date().toISOString()
    })
    
    if (expiredCount > 0) {
      console.log('[Cleanup] Expired request details:', expiredRequests)
    }
    
    return NextResponse.json({ 
      success: true, 
      expired_count: expiredCount,
      timestamp: new Date().toISOString()
    })
    
  } catch (error: any) {
    console.error('[Cleanup] Unexpected error:', error)
    return NextResponse.json({ 
      error: error.message 
    }, { status: 500 })
  }
}
