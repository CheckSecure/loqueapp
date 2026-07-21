import { COMPANY_REGISTRY } from '@/lib/company/registry'
import { companySlug, resolveLegacySlug } from '@/lib/company/slug'

/**
 * Deterministic planner for the one-time company-registry repair.
 *
 * PURE: given the current `companies` rows, it returns the exact set of actions
 * needed to bring the DB in line with the canonical registry — with NO side
 * effects, so it can drive both a dry-run preview and the apply pass, and can be
 * asserted idempotent (re-planning a repaired DB yields no enrich/retire actions).
 *
 * Guarantees encoded here:
 *  - admin_edited rows are never enriched or deleted (surfaced as preserve/review);
 *  - a canonical row is (re)enriched only when it's missing, has the wrong
 *    website, isn't a populated status, or lacks a description — so a repaired DB
 *    is a fixed point;
 *  - orphaned legacy/duplicate rows are retired only after their canonical row is
 *    accounted for, and never when admin_edited (routed to review instead).
 */

export type CompanyRow = {
  slug: string
  name?: string | null
  website?: string | null
  description?: string | null
  admin_edited?: boolean | null
  enrichment_status?: string | null
}

export type RepairAction =
  | { type: 'enrich'; slug: string; name: string; domain: string; reason: string }
  | { type: 'retire-orphan'; slug: string; canonicalSlug: string; reason: string }
  | { type: 'preserve-admin'; slug: string; reason: string }
  | { type: 'review'; slug: string; canonicalSlug: string; reason: string }

const has = (v: unknown): boolean => (typeof v === 'string' ? v.trim().length > 0 : v != null)

function hostOf(url?: string | null): string | null {
  if (!url) return null
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() } catch { return null }
}

export function planRegistryRepair(rows: CompanyRow[]): RepairAction[] {
  const bySlug = new Map(rows.map((r) => [r.slug, r]))
  const actions: RepairAction[] = []
  const canonicalSlugs = new Set<string>()

  // 1) Canonical rows: create/enrich/fix as needed (preserve admin edits).
  for (const c of COMPANY_REGISTRY) {
    const canonicalSlug = companySlug(c.name)
    canonicalSlugs.add(canonicalSlug)
    const row = bySlug.get(canonicalSlug)

    if (row?.admin_edited) {
      actions.push({ type: 'preserve-admin', slug: canonicalSlug, reason: 'admin_edited — left untouched' })
      continue
    }
    const wrongWebsite = !!row && has(row.website) && hostOf(row.website) !== c.domain
    // `partial` (identity resolved, homepage blocked) is a valid populated state
    // with no description — so a missing description is NOT a reason to re-enrich.
    const badStatus = !row || !['enriched', 'partial'].includes(row.enrichment_status || '')
    const needsEnrich = !row || !has(row.website) || wrongWebsite || badStatus
    if (needsEnrich) {
      const reason = !row ? 'create + enrich'
        : wrongWebsite ? `fix wrong website (${hostOf(row.website)} → ${c.domain})`
        : `re-enrich (status=${row.enrichment_status || 'null'})`
      actions.push({ type: 'enrich', slug: canonicalSlug, name: c.name, domain: c.domain, reason })
    }
  }

  // 2) Orphaned legacy/duplicate rows → retire toward their canonical slug.
  for (const row of rows) {
    if (canonicalSlugs.has(row.slug)) continue
    const target = resolveLegacySlug(row.slug) || (has(row.name) ? companySlug(row.name) : null)
    if (!target || target === row.slug || !canonicalSlugs.has(target)) continue
    if (row.admin_edited) {
      actions.push({ type: 'review', slug: row.slug, canonicalSlug: target, reason: 'admin_edited orphan — manual review before removal' })
    } else {
      actions.push({ type: 'retire-orphan', slug: row.slug, canonicalSlug: target, reason: 'legacy/duplicate row folds into canonical' })
    }
  }

  return actions
}
