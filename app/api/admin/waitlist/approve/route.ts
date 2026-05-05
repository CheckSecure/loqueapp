import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { entryId } = await request.json()

  const { error } = await supabase
    .from('waitlist')
    .update({ status: 'approved' })
    .eq('id', entryId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  revalidatePath('/dashboard', 'layout')
  return NextResponse.json({ success: true })
}
