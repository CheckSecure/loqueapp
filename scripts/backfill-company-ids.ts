/**
 * Backfill profiles.company_id from free-text profiles.company (Phase 2).
 *
 * Operator-run, ONE-TIME (re-runnable). Requires migrations 030–032 applied.
 * Reads the existing resolver (lib/company/*) READ-ONLY — it does not change
 * resolver behavior, onboarding, admin UI, read paths, or the enrichment pipeline.
 *
 * What it does, in confidence order (same A→B→C ladder as the CSV importer):
 *   - Resolves each distinct non-placeholder profiles.company to a LIVE company:
 *       exact / canonical / fuzzy(unique)  → link profile.company_id to it.
 *   - No existing company row + non-ambiguous name → CREATE a company with
 *       company_status='pending_review' (awaits admin blessing) and link to it.
 *   - Ambiguous name (isAmbiguousCompanyName) or fuzzy-multi → leave company_id
 *       NULL, mark profile.company_resolution='pending_review' for the admin queue.
 *   - Placeholder company text (isPlaceholderCompany) → skipped entirely.
 *   - Seeds company_aliases from the compiled registry (source='registry') and
 *       from each resolved profile text (source='backfill'), respecting the
 *       global UNIQUE(alias_normalized). A normalized key already mapped to a
 *       DIFFERENT company is a real conflict → reported, never overwritten.
 *
 * SAFE BY DEFAULT: dry-run unless --execute is passed. profiles.company (raw
 * user input) is never modified. Only profiles with a NULL company_id are
 * touched, unless --force is given.
 *
 * Usage:
 *   tsx scripts/backfill-company-ids.ts               # dry-run (writes nothing)
 *   tsx scripts/backfill-company-ids.ts --execute     # apply
 *   tsx scripts/backfill-company-ids.ts --execute --force   # re-resolve non-null too
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (loaded from .env.local).
 */
import { config } from 'dotenv'
import { createAdminClient } from '../lib/supabase/admin'
import {
  buildCompanyResolver,
  resolveCompany,
  type ResolvableCompany,
} from '../lib/company/companyResolver'
import {
  companySlug,
  normalizeCompanyName,
  resolveCanonicalCompany,
  isAmbiguousCompanyName,
} from '../lib/company/slug'
import { isPlaceholderCompany } from '../lib/professionalIdentity'
import { COMPANY_REGISTRY } from '../lib/company/registry'

config({ path: '.env.local' })

const EXECUTE = process.argv.includes('--execute')
const FORCE = process.argv.includes('--force')
const PAGE = 1000
const log = (m: string) => process.stdout.write(`${m}\n`)

type Resolution = 'exact' | 'canonical' | 'fuzzy' | 'pending_review'

interface CompanyRow {
  id: string
  slug: string
  name: string | null
  company_status?: string | null
}

interface ProfileRow {
  id: string
  company: string | null
  company_id: string | null
  company_resolution: string | null
}

// Per-distinct-text plan produced in pass A, consumed in pass B.
interface TextPlan {
  companyId: string | null // null → pending_review with no entity
  resolution: Resolution
  createSlug?: string // set when this text needs a NEW company
  createName?: string
  aliasConfidence?: 'exact' | 'canonical' | 'fuzzy'
  aliasAmbiguous?: boolean
}

async function main(): Promise<number> {
  const admin = createAdminClient()
  log(`[backfill] mode: ${EXECUTE ? 'EXECUTE (writing)' : 'DRY-RUN (no writes)'}${FORCE ? ' --force' : ''}`)

  // ── Guard: required schema present (fail clearly if migrations not applied) ──
  const guardCompanies = await admin.from('companies').select('id, company_status').limit(1)
  const guardAliases = await admin.from('company_aliases').select('id').limit(1)
  const guardProfiles = await admin.from('profiles').select('id, company_id').limit(1)
  for (const [name, r] of [
    ['companies.company_status (030)', guardCompanies],
    ['company_aliases (031)', guardAliases],
    ['profiles.company_id (032)', guardProfiles],
  ] as const) {
    if (r.error) {
      log(`[backfill] ABORT — required schema missing: ${name} → ${r.error.message}`)
      log('[backfill] Apply migrations 030–032 in Supabase first.')
      return 1
    }
  }

  // ── Load LIVE companies (skip tombstones) → resolver candidates + slug→row ──
  const companies = await loadAll<CompanyRow>(admin, 'companies', 'id, slug, name, company_status', (q) =>
    q.is('merged_into_company_id', null),
  )
  const slugToCompany = new Map<string, CompanyRow>()
  for (const c of companies) if (c.slug && !slugToCompany.has(c.slug)) slugToCompany.set(c.slug, c)
  const candidates: ResolvableCompany[] = companies.map((c) => ({ slug: c.slug, name: c.name }))
  const resolver = buildCompanyResolver(candidates)
  log(`[backfill] loaded ${companies.length} live companies`)

  // ── Preload existing aliases (normalized → company_id) for conflict detection ──
  const aliasRows = await loadAll<{ alias_normalized: string; company_id: string }>(
    admin, 'company_aliases', 'alias_normalized, company_id',
  )
  const aliasMap = new Map<string, string>()
  for (const a of aliasRows) aliasMap.set(a.alias_normalized, a.company_id)

  // ── Load profiles ──
  const profiles = await loadAll<ProfileRow>(admin, 'profiles', 'id, company, company_id, company_resolution')
  log(`[backfill] loaded ${profiles.length} profiles`)

  // ── PASS A: classify each DISTINCT non-placeholder company text once ──
  const textPlans = new Map<string, TextPlan>()
  const createBySlug = new Map<string, { slug: string; name: string }>()

  for (const p of profiles) {
    const raw = (p.company || '').trim()
    if (!raw || isPlaceholderCompany(raw)) continue
    const key = normalizeCompanyName(raw)
    if (!key || textPlans.has(raw)) continue

    const hit = resolveCompany(raw, resolver)
    if (hit) {
      const company = slugToCompany.get(hit.slug)
      textPlans.set(raw, {
        companyId: company ? company.id : null,
        resolution: hit.confidence,
        aliasConfidence: hit.confidence,
        aliasAmbiguous: isAmbiguousCompanyName(raw),
      })
      continue
    }

    // No candidate matched. Ambiguous → human review; else create pending_review.
    if (isAmbiguousCompanyName(raw)) {
      textPlans.set(raw, { companyId: null, resolution: 'pending_review' })
      continue
    }
    const canonical = resolveCanonicalCompany(raw)
    const slug = companySlug(raw)
    if (!slug) {
      textPlans.set(raw, { companyId: null, resolution: 'pending_review' })
      continue
    }
    const name = canonical ? canonical.name : raw
    createBySlug.set(slug, { slug, name })
    textPlans.set(raw, {
      companyId: null, // filled after creation
      resolution: canonical ? 'canonical' : 'exact',
      createSlug: slug,
      createName: name,
      aliasConfidence: canonical ? 'canonical' : 'exact',
      aliasAmbiguous: false,
    })
  }

  // ── Create the new pending_review companies (adjustment #1: NOT 'active') ──
  const createdSlugToId = new Map<string, string>()
  for (const { slug, name } of createBySlug.values()) {
    if (slugToCompany.has(slug)) {
      createdSlugToId.set(slug, slugToCompany.get(slug)!.id)
      continue
    }
    if (!EXECUTE) {
      createdSlugToId.set(slug, `<dry-run:${slug}>`)
      continue
    }
    const ins = await admin
      .from('companies')
      .insert({ slug, name, company_status: 'pending_review' })
      .select('id')
      .single()
    if (ins.error || !ins.data) {
      // Slug raced/exists → re-read.
      const existing = await admin.from('companies').select('id').eq('slug', slug).single()
      if (existing.data) createdSlugToId.set(slug, existing.data.id)
      else log(`[backfill] WARN could not create company for slug "${slug}": ${ins.error?.message}`)
      continue
    }
    createdSlugToId.set(slug, ins.data.id)
  }

  // Resolve createSlug → id back onto the text plans.
  for (const plan of textPlans.values()) {
    if (plan.createSlug && !plan.companyId) plan.companyId = createdSlugToId.get(plan.createSlug) ?? null
  }

  // ── Seed aliases: registry first, then per-profile-text (backfill) ──
  const collisions: string[] = []
  let registrySeeded = 0
  let backfillSeeded = 0

  const seedAlias = async (
    aliasText: string,
    normalized: string,
    companyId: string | null,
    source: 'registry' | 'backfill',
    confidence: 'exact' | 'canonical' | 'fuzzy' | null,
    ambiguous: boolean,
  ): Promise<'seeded' | 'exists' | 'collision' | 'skip'> => {
    if (!normalized || !companyId || companyId.startsWith('<dry-run')) return 'skip'
    const existing = aliasMap.get(normalized)
    if (existing) return existing === companyId ? 'exists' : 'collision'
    aliasMap.set(normalized, companyId) // reserve in-memory so intra-run dups don't double-insert
    if (EXECUTE) {
      const ins = await admin.from('company_aliases').insert({
        company_id: companyId,
        alias_text: aliasText,
        alias_normalized: normalized,
        source,
        confidence,
        is_ambiguous: ambiguous,
      })
      if (ins.error) {
        // Unique race → treat as exists, not fatal.
        if (/duplicate|unique|23505/i.test(`${ins.error.message} ${ins.error.code}`)) return 'exists'
        log(`[backfill] WARN alias insert failed "${normalized}": ${ins.error.message}`)
        return 'skip'
      }
    }
    return 'seeded'
  }

  for (const rc of COMPANY_REGISTRY) {
    const slug = companySlug(rc.name)
    const company = slugToCompany.get(slug)
    if (!company) continue // registry canonical has no company row yet → seeded later if a member uses it
    const ambiguousSet = new Set((rc.ambiguousAliases ?? []).map((a) => normalizeCompanyName(a)))
    for (const variant of [rc.name, ...rc.aliases]) {
      const normalized = normalizeCompanyName(variant)
      const res = await seedAlias(variant, normalized, company.id, 'registry', 'canonical', ambiguousSet.has(normalized))
      if (res === 'seeded') registrySeeded++
      else if (res === 'collision') collisions.push(`registry "${variant}" (${normalized}) → wants ${company.id}, held by ${aliasMap.get(normalized)}`)
    }
  }

  for (const [raw, plan] of textPlans) {
    if (!plan.companyId) continue
    const normalized = normalizeCompanyName(raw)
    const res = await seedAlias(raw, normalized, plan.companyId, 'backfill', plan.aliasConfidence ?? null, !!plan.aliasAmbiguous)
    if (res === 'seeded') backfillSeeded++
    else if (res === 'collision') collisions.push(`profile-text "${raw}" (${normalized}) → wants ${plan.companyId}, held by ${aliasMap.get(normalized)}`)
  }

  // ── PASS B: assign company_id + resolution onto profiles ──
  const counts: Record<string, number> = { exact: 0, canonical: 0, fuzzy: 0, pending_review: 0, skipped: 0 }
  const nowIso = new Date().toISOString()
  let updated = 0

  for (const p of profiles) {
    const raw = (p.company || '').trim()
    if (!raw || isPlaceholderCompany(raw)) { counts.skipped++; continue }
    const plan = textPlans.get(raw)
    if (!plan) { counts.skipped++; continue }
    if (p.company_id && !FORCE) { counts.skipped++; continue } // already linked; leave unless --force

    counts[plan.resolution] = (counts[plan.resolution] ?? 0) + 1

    const patch: Record<string, unknown> = {
      company_id: plan.companyId,
      company_resolution: plan.resolution,
      company_resolved_at: plan.companyId ? nowIso : null,
    }
    if (EXECUTE) {
      const upd = await admin.from('profiles').update(patch).eq('id', p.id)
      if (upd.error) { log(`[backfill] WARN profile ${p.id} update failed: ${upd.error.message}`); continue }
    }
    updated++
  }

  // ── Report ──
  log('')
  log('[backfill] ── summary ──')
  log(`  companies created (pending_review): ${EXECUTE ? [...createdSlugToId.keys()].filter((s) => !slugToCompany.has(s)).length : createBySlug.size}`)
  log(`  aliases seeded — registry: ${registrySeeded}, backfill: ${backfillSeeded}`)
  log(`  profiles by resolution:`)
  for (const k of ['exact', 'canonical', 'fuzzy', 'pending_review', 'skipped']) log(`    ${k}: ${counts[k] ?? 0}`)
  log(`  profiles ${EXECUTE ? 'updated' : 'would update'}: ${updated}`)
  if (collisions.length) {
    log('')
    log(`[backfill] ALIAS COLLISIONS (need admin review — a normalized key maps to two companies): ${collisions.length}`)
    for (const c of collisions.slice(0, 50)) log(`    - ${c}`)
    if (collisions.length > 50) log(`    … and ${collisions.length - 50} more`)
  }
  if (!EXECUTE) log('\n[backfill] DRY-RUN complete — nothing written. Re-run with --execute to apply.')
  return 0
}

/** Load an entire table with pagination (Supabase caps a page at ~1000 rows). */
async function loadAll<T>(
  admin: ReturnType<typeof createAdminClient>,
  table: string,
  columns: string,
  filter?: (q: any) => any,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    let q = admin.from(table).select(columns).range(from, from + PAGE - 1)
    if (filter) q = filter(q)
    const r = await q
    if (r.error) throw new Error(`load ${table}: ${r.error.message}`)
    const rows = (r.data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[backfill] fatal:', err?.message || err)
    process.exit(1)
  })
