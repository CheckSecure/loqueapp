import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { approveIntroRequest } from '@/lib/introRequests'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== 'bizdev91@gmail.com') {
    return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
  }

  const { requestId } = await req.json()
  const result = await approveIntroRequest(requestId)
  if (result.error) return NextResponse.json({ error: result.error }, { status: 500 })
  return NextResponse.json({ success: true })
}
