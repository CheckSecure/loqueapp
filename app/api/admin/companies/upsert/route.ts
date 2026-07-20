import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const slug = String(body.slug || '').toLowerCase().trim()
  if (!slug) return NextResponse.json({ error: 'Missing slug' }, { status: 400 })

  const clean = (v: unknown) => {
    const s = typeof v === 'string' ? v.trim() : ''
    return s.length ? s : null
  }

  const payload = {
    slug,
    name: clean(body.name) || slug,
    logo_url: clean(body.logo_url),
    website: clean(body.website),
    industry: clean(body.industry),
    headquarters: clean(body.headquarters),
    company_size: clean(body.company_size),
    description: clean(body.description),
    updated_at: new Date().toISOString(),
  }

  const admin = createAdminClient()
  const { error } = await admin.from('companies').upsert(payload, { onConflict: 'slug' })
  if (error) {
    const missing = /schema cache|does not exist|PGRST205|find the table/i.test(`${error.message} ${error.code}`)
    return NextResponse.json(
      { error: missing ? 'The companies table is not available yet — apply migration 014 in Supabase.' : error.message },
      { status: 500 },
    )
  }
  return NextResponse.json({ ok: true })
}
