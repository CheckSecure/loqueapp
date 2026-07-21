import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCompanyMetadata, upsertCompanyMetadata } from '@/lib/company/metadata'

export const runtime = 'nodejs'
const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * Admin-editable company_metadata FALLBACK store (used by enrichment only when
 * neither an existing value nor a fresh scrape produces one). GET ?slug= reads;
 * POST { slug, description, industry, headquarters, logo_url } upserts.
 */
export async function GET(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const slug = (new URL(req.url).searchParams.get('slug') || '').toLowerCase().trim()
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 })
  const data = await getCompanyMetadata(createAdminClient(), slug)
  return NextResponse.json({ slug, metadata: data })
}

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: any = {}
  try { body = await req.json() } catch { /* empty */ }
  const slug = String(body?.slug || '').toLowerCase().trim()
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 })

  const fields: Record<string, string> = {}
  for (const k of ['description', 'industry', 'headquarters', 'logo_url']) {
    if (k in body) fields[k] = String(body[k] ?? '')
  }
  const res = await upsertCompanyMetadata(createAdminClient(), slug, fields, user.email || undefined)
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 200 })
  return NextResponse.json({ ok: true, slug })
}
