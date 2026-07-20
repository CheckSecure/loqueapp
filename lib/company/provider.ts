/**
 * Company enrichment provider — The Companies API (thecompaniesapi.com).
 *
 * Env-var contract:
 *   COMPANIES_API_KEY   (required to enable enrichment; when unset, enrichment
 *                        is DISABLED and every function no-ops cleanly)
 *   COMPANIES_API_BASE  (optional; defaults to the v2 API base)
 *
 * Two-step, layered flow: resolve a domain from the company NAME, then enrich by
 * domain. Field mapping is defensive (candidate paths + fallbacks) because the
 * exact response nesting can vary; unknown fields simply resolve to null.
 */

const BASE = (process.env.COMPANIES_API_BASE || 'https://api.thecompaniesapi.com/v2').replace(/\/$/, '')
const KEY = process.env.COMPANIES_API_KEY || ''

/** Enrichment is only active when a key is configured. */
export function isEnrichmentEnabled(): boolean {
  return KEY.trim().length > 0
}

export type EnrichedFields = {
  name: string | null
  website: string | null
  logo_url: string | null
  industry: string | null
  headquarters: string | null
  company_size: string | null
  founded: string | null
}

async function apiGet(path: string, timeoutMs = 2500): Promise<any | { __error: string } | null> {
  if (!KEY) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Basic ${KEY}`, Accept: 'application/json' },
      signal: ctrl.signal,
    })
    if (!res.ok) return { __error: `HTTP ${res.status}` }
    return await res.json()
  } catch (e: any) {
    return { __error: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'fetch_error') }
  } finally {
    clearTimeout(timer)
  }
}

/** First non-empty value among candidate dotted paths (arrays index numerically). */
function pick(obj: any, paths: string[]): string | null {
  for (const p of paths) {
    const v = p.split('.').reduce((o: any, k: string) => (o == null ? o : o[k]), obj)
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

/** Normalize an employee-size value into a readable range. */
export function normalizeSize(raw: string | null): string | null {
  if (!raw) return null
  const s = String(raw).trim()
  const over = s.match(/over-?(\d+)k/i)
  if (over) return `${Number(over[1]) * 1000}+`
  const range = s.match(/^(\d+)\s*[-–]\s*(\d+)$/)
  if (range) return `${range[1]}–${range[2]}`
  return s
}

/** Resolve a company's primary domain from its name. */
export async function resolveDomainByName(name: string): Promise<{ domain: string | null; error?: string }> {
  const data = await apiGet(`/companies?search=${encodeURIComponent(name)}&size=1`)
  if (!data) return { domain: null }
  if ((data as any).__error) return { domain: null, error: (data as any).__error }
  const list = (data as any).companies || (data as any).data || (Array.isArray(data) ? data : [])
  const first = Array.isArray(list) ? list[0] : null
  const raw = pick(first, ['domain.domain', 'domain', 'website.domain', 'website.url'])
  const domain = raw ? raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') : null
  return { domain }
}

/** Enrich structured fields from a domain. */
export async function enrichByDomain(domain: string): Promise<{ fields: EnrichedFields | null; error?: string; notFound?: boolean }> {
  const data = await apiGet(`/companies/${encodeURIComponent(domain)}`)
  if (!data) return { fields: null }
  if ((data as any).__error) {
    const err = (data as any).__error as string
    if (/HTTP 404/.test(err)) return { fields: null, notFound: true }
    return { fields: null, error: err }
  }
  const c = (data as any).company || data
  const website = pick(c, ['website.url', 'domain.domain', 'domain'])
  const fields: EnrichedFields = {
    name: pick(c, ['about.name', 'name', 'domain.company', 'meta.title']),
    website: website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : null,
    logo_url: pick(c, ['assets.logoSquare', 'assets.logo', 'logo.square', 'logo', 'meta.logo']),
    industry: pick(c, ['about.industry', 'industries.0.name', 'category.industry', 'about.industries.0']),
    headquarters: pick(c, ['locations.headquarters.city.name', 'locations.hqFullAddress', 'locations.headquarters', 'about.location', 'headquarters']),
    company_size: normalizeSize(pick(c, ['about.totalEmployees', 'employees.range', 'about.size', 'metrics.employees'])),
    founded: pick(c, ['about.yearFounded', 'foundedYear', 'about.founded']),
  }
  return { fields }
}

/** Concise, FACTUAL description composed from structured datapoints (not copied prose). */
export function composeDescription(f: EnrichedFields, fallbackName: string): string | null {
  const n = f.name || fallbackName
  const clauses: string[] = []
  if (f.industry) clauses.push(`operates in ${f.industry.toLowerCase()}`)
  if (f.headquarters) clauses.push(`is headquartered in ${f.headquarters}`)
  if (f.founded) clauses.push(`was founded in ${f.founded}`)
  if (clauses.length === 0) return null
  let s = `${n} ${clauses.join(', ')}.`
  if (f.company_size) s += ` It has approximately ${f.company_size} employees.`
  return s
}
