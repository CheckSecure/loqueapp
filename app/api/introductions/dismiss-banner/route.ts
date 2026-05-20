import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { batchId } = await req.json()
  if (typeof batchId !== 'string' || !batchId) {
    return NextResponse.json({ error: 'Missing batchId' }, { status: 400 })
  }

  const { error } = await supabase
    .from('introduction_banner_dismissals')
    .upsert({ user_id: user.id, batch_id: batchId })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
