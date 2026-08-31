/**
 * Cheap, conservative detection of mistyped email addresses.
 *
 * This exists because an invitation is sent ONCE to an address a human typed on someone else's
 * behalf. A nominator typing `gmail.con` produces a permanent hard bounce that looks identical to
 * "they ignored us", and the nominee never learns they were recommended at all.
 *
 * DELIBERATELY CONSERVATIVE. It flags for review; it never rewrites an address, and it never
 * silently substitutes a "corrected" one. A false positive costs an operator one glance. Silently
 * mailing the wrong person costs more.
 */

/** Domains common enough that a near-miss is far more likely a typo than a real host. */
const MAJOR_PROVIDERS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
  'msn.com', 'comcast.net', 'verizon.net', 'sbcglobal.net',
]

/**
 * TLDs that are not real and sit one slip away from a real one. Kept as an explicit list rather
 * than "not in the IANA set" so a legitimate new gTLD is never blocked by a stale copy of that set.
 */
const BAD_TLDS = new Set([
  'con', 'cmo', 'ocm', 'cim', 'xom', 'vom', 'coom', 'comm', 'cm', 'co,', 'c0m',
  'nte', 'ner', 'nett', 'orgg', 'ogr', 'edut', 'guv', 'govv',
])

/**
 * Damerau-Levenshtein (optimal string alignment), bounded.
 *
 * Plain Levenshtein scores a TRANSPOSITION as two edits, which would let "gmial.com" through — and
 * transposed adjacent letters are one of the most common ways a typed domain goes wrong. Counting
 * it as a single edit is the whole reason this is not the simpler algorithm.
 */
function editDistanceWithin(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  // Three rows: i-2, i-1, i. The i-2 row is what makes a transposition cost 1.
  let prev2: number[] = []
  let prev: number[] = new Array(b.length + 1)
  let cur: number[] = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    let rowMin = cur[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1) // adjacent transposition
      }
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    prev2 = prev
    prev = cur
    cur = new Array(b.length + 1)
  }
  return prev[b.length]
}

export interface EmailSanity {
  suspect: boolean
  /** Operator-facing reason. Absent when not suspect. */
  reason?: string
  /** The address this was probably meant to be. NEVER applied automatically. */
  suggestion?: string
}

export function checkEmailSanity(raw: string | null | undefined): EmailSanity {
  const email = (raw ?? '').trim().toLowerCase()
  if (!email) return { suspect: true, reason: 'empty address' }

  const at = email.lastIndexOf('@')
  if (at <= 0 || at === email.length - 1) return { suspect: true, reason: 'not a valid address shape' }
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)

  if (email.includes(' ')) return { suspect: true, reason: 'contains a space' }
  if (email.split('@').length !== 2) return { suspect: true, reason: 'more than one @' }
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    return { suspect: true, reason: 'malformed domain' }
  }
  if (!domain.includes('.')) return { suspect: true, reason: 'domain has no dot' }
  if (!local) return { suspect: true, reason: 'empty local part' }

  const labels = domain.split('.')
  const tld = labels[labels.length - 1]

  if (BAD_TLDS.has(tld)) {
    // Offer the obvious repair only for the unambiguous cases.
    const fixedTld = tld === 'con' || tld === 'cmo' || tld === 'ocm' || tld === 'xom'
      || tld === 'vom' || tld === 'coom' || tld === 'comm' || tld === 'c0m' || tld === 'cim' ? 'com'
      : tld === 'nte' || tld === 'ner' || tld === 'nett' ? 'net'
      : tld === 'orgg' || tld === 'ogr' ? 'org'
      : null
    return {
      suspect: true,
      reason: `".${tld}" is not a real top-level domain`,
      ...(fixedTld ? { suggestion: `${local}@${labels.slice(0, -1).join('.')}.${fixedTld}` } : {}),
    }
  }

  if (!/^[a-z]{2,}$/.test(tld)) {
    return { suspect: true, reason: `".${tld}" is not a plausible top-level domain` }
  }

  // A near-miss on a major provider. Exact matches exit first, so a real address is never flagged.
  if (!MAJOR_PROVIDERS.includes(domain)) {
    for (const provider of MAJOR_PROVIDERS) {
      if (editDistanceWithin(domain, provider, 1) <= 1) {
        return {
          suspect: true,
          reason: `domain is one character from "${provider}"`,
          suggestion: `${local}@${provider}`,
        }
      }
    }
  }

  return { suspect: false }
}
