/**
 * Build the company-editor form from a CSV import preview row so an admin can edit
 * (and save/create) a company straight from the preview — even one that isn't
 * materialized in the companies table yet.
 *
 * Precedence is fill-missing: an EXISTING materialized value always wins; the CSV
 * value only fills a gap. Industry/HQ/size come from the existing record when
 * available (the CSV format doesn't carry them). Pure + testable.
 */

export interface PreviewRow {
  company_name: string
  slug: string
  matched_company?: string | null
  action: 'update' | 'skip' | 'not_found'
  csv_website?: string | null
  csv_logo_url?: string | null
  csv_description?: string | null
}

export interface ExistingCompanyLike {
  slug: string
  name?: string | null
  meta?: {
    name?: string | null
    logo_url?: string | null
    website?: string | null
    industry?: string | null
    headquarters?: string | null
    company_size?: string | null
    description?: string | null
  } | null
}

const pick = (...vals: (string | null | undefined)[]): string => {
  for (const v of vals) if (typeof v === 'string' && v.trim().length) return v
  return ''
}

export function buildEditorFormFromPreview(
  p: PreviewRow,
  existing: ExistingCompanyLike | null | undefined,
): Record<string, string> {
  const meta = existing?.meta ?? null
  return {
    name: pick(meta?.name, existing?.name, p.matched_company, p.company_name),
    logo_url: pick(meta?.logo_url, p.csv_logo_url),
    website: pick(meta?.website, p.csv_website),
    industry: pick(meta?.industry),
    headquarters: pick(meta?.headquarters),
    company_size: pick(meta?.company_size),
    description: pick(meta?.description, p.csv_description),
  }
}
