import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) return NextResponse.json({ error: 'Not authenticated' })

  // Get ALL intro_requests for this user
  const { data: allRequests } = await supabase
    .from('intro_requests')
    .select('*')
    .eq('requester_id', user.id)
    .order('created_at', { ascending: false })

  return NextResponse.json({
    userId: user.id,
    userEmail: user.email,
    totalRequests: allRequests?.length || 0,
    requests: allRequests
  })
}
