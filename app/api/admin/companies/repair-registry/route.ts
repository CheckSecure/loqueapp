import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { planRegistryRepair, type CompanyRow } from '@/lib/company/migration'
import { runEnrichment } from '@/lib/company/enrichment/run'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'
const CONFIRM_TOKEN = 'APPLY_COMPANY_REGISTRY_REPAIR'
const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' }

const json = (body: any, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

async function requireAdmin() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user && user.email === ADMIN_EMAIL ? user : null
}

/** CSRF: the request Origin host must match the app's own host. */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return false
  let originHost: string
  try { originHost = new URL(origin).host } catch { return false }
  const allowed = new Set<string>()
  const site = process.env.NEXT_PUBLIC_SITE_URL
  if (site) { try { allowed.add(new URL(site).host) } catch { /* */ } }
  const fwd = req.headers.get('x-forwarded-host'); if (fwd) allowed.add(fwd)
  const host = req.headers.get('host'); if (host) allowed.add(host)
  return allowed.has(originHost)
}

async function loadRows(admin: any): Promise<{ rows: CompanyRow[]; error?: string }> {
  const { data, error } = await admin
    .from('companies')
    .select('slug, name, website, description, admin_edited, enrichment_status')
  if (error) return { rows: [], error: error.message }
  return { rows: (data || []) as CompanyRow[] }
}

/**
 * DRY-RUN ONLY. Returns the deterministic repair plan + a rollback snapshot of
 * every row the plan would touch. There is NO mutation path on GET — no query
 * parameter applies anything. Use POST (with confirmation) to apply.
 */
export async function GET() {
  if (!(await requireAdmin())) return json({ error: 'Unauthorized' }, 401)
  const admin = createAdminClient()
  const { rows, error } = await loadRows(admin)
  if (error) return json({ error: 'could_not_read_companies', detail: error }, 200)

  const plan = planRegistryRepair(rows)
  const affected = new Set<string>()
  for (const a of plan) { affected.add(a.slug); if ('canonicalSlug' in a) affected.add(a.canonicalSlug) }
  const rollbackSnapshot = rows.filter((r) => affected.has(r.slug))

  return json({
    mode: 'dry-run',
    hint: 'To apply: POST this route with { "confirm": "APPLY_COMPANY_REGISTRY_REPAIR" } from the app origin.',
    totalCompanyRows: rows.length,
    counts: plan.reduce((m: Record<string, number>, a) => ({ ...m, [a.type]: (m[a.type] || 0) + 1 }), {}),
    plan,
    rollbackSnapshot,
  })
}

/**
 * APPLY. Requires an exact confirmation token in the JSON body and a same-origin
 * request. The plan is recomputed server-side from the registry — NO client-
 * supplied slugs, IDs, SQL, or actions are accepted. admin_edited rows are never
 * enriched or deleted. Idempotent: re-running after success is a no-op.
 */
export async function POST(req: Request) {
  if (!(await requireAdmin())) return json({ error: 'Unauthorized' }, 401)
  if (!originAllowed(req)) return json({ error: 'origin_not_allowed' }, 403)

  let body: any = {}
  try { body = await req.json() } catch { /* */ }
  if (body?.confirm !== CONFIRM_TOKEN) {
    return json({ error: 'confirmation_required', expected: CONFIRM_TOKEN }, 400)
  }

  const admin = createAdminClient()
  const { rows, error } = await loadRows(admin)
  if (error) return json({ error: 'could_not_read_companies', detail: error }, 200)

  // Recompute the plan server-side; snapshot before-state (rollback record).
  const plan = planRegistryRepair(rows)
  const affected = new Set<string>()
  for (const a of plan) { affected.add(a.slug); if ('canonicalSlug' in a) affected.add(a.canonicalSlug) }
  const rollbackSnapshot = rows.filter((r) => affected.has(r.slug))
  const rollbackSnapshotId = `company-registry-repair:${new Date().toISOString()}`

  const summary = { planned: plan.length, created: 0, enriched: 0, retired: 0, skippedAdminEdited: 0, failed: 0 }
  const results: any[] = []
  const existing = new Set(rows.map((r) => r.slug))

  for (const a of plan) {
    if (a.type === 'enrich') {
      const isNew = !existing.has(a.slug)
      const r = await runEnrichment(admin, a.slug, a.name, { force: true })
      if (r.status === 'enriched' || r.status === 'partial') { summary.enriched++; if (isNew) summary.created++ }
      else if (r.status === 'skipped') { summary.skippedAdminEdited++ }
      else { summary.failed++ }
      results.push({ action: 'enrich', slug: a.slug, status: r.status, stages: r.stages ?? null })
    } else if (a.type === 'retire-orphan') {
      const del = await admin.from('companies').delete().eq('slug', a.slug).eq('admin_edited', false)
      if (del.error) { summary.failed++; results.push({ action: 'retire-orphan', slug: a.slug, error: del.error.message }) }
      else { summary.retired++; results.push({ action: 'retire-orphan', slug: a.slug, into: a.canonicalSlug }) }
    } else {
      summary.skippedAdminEdited++
      results.push({ action: a.type, slug: a.slug, reason: a.reason })
    }
  }

  return json({ mode: 'apply', summary, results, rollbackSnapshotId, rollbackSnapshot })
}
