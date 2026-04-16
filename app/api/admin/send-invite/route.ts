import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY!)

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
  
  const { error: authError } = await supabase.auth.admin.createUser({
    email: entry.email,
    password: tempPassword,
    email_confirm: true,
  })

  if (authError) {
    return NextResponse.json({ error: authError.message }, { status: 500 })
  }

  await resend.emails.send({
    from: 'Andrel <hello@andrel.app>',
    to: entry.email,
    subject: 'Welcome to Andrel',
    html: `<p>Your temporary password is: <strong>${tempPassword}</strong></p><p>Login at: https://andrel.app/login</p>`,
  })

  await supabase
    .from('waitlist')
    .update({ status: 'invited', invited_at: new Date().toISOString() })
    .eq('id', entryId)

  return NextResponse.json({ success: true })
}
