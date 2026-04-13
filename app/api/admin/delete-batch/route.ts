import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== 'bizdev91@gmail.com') {
    return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
  }

  const { batchId } = await req.json()
  const adminClient = createAdminClient()
  await adminClient.from('batch_suggestions').delete().eq('batch_id', batchId)
  await adminClient.from('introduction_batches').delete().eq('id', batchId)

  return NextResponse.json({ success: true })
}
