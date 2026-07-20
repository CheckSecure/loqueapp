import { fetchText } from './http'
import type { DiscoveryResult, WebsiteDiscoveryProvider } from './types'

/**
 * Website discovery — provider interface + a TEMPORARY implementation.
 *
 * IMPORTANT: this deliberately does NOT scrape a search engine. It probes a small
 * set of candidate domains derived from the company name and validates each by
 * fetching the site itself and checking it credibly belongs to the company. That
 * makes it dependency-free and safe to run in production, at the cost of only
 * resolving companies whose domain is guessable from their name.
 *
 * This is the swap point. When a proper website-discovery source is chosen (a
 * search API with a key, an internal index, etc.), implement
 * `WebsiteDiscoveryProvider` and reassign `discoveryProvider` — nothing else in
 * the pipeline changes. See types.ts for the contract.
 */

// Hosts that are never a company's own site (guards heuristic false-positives).
const EXCLUDED = [
  'linkedin.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com',
  'wikipedia.org', 'crunchbase.com', 'bloomberg.com', 'github.com', 'medium.com',
]

const LEGAL = /\b(llc|inc|incorporated|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa|nv|bv|llp|lp|group|holdings|partners)\b/gi
const STOP = new Set(['the', 'and', 'of', 'for', 'a', 'an', '&'])

/** Significant, lowercased name tokens (legal suffixes and stopwords removed). */
export function significantTokens(name: string): string[] {
  return (name || '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(LEGAL, ' ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t))
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() } catch { return null }
}

function isExcluded(host: string): boolean {
  return EXCLUDED.some((e) => host === e || host.endsWith('.' + e))
}

/** Pull <title> and og:site_name from raw HTML (cheap, regex-level). */
function siteIdentity(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''
  const site = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] || ''
  return `${title} ${site}`.toLowerCase()
}

/**
 * Fetch a candidate origin and decide whether it credibly belongs to `name`.
 * Confident when the collapsed name is literally the domain label, or at least
 * half the significant name tokens appear in the domain label + <title> +
 * og:site_name. Anything less → not confident → we don't attach it.
 */
async function validate(origin: string, tokens: string[]): Promise<boolean> {
  if (tokens.length === 0) return false
  const host = hostOf(origin)
  if (!host || isExcluded(host)) return false
  const res = await fetchText(origin, 6000)
  if (!res.ok || !/text\/html/i.test(res.contentType)) return false
  const label = host.split('.').slice(0, -1).join('') // strip TLD
  const collapsed = tokens.join('')
  if (label.includes(collapsed) || collapsed.includes(label)) return true
  const haystack = `${label} ${siteIdentity(res.text)}`
  const matched = tokens.filter((t) => haystack.includes(t)).length
  return matched / tokens.length >= 0.5
}

/**
 * TEMPORARY heuristic discovery: guess a handful of candidate domains from the
 * company name and keep the first that validates. No search engine, no API key.
 */
export class HeuristicWebsiteDiscovery implements WebsiteDiscoveryProvider {
  readonly name = 'heuristic-temporary'

  async discover(companyName: string): Promise<DiscoveryResult> {
    const tokens = significantTokens(companyName)
    if (tokens.length === 0) return { website: null, domain: null, via: 'none' }

    const forms = Array.from(new Set([tokens.join(''), tokens.join('-')])).filter((f) => f.length >= 2)
    const tlds = ['com', 'io', 'co']
    let attempts = 0
    for (const form of forms) {
      for (const tld of tlds) {
        if (attempts >= 4) return { website: null, domain: null, via: 'none' } // keep it fast
        attempts++
        const origin = `https://${form}.${tld}`
        if (await validate(origin, tokens)) return { website: origin, domain: hostOf(origin), via: 'heuristic' }
      }
    }
    return { website: null, domain: null, via: 'none' }
  }
}

/**
 * The active provider. Reassign this (or set it from config) to swap discovery
 * strategy pipeline-wide without touching run.ts / extract.ts / logo.ts.
 */
export const discoveryProvider: WebsiteDiscoveryProvider = new HeuristicWebsiteDiscovery()
