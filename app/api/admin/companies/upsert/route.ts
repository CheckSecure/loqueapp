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
  // Guard against a malformed slug (a contaminated company_name that leaked through):
  // a valid canonical slug never contains "http" and is never this long. Reject rather
  // than silently rewrite, so the caller fixes the source instead of persisting junk.
  if (slug.includes('http') || slug.length > 80) {
    return NextResponse.json(
      { error: 'Invalid slug: a company slug cannot contain "http" or exceed 80 characters. This usually means the company name was not comma-delimited in the CSV.' },
      { status: 400 },
    )
  }

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
    // A human curated this row → automatic enrichment must never overwrite it.
    admin_edited: true,
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
