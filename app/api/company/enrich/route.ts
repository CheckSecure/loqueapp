import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { computeNetworkCompanies } from '@/lib/company/enrich'
import { runEnrichment } from '@/lib/company/enrichment/run'

export const runtime = 'nodejs'
export const maxDuration = 60

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * Background enrichment trigger. Called (fire-and-forget) by the company page
 * once it has rendered, so enrichment runs OUT of the render path — the page is
 * never blocked on network scraping or logo downloads.
 *
 * Auth: any signed-in member may trigger enrichment for a real company (the data
 * is derived from the shared member graph). `refresh: true` forces a re-run of an
 * already-enriched row and is admin-only. The company NAME is resolved
 * server-side (existing row, else the member graph) — never trusted from the
 * client — so this can't mint arbitrary company rows.
 */
export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: any = {}
  try { body = await req.json() } catch { /* empty body ok */ }
  const slug = String(body?.slug || '').toLowerCase().trim()
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 })
  const refresh = body?.refresh === true
  if (refresh && user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'refresh is admin-only' }, { status: 403 })
  }

  const admin = createAdminClient()

  // Resolve the company name server-side. Prefer an existing row; otherwise
  // derive it from the member graph. Never trust a client-supplied name.
  const existing = await admin.from('companies').select('name, admin_edited, enrichment_status').eq('slug', slug).maybeSingle()
  if (existing.error && !/PGRST205|schema cache|does not exist/i.test(`${existing.error.message} ${existing.error.code}`)) {
    return NextResponse.json({ status: 'error' }, { status: 200 })
  }
  let name = existing.data?.name || ''
  if (!name) {
    const { data: profs } = await admin.from('profiles').select('company').not('company', 'is', null)
    name = computeNetworkCompanies(profs).find((c) => c.slug === slug)?.name || ''
  }
  if (!name) return NextResponse.json({ status: 'skipped', reason: 'unknown_company' }, { status: 200 })

  const result = await runEnrichment(admin, slug, name, { force: refresh })
  return NextResponse.json({
    status: result.status,
    website: result.website ?? null,
    logoStored: result.logoStored ?? false,
    stages: result.stages ?? null,
  })
}
