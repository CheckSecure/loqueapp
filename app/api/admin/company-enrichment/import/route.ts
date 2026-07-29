import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parseImportCsv, computeImportPlan, type ExistingCompany, type ImportPlanItem } from '@/lib/company/csvImport'
import { downloadAndStoreLogo } from '@/lib/company/enrichment/logo'
import { computeNetworkCompanies, ensureCompanyRecord } from '@/lib/company/enrich'

export const runtime = 'nodejs'
export const maxDuration = 300

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * Admin-only CSV company-enrichment import — a controlled, one-time cleanup that
 * fills MISSING logos/descriptions on existing `companies` rows from a manually
 * prepared CSV. It does NOT touch the automatic enrichment pipeline, profiles, or
 * member records.
 *
 * Two-step: POST { csv }            → preview (dry run) — the fill-missing-only plan.
 *           POST { csv, apply:true } → apply the plan and return an audit result set.
 *
 * Rules (see computeImportPlan): match by canonical slug; skip admin_edited rows;
 * never overwrite a non-empty logo_url/description; fill only the missing field(s).
 * Logos go through the existing downloadAndStoreLogo (validate → download → store our
 * own copy → reject broken/placeholder/tiny/non-image). admin_edited is left false —
 * this is enrichment cleanup, not a manual override, so future enrichment can still
 * add HQ/industry/etc. Idempotent: applying recomputes from a fresh snapshot and each
 * write is guarded to only fill a still-null field, so re-uploading the same CSV is a
 * no-op. Audit trail = the returned results (exportable to CSV) + a structured log line.
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const csv = typeof body?.csv === 'string' ? body.csv : ''
  const apply = body?.apply === true
  if (!csv.trim()) return NextResponse.json({ error: 'Provide CSV text in `csv`.' }, { status: 400 })

  const { rows, errors: parseErrors } = parseImportCsv(csv)

  const admin = createAdminClient()
  const existing = await admin.from('companies').select('slug, name, logo_url, description, admin_edited')
  if (existing.error && /PGRST205|schema cache|does not exist/i.test(`${existing.error.message} ${existing.error.code}`)) {
    return NextResponse.json({ ok: false, reason: 'companies_table_absent' }, { status: 200 })
  }
  if (existing.error) {
    return NextResponse.json({ ok: false, error: 'Could not read companies.' }, { status: 500 })
  }
  const bySlug = new Map<string, ExistingCompany>((existing.data || []).map((r: any) => [r.slug, r]))
  // Slugs that already have a real companies row — used on apply to decide which
  // matched companies still need their row materialized via ensureCompanyRecord().
  const realSlugs = new Set(bySlug.keys())

  // Match against the SAME company universe the Admin Companies page uses: the
  // member-derived network list. A network company without a companies row yet
  // gets a synthetic empty entry so the plan treats it as fillable (update) rather
  // than not_found. We never invent companies from CSV names — only from real
  // members — so a CSV row matching neither a real row nor a network company stays
  // not_found.
  const { data: profs } = await admin.from('profiles').select('company').not('company', 'is', null)
  for (const c of computeNetworkCompanies(profs)) {
    if (!bySlug.has(c.slug)) {
      bySlug.set(c.slug, { slug: c.slug, name: c.name, logo_url: null, description: null, admin_edited: false })
    }
  }

  const plan = computeImportPlan(rows, bySlug)

  const summary = {
    csvRows: rows.length,
    parseErrors: parseErrors.length,
    toUpdate: plan.filter((p) => p.action === 'update').length,
    toSkip: plan.filter((p) => p.action === 'skip').length,
    notFound: plan.filter((p) => p.action === 'not_found').length,
  }

  // ---- Preview (dry run) -----------------------------------------------------
  if (!apply) {
    const preview = plan.map((p) => ({
      company_name: p.input.company_name,
      slug: p.slug,
      matched_company: p.matchedName,
      action: p.action,
      reason: p.reason ?? null,
      current_logo_url: p.fields.logo_url?.current ?? null,
      new_logo_url: p.fields.logo_url?.candidate ?? null,
      current_description: p.fields.description?.current ?? null,
      new_description: p.fields.description?.next ?? null,
    }))
    return NextResponse.json({ ok: true, applied: false, summary, preview, parseErrors })
  }

  // ---- Apply -----------------------------------------------------------------
  const now = new Date().toISOString()
  // One audit row per (company, field) changed, plus one row per skipped/not-found
  // company — matching the export columns company_name / fields_updated /
  // previous_value / new_value / skipped_reason.
  const results: Array<{
    company_name: string
    matched_company: string | null
    fields_updated: string
    previous_value: string | null
    new_value: string | null
    skipped_reason: string | null
  }> = []
  let updatedFields = 0
  let updatedCompanies = 0
  let logoRejected = 0

  for (const item of plan) {
    if (item.action !== 'update') {
      results.push({
        company_name: item.input.company_name,
        matched_company: item.matchedName,
        fields_updated: '',
        previous_value: null,
        new_value: null,
        skipped_reason: item.action === 'not_found' ? 'not_found' : (item.reason ?? 'skipped'),
      })
      continue
    }

    const changed: string[] = []

    // Materialize a companies row for a matched NETWORK company that has none yet
    // (idempotent upsert; ignoreDuplicates → never overwrites an existing row).
    // Real rows are left untouched; the null-guarded updates below still apply.
    if (!realSlugs.has(item.slug)) {
      await ensureCompanyRecord(admin, item.slug, item.matchedName || item.input.company_name)
    }

    // Logo: validate + download + store our own copy via the existing pipeline util.
    if (item.fields.logo_url) {
      let stored: string | null = null
      try {
        stored = await downloadAndStoreLogo(admin, item.slug, [item.fields.logo_url.candidate])
      } catch { stored = null }
      if (stored) {
        const { data: rows2 } = await admin
          .from('companies')
          .update({ logo_url: stored, enrichment_source: 'admin:csv_import', updated_at: now })
          .eq('slug', item.slug)
          .eq('admin_edited', false)
          .is('logo_url', null) // guard: only fill a still-missing logo (race + idempotency safe)
          .select('slug')
        if (rows2 && rows2.length) {
          changed.push('logo_url')
          updatedFields++
          results.push({ company_name: item.input.company_name, matched_company: item.matchedName, fields_updated: 'logo_url', previous_value: null, new_value: stored, skipped_reason: null })
        } else {
          results.push({ company_name: item.input.company_name, matched_company: item.matchedName, fields_updated: '', previous_value: null, new_value: null, skipped_reason: 'logo_url already present (skipped)' })
        }
      } else {
        logoRejected++
        results.push({ company_name: item.input.company_name, matched_company: item.matchedName, fields_updated: '', previous_value: null, new_value: item.fields.logo_url.candidate, skipped_reason: 'logo rejected (invalid, broken, placeholder, or too small)' })
      }
    }

    // Description: fill only if still null.
    if (item.fields.description) {
      const next = item.fields.description.next
      const { data: rows2 } = await admin
        .from('companies')
        .update({ description: next, enrichment_source: 'admin:csv_import', updated_at: now })
        .eq('slug', item.slug)
        .eq('admin_edited', false)
        .is('description', null) // guard: only fill a still-missing description
        .select('slug')
      if (rows2 && rows2.length) {
        changed.push('description')
        updatedFields++
        results.push({ company_name: item.input.company_name, matched_company: item.matchedName, fields_updated: 'description', previous_value: null, new_value: next, skipped_reason: null })
      } else {
        results.push({ company_name: item.input.company_name, matched_company: item.matchedName, fields_updated: '', previous_value: null, new_value: null, skipped_reason: 'description already present (skipped)' })
      }
    }

    if (changed.length) {
      updatedCompanies++
      console.log(JSON.stringify({ event: 'company_csv_import', admin_id: user.id, slug: item.slug, company: item.matchedName, fields_changed: changed, at: now }))
    }
  }

  return NextResponse.json({
    ok: true,
    applied: true,
    summary: { ...summary, updatedCompanies, updatedFields, logoRejected },
    results,
    parseErrors,
  })
}
