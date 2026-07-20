import type { ExtractedMetadata } from './types'

/**
 * Extract company metadata from a homepage's HTML.
 *
 * Prefers structured JSON-LD (schema.org Organization) and falls back to
 * OpenGraph / standard meta tags. Anything not confidently present is left null
 * — we never invent industries, HQs, or descriptions. Returns the metadata plus
 * an ORDERED list of logo candidate URLs (best first) for the downloader to try.
 */
export type ExtractOutput = { metadata: ExtractedMetadata; logoCandidates: string[] }

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/gi, "'").replace(/&#x2F;/gi, '/')
}

function cleanText(s: string | null | undefined, max = 600): string | null {
  if (!s) return null
  const t = decodeEntities(String(s)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

function absUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null
  try { return new URL(href.trim(), base).toString() } catch { return null }
}

/** First matching content= for a set of meta property/name keys. */
function metaContent(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
      'i',
    )
    const tag = html.match(re)?.[0]
    if (tag) {
      const content = tag.match(/content=["']([^"']*)["']/i)?.[1]
      if (content && content.trim()) return content.trim()
    }
  }
  return null
}

type JsonLdOrg = { description?: string; logo?: string; address?: string; industry?: string }

function parseJsonLd(html: string): JsonLdOrg {
  const out: JsonLdOrg = {}
  const blocks = Array.from(html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi))
  const nodes: any[] = []
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b[1].trim())
      const arr = Array.isArray(parsed) ? parsed : parsed['@graph'] && Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed]
      nodes.push(...arr)
    } catch { /* skip malformed JSON-LD */ }
  }
  const isOrg = (t: any) => {
    const types = Array.isArray(t) ? t : [t]
    return types.some((x) => typeof x === 'string' && /Organization|Corporation|LocalBusiness|Company|NGO/i.test(x))
  }
  const org = nodes.find((n) => n && isOrg(n['@type']))
  if (!org) return out

  if (typeof org.description === 'string') out.description = org.description
  // logo can be a string, {url}, or an ImageObject array
  const logo = org.logo
  if (typeof logo === 'string') out.logo = logo
  else if (logo && typeof logo === 'object') out.logo = logo.url || (Array.isArray(logo) ? (logo[0]?.url || logo[0]) : undefined)

  // address: string or PostalAddress object
  const addr = org.address
  if (typeof addr === 'string') out.address = addr
  else if (addr && typeof addr === 'object') {
    const a = Array.isArray(addr) ? addr[0] : addr
    const parts = [a?.addressLocality, a?.addressRegion || a?.addressCountry].filter(Boolean)
    if (parts.length) out.address = parts.join(', ')
  }
  return out
}

/** Collect logo/icon candidate URLs from <link> tags, largest first. */
function iconCandidates(html: string, base: string): string[] {
  const found: { url: string; size: number; rank: number }[] = []
  const links = Array.from(html.matchAll(/<link[^>]+>/gi))
  for (const l of links) {
    const tag = l[0]
    const rel = tag.match(/rel=["']([^"']+)["']/i)?.[1]?.toLowerCase() || ''
    if (!/icon/.test(rel)) continue
    const href = absUrl(tag.match(/href=["']([^"']+)["']/i)?.[1], base)
    if (!href) continue
    const sizeStr = tag.match(/sizes=["']([^"']+)["']/i)?.[1] || ''
    const size = parseInt(sizeStr.split('x')[0], 10) || 0
    // apple-touch-icon tends to be a clean square logo; rank it above plain favicons
    const rank = /apple-touch-icon/.test(rel) ? 2 : /mask-icon/.test(rel) ? 0 : 1
    found.push({ url: href, size, rank })
  }
  found.sort((a, b) => b.rank - a.rank || b.size - a.size)
  return found.map((f) => f.url)
}

export function extractMetadata(html: string, finalUrl: string): ExtractOutput {
  let origin = finalUrl
  try { origin = new URL(finalUrl).origin } catch { /* keep as-is */ }

  const ld = parseJsonLd(html)

  const description = cleanText(ld.description) || cleanText(metaContent(html, ['og:description', 'description', 'twitter:description']))
  const headquarters = cleanText(ld.address, 120)

  // Logo candidates, best first: JSON-LD logo → apple-touch/icon links → og:image → favicon.ico
  const candidates: string[] = []
  const push = (u: string | null | undefined) => { const a = absUrl(u, origin); if (a && !candidates.includes(a)) candidates.push(a) }
  push(ld.logo)
  for (const c of iconCandidates(html, origin)) push(c)
  push(metaContent(html, ['og:image', 'twitter:image', 'twitter:image:src']))
  push(`${origin}/favicon.ico`)

  const metadata: ExtractedMetadata = {
    website: origin,
    description,
    logoUrl: candidates[0] || null,
    headquarters,
    industry: null, // homepages don't state this reliably; never guessed
  }
  return { metadata, logoCandidates: candidates }
}
