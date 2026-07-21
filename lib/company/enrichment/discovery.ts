import { fetchText } from './http'
import { resolveCanonicalCompany } from '@/lib/company/slug'
import type { DiscoveryResult, WebsiteDiscoveryProvider } from './types'

/**
 * Website discovery — layered: registry → search → not_found.
 *
 *  1. RegistryDiscovery: authoritative domain for a known company/alias. No fetch,
 *     no guessing. This is the trusted, deterministic layer.
 *  2. SearchWebsiteDiscovery: for UNKNOWN companies, a proper search API (gated on
 *     an API key). Results are VALIDATED — parked / for-sale / marketplace domains
 *     are rejected, and the page must credibly belong to the company — so we never
 *     attach a wrong or junk site. Disabled (returns nothing) when no key is set.
 *  3. Otherwise not_found.
 *
 * We deliberately never GUESS a domain by concatenating name tokens
 * (companyname.com/.io/.co) — that produced blank pages and mis-resolved short
 * names. An unknown company either matches a real search result or stays
 * not_found.
 *
 * ENV: SEARCH_API_KEY enables the search layer (Brave Search API by default;
 * override the endpoint with SEARCH_API_BASE). Without it, unknown companies are
 * not_found — the seam is present and ready, just inert.
 */

// Social / directories / domain-marketplace + parking hosts a company never "owns".
const EXCLUDED = [
  'linkedin.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com',
  'wikipedia.org', 'crunchbase.com', 'bloomberg.com', 'github.com', 'medium.com', 'reddit.com',
  'afternic.com', 'sedo.com', 'hugedomains.com', 'dan.com', 'buydomains.com', 'godaddy.com',
  'bodis.com', 'parkingcrew.net', 'above.com', 'undeveloped.com', 'zoominfo.com', 'dnb.com',
]
const PARKED_MARKERS = [
  'domain is for sale', 'this domain is for sale', 'buy this domain', 'domain for sale',
  'domain parking', 'parked domain', 'inquire about this domain', 'domain may be for sale',
  'purchase this domain', 'the domain name is for sale', 'this domain name is for sale',
]
const LEGAL = /\b(llc|inc|incorporated|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa|nv|bv|llp|lp|group|holdings|partners)\b/gi
const STOP = new Set(['the', 'and', 'of', 'for', 'a', 'an', '&'])

function significantTokens(name: string): string[] {
  return (name || '').toLowerCase().replace(/&/g, ' ').replace(LEGAL, ' ')
    .split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t))
}
function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() } catch { return null }
}
function isExcluded(host: string): boolean {
  return EXCLUDED.some((e) => host === e || host.endsWith('.' + e))
}
function siteIdentity(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''
  const site = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] || ''
  return `${title} ${site}`.toLowerCase()
}

/** Fetch a candidate and decide whether it credibly belongs to `name`. */
async function validateCandidate(origin: string, tokens: string[]): Promise<boolean> {
  if (tokens.length === 0) return false
  const host = hostOf(origin)
  if (!host || isExcluded(host)) return false
  const res = await fetchText(origin, 6000)
  if (!res.ok || !/text\/html/i.test(res.contentType)) return false
  const finalHost = hostOf(res.url) || host
  if (isExcluded(finalHost)) return false // redirected to a marketplace
  const lower = res.text.toLowerCase()
  if (PARKED_MARKERS.some((m) => lower.includes(m))) return false
  const label = host.split('.').slice(0, -1).join('')
  const collapsed = tokens.join('')
  if (label.includes(collapsed) || collapsed.includes(label)) return true
  const haystack = `${label} ${siteIdentity(res.text)}`
  return tokens.filter((t) => haystack.includes(t)).length / tokens.length >= 0.5
}

export class RegistryDiscovery implements WebsiteDiscoveryProvider {
  readonly name = 'registry'
  async discover(companyName: string): Promise<DiscoveryResult> {
    const canonical = resolveCanonicalCompany(companyName)
    if (canonical?.domain) {
      const domain = canonical.domain.replace(/^www\./, '').toLowerCase()
      return { website: `https://${domain}`, domain, via: 'registry', canonicalName: canonical.name }
    }
    return { website: null, domain: null, via: 'none' }
  }
}

const DEFAULT_SEARCH_BASE = 'https://api.search.brave.com/res/v1/web/search'
/** SEARCH_API_BASE must be a valid HTTPS origin; otherwise fall back to the default. */
function resolveSearchBase(): string {
  const raw = process.env.SEARCH_API_BASE
  if (!raw) return DEFAULT_SEARCH_BASE
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:' && u.hostname) return raw
  } catch { /* invalid */ }
  return DEFAULT_SEARCH_BASE
}

/**
 * Search-backed discovery for UNKNOWN companies (Brave Search API by default).
 *
 * SECURITY: SEARCH_API_KEY is server-only (plain process.env, never NEXT_PUBLIC),
 * is sent only as the X-Subscription-Token request header, and is NEVER logged or
 * echoed (queries and errors below never include it). SEARCH_API_BASE is pinned
 * to a validated HTTPS origin. Requests are timeout-bounded and result-capped to
 * bound cost. Any failure degrades to no result → the caller yields not_found.
 * Result-URL fetches go through the SSRF-hardened fetchText (see http.ts).
 */
export class SearchWebsiteDiscovery implements WebsiteDiscoveryProvider {
  readonly name = 'search'
  private readonly key = process.env.SEARCH_API_KEY || ''
  private readonly base = resolveSearchBase()

  isEnabled(): boolean { return this.key.trim().length > 0 }

  private async searchUrls(query: string): Promise<string[]> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 6000)
    try {
      const res = await fetch(`${this.base}?q=${encodeURIComponent(query)}&count=6`, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': this.key },
        signal: ctrl.signal,
      })
      if (!res.ok) return []
      const data: any = await res.json()
      const results = data?.web?.results
      return Array.isArray(results) ? results.map((r: any) => r?.url).filter((u: any) => typeof u === 'string') : []
    } catch {
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  async discover(companyName: string): Promise<DiscoveryResult> {
    const tokens = significantTokens(companyName)
    if (!this.isEnabled() || tokens.length === 0) return { website: null, domain: null, via: 'none' }

    const urls = await this.searchUrls(`${companyName} official website`)
    const seen = new Set<string>()
    const candidates: string[] = []
    for (const u of urls) {
      const host = hostOf(u)
      if (!host || isExcluded(host) || seen.has(host)) continue
      seen.add(host)
      candidates.push(`https://${host}`)
      if (candidates.length >= 4) break
    }
    for (const origin of candidates) {
      if (await validateCandidate(origin, tokens)) {
        return { website: origin, domain: hostOf(origin), via: 'search' }
      }
    }
    return { website: null, domain: null, via: 'none' }
  }
}

/** Tries each provider in order; first with a website wins. */
export class CompositeDiscovery implements WebsiteDiscoveryProvider {
  readonly name = 'registry+search'
  constructor(private readonly providers: WebsiteDiscoveryProvider[]) {}
  async discover(companyName: string): Promise<DiscoveryResult> {
    for (const p of this.providers) {
      const r = await p.discover(companyName)
      if (r.website) return r
    }
    return { website: null, domain: null, via: 'none' }
  }
}

/** Active provider: registry (deterministic) → search (validated) → not_found. */
export const discoveryProvider: WebsiteDiscoveryProvider = new CompositeDiscovery([
  new RegistryDiscovery(),
  new SearchWebsiteDiscovery(),
])
