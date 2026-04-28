/**
 * parseExpertise — robust parser for the profiles.expertise field.
 *
 * The column is TEXT and has accumulated three storage formats over time:
 *   1. Real arrays                  ['Legal', 'M&A']
 *   2. JSON-stringified arrays      '["Legal","M&A"]'
 *   3. Postgres array literals      '{Legal,"M&A"}'
 *   4. Comma-separated strings      'Legal, M&A'
 *   5. Single values                'Legal'
 *   6. null / empty                 null | '' | '{}' | '[]'
 *
 * This helper normalizes all six into string[]. Use it everywhere
 * profile.expertise is read into UI state, scoring logic, or display.
 *
 * Does NOT modify storage. Use only on the read path.
 */
export function parseExpertise(value: unknown): string[] {
  if (value == null) return []

  // Real array — return as-is, filtered to non-empty strings
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean)
  }

  if (typeof value !== 'string') return []

  const trimmed = value.trim()
  if (!trimmed || trimmed === '{}' || trimmed === '[]') return []

  // JSON-stringified array form: ["Legal","M&A"]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v.trim())
          .filter(Boolean)
      }
    } catch {
      // Fall through to comma-split below
    }
  }

  // Postgres array literal form: {Legal,"M&A","data protection"}
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1)
    if (!inner) return []
    const parts: string[] = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]
      if (ch === '"' && inner[i - 1] !== '\\') {
        inQuote = !inQuote
      } else if (ch === ',' && !inQuote) {
        parts.push(cur.trim())
        cur = ''
      } else {
        cur += ch
      }
    }
    if (cur) parts.push(cur.trim())
    return parts.map((p) => p.replace(/^"|"$/g, '').trim()).filter(Boolean)
  }

  // Comma-separated string: 'Legal, M&A'
  if (trimmed.includes(',')) {
    return trimmed.split(',').map((s) => s.trim()).filter(Boolean)
  }

  // Single non-empty value: 'Legal'
  return [trimmed]
}
