/**
 * Self-hosted company enrichment — types and provider contract.
 *
 * The pipeline is: discover the official website → fetch the homepage → extract
 * structured metadata → download + store the logo in our own Supabase Storage
 * bucket → persist to `companies`. It uses NO third-party enrichment API; the
 * only externally-pluggable step is website discovery, which is expressed as a
 * swappable `WebsiteDiscoveryProvider` so it can be replaced later (e.g. a search
 * API with a key) without touching the rest of the pipeline.
 */

/** The fields we attempt to extract from a company's own homepage. */
export type ExtractedMetadata = {
  /** Canonical site origin, e.g. "https://stripe.com". Null if undetermined. */
  website: string | null
  /** The company's own short self-description (meta/OG/JSON-LD). Null if absent. */
  description: string | null
  /** Best logo candidate URL found on the page (pre-download). Null if none. */
  logoUrl: string | null
  /** "City, Region" / "City, Country" from JSON-LD PostalAddress. Null if absent. */
  headquarters: string | null
  /** Industry — only when explicitly present (JSON-LD). Null otherwise (never guessed). */
  industry: string | null
}

/** Result of a website-discovery lookup. */
export type DiscoveryResult = {
  /** Canonical site origin ("https://host"), or null when not confidently found. */
  website: string | null
  /** Bare host ("host.com"), or null. */
  domain: string | null
  /** Which provider produced the answer (for logging / observability). */
  via: string
  /** Canonical company name when resolved from the registry (authoritative). */
  canonicalName?: string | null
}

/**
 * Swappable website-discovery strategy. Given a company's display name, return
 * its official website — or null if it can't be determined confidently. Implementations
 * MUST NOT throw for a normal "not found"; reserve throwing for genuine faults.
 */
export interface WebsiteDiscoveryProvider {
  readonly name: string
  discover(companyName: string): Promise<DiscoveryResult>
}

/** Terminal outcome of an enrichment run (mirrors the persisted enrichment_status). */
export type EnrichStatus =
  | 'enriched'    // found a site and extracted real metadata
  | 'partial'     // canonical identity resolved (name+website+fallback) but homepage metadata unavailable (403/timeout/blocked)
  | 'not_found'   // no confident website / nothing extractable (unknown company)
  | 'failed'      // a fault occurred (network/parse) — eligible for retry
  | 'skipped'     // not eligible (already enriched / admin_edited / claimed elsewhere)
  | 'error'       // could not even claim the row (e.g. table absent)

/** Per-stage outcome, surfaced by the admin Repair action. */
export type EnrichStages = {
  /** How the canonical identity/website was resolved. */
  identity: 'registry' | 'search' | 'unresolved'
  /** Whether an authoritative/valid website is now set. */
  website: boolean
  /** Where the persisted description came from. */
  description: 'scraped' | 'fallback' | 'existing' | 'none'
  /** Where the persisted logo came from. */
  logo: 'scraped' | 'fallback' | 'existing' | 'none'
}

export type EnrichResult = {
  status: EnrichStatus
  website?: string | null
  logoStored?: boolean
  fields?: Partial<ExtractedMetadata>
  stages?: EnrichStages
}
