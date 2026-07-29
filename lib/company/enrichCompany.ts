import { companySlug, isLinkableCompany } from '@/lib/company/slug'
import { runEnrichment } from '@/lib/company/enrichment/run'

/**
 * Reusable, server-side company enrichment.
 *
 * enrichCompany(name, domain?) is a thin, structured-result wrapper over the
 * existing self-hosted pipeline (lib/company/enrichment/run.ts). It:
 *   1. normalizes the name → canonical slug (collapses "Verizon" / "Verizon
 *      Communications" / registry aliases to one company),
 *   2. checks whether the company is ALREADY complete (logo AND description) and
 *      returns it untouched unless `force` — never overwriting valid data,
 *   3. otherwise runs enrichment (passing an optional caller-provided domain so a
 *      company that isn't in the registry and isn't discoverable without a search
 *      key can still be resolved + get a logo),
 *   4. returns the persisted result in a stable shape.
 *
 * Descriptions come only from verified public sources (the homepage's own meta /
 * the admin curated fallback) — the pipeline never fabricates one. Logos are our
 * stored copy of a real image from the verified domain, or null.
 */
export interface EnrichCompanyResult {
  company_name: string
  logo_url: string | null
  description: string | null
  website_url: string | null
  confidence: 'high' | 'medium' | 'low' | 'none'
  source: string | null
  slug: string
  status: 'existing' | 'enriched' | 'partial' | 'not_found' | 'failed' | 'skipped' | 'error' | 'invalid'
}

const has = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0

function confidenceFor(status: string, source: string | null): EnrichCompanyResult['confidence'] {
  if (status === 'enriched' || status === 'existing') return 'high'
  if (status === 'partial') return (source || '').startsWith('registry') ? 'high' : 'medium'
  if (status === 'not_found') return 'low'
  return 'none'
}

const SELECT = 'name, logo_url, description, website, enrichment_status, enrichment_source'

export async function enrichCompany(
  admin: any,
  companyName: string,
  companyDomain?: string | null,
  opts: { force?: boolean } = {},
): Promise<EnrichCompanyResult> {
  const name = (companyName || '').trim()
  const slug = companySlug(name)

  // Not a real, linkable company (blank / placeholder like "Independent",
  // "Confidential", "Stealth"). Never enrich — it isn't a company.
  if (!slug || !isLinkableCompany(name)) {
    return { company_name: name, logo_url: null, description: null, website_url: null, confidence: 'none', source: null, slug, status: 'invalid' }
  }

  // Never overwrite existing VALID data unless explicitly forced: a row with BOTH
  // a logo and a description is complete.
  const existing = (await admin.from('companies').select(SELECT).eq('slug', slug).maybeSingle()).data || null
  if (!opts.force && existing && has(existing.logo_url) && has(existing.description)) {
    return {
      company_name: existing.name || name,
      logo_url: existing.logo_url,
      description: existing.description,
      website_url: existing.website ?? null,
      confidence: confidenceFor('existing', existing.enrichment_source ?? null),
      source: existing.enrichment_source ?? 'existing',
      slug,
      status: 'existing',
    }
  }

  const website = companyDomain?.trim() || undefined
  const result = await runEnrichment(admin, slug, name, { force: opts.force, website })

  // Read back the persisted row for the structured result.
  const row = (await admin.from('companies').select(SELECT).eq('slug', slug).maybeSingle()).data || {}
  return {
    company_name: row.name || name,
    logo_url: row.logo_url ?? null,
    description: row.description ?? null,
    website_url: row.website ?? null,
    confidence: confidenceFor(result.status, row.enrichment_source ?? null),
    source: row.enrichment_source ?? null,
    slug,
    status: result.status,
  }
}
