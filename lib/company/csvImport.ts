import { companySlug } from '@/lib/company/slug'

/**
 * Pure helpers for the admin CSV company-enrichment import (one-time cleanup of
 * missing logos/descriptions). No I/O — parsing + the fill-missing-only decision
 * live here so they are unit-testable; the route does the DB reads/writes and the
 * (existing) logo download.
 */

export interface ImportCsvRow {
  company_name: string
  website: string
  logo_url: string
  description: string
}

const has = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0

/**
 * RFC-4180-ish CSV tokenizer: honors quoted fields (so a description containing
 * commas / newlines stays one field) and "" escaped quotes. Returns records as
 * arrays of raw fields; blank records are dropped.
 */
export function parseCsvRecords(text: string): string[][] {
  const s = (text || '').replace(/\r\n?/g, '\n')
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } // escaped quote
        else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      record.push(field); field = ''
    } else if (c === '\n') {
      record.push(field); records.push(record); record = []; field = ''
    } else {
      field += c
    }
  }
  if (field.length > 0 || record.length > 0) { record.push(field); records.push(record) }
  return records.filter((r) => r.some((f) => f.trim().length > 0))
}

const CANONICAL_HEADER = ['company_name', 'website', 'logo_url', 'description'] as const

/**
 * Parse the import CSV. Accepts an optional header row (any column order) or, if
 * absent, assumes the canonical column order. Rows without a company_name are
 * reported as errors, never silently dropped.
 */
export function parseImportCsv(text: string): { rows: ImportCsvRow[]; errors: { line: number; reason: string }[] } {
  const records = parseCsvRecords(text)
  const rows: ImportCsvRow[] = []
  const errors: { line: number; reason: string }[] = []
  if (records.length === 0) return { rows, errors }

  let idx: Record<(typeof CANONICAL_HEADER)[number], number> = { company_name: 0, website: 1, logo_url: 2, description: 3 }
  let start = 0
  const first = records[0].map((f) => f.trim().toLowerCase())
  if (CANONICAL_HEADER.every((h) => first.includes(h))) {
    idx = {
      company_name: first.indexOf('company_name'),
      website: first.indexOf('website'),
      logo_url: first.indexOf('logo_url'),
      description: first.indexOf('description'),
    }
    start = 1
  }

  for (let i = start; i < records.length; i++) {
    const r = records[i]
    const get = (k: keyof typeof idx) => (r[idx[k]] ?? '').trim()
    const company_name = get('company_name')
    if (!company_name) { errors.push({ line: i + 1, reason: 'Missing company_name' }); continue }
    rows.push({ company_name, website: get('website'), logo_url: get('logo_url'), description: get('description') })
  }
  return { rows, errors }
}

export interface ExistingCompany {
  slug: string
  name?: string | null
  logo_url?: string | null
  description?: string | null
  admin_edited?: boolean | null
}

export interface ImportPlanItem {
  input: ImportCsvRow
  slug: string
  matchedName: string | null
  action: 'update' | 'skip' | 'not_found'
  reason?: string
  /** Fields the import would fill (missing on the row AND present in the CSV). */
  fields: {
    logo_url?: { current: string | null; candidate: string }
    description?: { current: string | null; next: string }
  }
}

/**
 * Fill-missing-only plan. Matches each CSV row to an EXISTING company by canonical
 * slug and decides update / skip / not_found:
 *   • no matching row              → not_found
 *   • admin_edited = true           → skip (never touched)
 *   • both logo AND description set  → skip (already complete)
 *   • otherwise fill ONLY the missing field(s) the CSV provides; never overwrite a
 *     non-empty logo_url or description.
 */
export function computeImportPlan(rows: ImportCsvRow[], existingBySlug: Map<string, ExistingCompany>): ImportPlanItem[] {
  return rows.map((input): ImportPlanItem => {
    const slug = companySlug(input.company_name)
    const row = slug ? existingBySlug.get(slug) : undefined
    if (!slug || !row) return { input, slug, matchedName: null, action: 'not_found', fields: {} }
    if (row.admin_edited === true) return { input, slug, matchedName: row.name ?? null, action: 'skip', reason: 'admin_edited', fields: {} }

    const fields: ImportPlanItem['fields'] = {}
    if (!has(row.logo_url) && has(input.logo_url)) fields.logo_url = { current: row.logo_url ?? null, candidate: input.logo_url.trim() }
    if (!has(row.description) && has(input.description)) fields.description = { current: row.description ?? null, next: input.description.trim() }

    if (!fields.logo_url && !fields.description) {
      const reason = has(row.logo_url) && has(row.description) ? 'already complete' : 'no new values in CSV'
      return { input, slug, matchedName: row.name ?? null, action: 'skip', reason, fields: {} }
    }
    return { input, slug, matchedName: row.name ?? null, action: 'update', fields }
  })
}
