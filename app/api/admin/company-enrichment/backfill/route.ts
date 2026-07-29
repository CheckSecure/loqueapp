import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { computeNetworkCompanies } from '@/lib/company/enrich'
import { enrichCompany } from '@/lib/company/enrichCompany'

export const runtime = 'nodejs'
export const maxDuration = 300

const ADMIN_EMAIL = 'bizdev91@gmail.com'
const BATCH_SIZE = 25

const has = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0

/**
 * Admin-only backfill: enrich member companies that are missing a logo OR a
 * description. Walks the STABLE, member-derived company list (computeNetworkCompanies,
 * deterministically sorted) by `offset`, so it is RESUMABLE — the caller repeats
 * with the returned `nextOffset` until `done`. IDEMPOTENT: already-complete
 * companies (logo AND description, or admin_edited) are skipped, and enrichCompany /
 * runEnrichment's atomic claim never re-does work. A failed lookup for one company
 * never affects the others or any profile.
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const offset = Math.max(0, parseInt(String(body?.offset ?? 0), 10) || 0)
  const limit = Math.min(BATCH_SIZE, Math.max(1, parseInt(String(body?.limit ?? BATCH_SIZE), 10) || BATCH_SIZE))

  const admin = createAdminClient()

  // Company universe derived from members (deduped by canonical slug, stable order).
  const { data: profs, error: profErr } = await admin.from('profiles').select('company').not('company', 'is', null)
  if (profErr) {
    return NextResponse.json({ ok: false, error: 'Could not read profiles.' }, { status: 500 })
  }
  const network = computeNetworkCompanies(profs)

  // Current enrichment state → "missing logo OR description", and skip complete.
  const existing = await admin.from('companies').select('slug, logo_url, description, admin_edited')
  if (existing.error && /PGRST205|schema cache|does not exist/i.test(`${existing.error.message} ${existing.error.code}`)) {
    return NextResponse.json({ ok: false, reason: 'companies_table_absent' }, { status: 200 })
  }
  const bySlug = new Map((existing.data || []).map((r: any) => [r.slug, r]))
  const isComplete = (r: any): boolean => !!r && (r.admin_edited === true || (has(r.logo_url) && has(r.description)))

  const totalMissing = network.filter((c) => !isComplete(bySlug.get(c.slug))).length

  // Process one stable window. Complete rows inside the window are skipped (kept
  // in the walk so offsets stay stable across re-runs).
  const windowRows = network.slice(offset, offset + limit)
  let attempted = 0, succeeded = 0, failed = 0, skipped = 0
  const results: Array<Record<string, unknown>> = []

  for (const c of windowRows) {
    if (isComplete(bySlug.get(c.slug))) { skipped++; continue }
    attempted++
    try {
      const r = await enrichCompany(admin, c.name)
      if (r.status === 'enriched' || r.status === 'partial' || r.status === 'existing') {
        succeeded++
      } else if (r.status === 'skipped') {
        skipped++
      } else {
        failed++
      }
      results.push({ slug: c.slug, name: c.name, status: r.status, logo: !!r.logo_url, description: !!r.description })
    } catch (e: any) {
      failed++
      results.push({ slug: c.slug, name: c.name, status: 'error', reason: (e?.message || 'error').slice(0, 200) })
    }
  }

  const nextOffset = offset + windowRows.length
  const done = nextOffset >= network.length

  console.log(JSON.stringify({
    event: 'company_backfill', admin_id: user.id, offset, window: windowRows.length,
    attempted, succeeded, failed, skipped, totalMissing, done,
  }))

  return NextResponse.json({
    ok: true,
    totalCompanies: network.length,
    totalMissing,
    offset,
    processed: nextOffset,
    attempted,
    succeeded,
    failed,
    skipped,
    done,
    nextOffset: done ? null : nextOffset,
    results,
  })
}
