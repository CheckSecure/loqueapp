import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { sendInviteEmail } from '@/lib/email'

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user || user.email !== 'bizdev91@gmail.com') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { entryId } = await req.json()

  const { data: entry } = await supabase
    .from('waitlist')
    .select('*')
    .eq('id', entryId)
    .single()

  if (!entry) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  }

  const tempPassword = Math.random().toString(36).slice(-12)
  
  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  
  const { error: authError } = await adminClient.auth.admin.createUser({
    email: entry.email,
    password: tempPassword,
    email_confirm: true,
  })

  if (authError) {
    return NextResponse.json({ error: authError.message }, { status: 500 })
  }

  console.log('[send-invite] Sending email to:', entry.email)
  await sendInviteEmail(entry.email, entry.full_name || 'there', tempPassword)
  console.log('[send-invite] Email sent successfully')

  await supabase
    .from('waitlist')
    .update({ status: 'invited', invited_at: new Date().toISOString() })
    .eq('id', entryId)

  return NextResponse.json({ success: true })
}
