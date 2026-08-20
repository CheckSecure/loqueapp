import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Structural guarantees for the production catalog audit.
 *
 * WHAT WENT WRONG THE FIRST TIME. The audit hand-wrote its dependency-search regex in three separate
 * places and, in all three, listed only four of the six audited relations — `profiles` and `matches`
 * were missing. A production-only function, policy or trigger touching either would have gone
 * unreported, and the audit's whole purpose is to find production-only objects. The fix is
 * structural, not a bigger regex: the six names are declared ONCE, in the `params` CTE, and every
 * search derives its pattern from that array. These tests pin that arrangement so the omission
 * cannot recur by editing one search and forgetting the others.
 */

const SQL = readFileSync('supabase/audit/063_production_schema_audit.sql', 'utf8')
const RELATIONS = [
  'intro_requests', 'recommendation_batches', 'member_pairs',
  'profiles', 'matches', 'blocked_users',
] as const

// Statement text only — comments explain the design and legitimately mention names in prose.
const CODE = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('the six audited relations are declared exactly once', () => {
  it('the params CTE lists all six', () => {
    const m = CODE.match(/SELECT ARRAY\[([\s\S]*?)\]::text\[\] AS names/)
    expect(m, 'params CTE not found').toBeTruthy()
    for (const r of RELATIONS) expect(m![1], `params omits ${r}`).toContain(`'${r}'`)
  })

  it('no other place hard-codes a list of these relation names', () => {
    // Exactly one array literal enumerating them; everything else must derive from it.
    const literals = CODE.match(/'intro_requests'\s*,\s*'recommendation_batches'/g) ?? []
    expect(literals).toHaveLength(1)
  })

  it('no hand-written alternation regex survives anywhere', () => {
    // This is the exact shape of the original defect.
    expect(CODE).not.toMatch(/intro_requests\|recommendation_batches/)
    expect(CODE).not.toMatch(/\|member_pairs\|blocked_users/)
  })
})

describe('every dependency search derives from the shared pattern', () => {
  const searches = [
    { name: 'body-text function matches', cte: 'dep_funcs_body' },
    { name: 'dependent policies',          cte: 'dep_policies' },
    { name: 'dependent triggers',          cte: 'dep_triggers' },
  ]

  for (const s of searches) {
    it(`${s.cte} filters on patt.rx, not a literal`, () => {
      const start = CODE.indexOf(`${s.cte} AS (`)
      expect(start, `${s.cte} not found`).toBeGreaterThan(-1)
      const body = CODE.slice(start, CODE.indexOf('\n),', start))
      expect(body, `${s.cte} does not use the shared regex`).toMatch(/~\*\s*\(SELECT rx FROM patt\)/)
      for (const r of RELATIONS) {
        expect(body, `${s.cte} hard-codes ${r}`).not.toContain(`'${r}'`)
      }
    })
  }

  it('the shared regex is built from params and is surfaced in the output for inspection', () => {
    expect(CODE).toContain("array_to_string(names, '|')")
    expect(CODE).toMatch(/AS rx FROM params/)
    expect(CODE).toMatch(/'dependency_search_regex', \(SELECT rx FROM patt\)/)
  })

  it('the per-function "mentions" list also derives from params', () => {
    expect(CODE).toMatch(/FROM pg_catalog\.unnest\(\(SELECT names FROM params\)\) tname/)
  })
})

describe('trigger definitions are never withheld', () => {
  it('pg_get_triggerdef is called unconditionally, with no internal-trigger CASE', () => {
    // The earlier draft returned definition = NULL for internal triggers, silently removing rows
    // from a catalog enumeration.
    const trg = CODE.slice(CODE.indexOf('trg AS ('), CODE.indexOf('\n),', CODE.indexOf('trg AS (')))
    expect(trg).toMatch(/'definition',\s*pg_catalog\.pg_get_triggerdef\(g\.oid, true\)/)
    expect(trg).not.toMatch(/CASE WHEN g\.tgisinternal THEN NULL/)
    expect(trg).toMatch(/'internal',\s*g\.tgisinternal/)   // the flag is retained for filtering
  })

  it('the dependent-trigger section also returns definitions unconditionally', () => {
    const dep = CODE.slice(CODE.indexOf('dep_triggers AS ('))
    expect(dep).toMatch(/'definition',\s*pg_catalog\.pg_get_triggerdef\(g\.oid, true\)/)
    expect(dep).not.toMatch(/CASE WHEN g\.tgisinternal THEN NULL/)
  })
})

describe('function identity is reported in full, because argument ORDER is the identity', () => {
  for (const field of [
    "'oid'", "'regprocedure'", "'pronargs'", "'proargtypes_physical_order'", "'proargnames'",
    "'identity_arguments'", "'arguments'", "'result'", "'pronargdefaults'",
    "'default_expressions'", "'owner'", "'acl_raw'", "'acl'", "'definition'",
  ]) {
    it(`reports ${field}`, () => expect(CODE).toContain(field))
  }

  it('physical argument order comes from proargtypes, not from the printed identity string', () => {
    expect(CODE).toMatch(/pg_catalog\.unnest\(f\.proargtypes\)\s*\n?\s*WITH ORDINALITY/)
  })

  it('overloads of create_reciprocal_suggestion are surfaced as their own key', () => {
    expect(CODE).toMatch(/'create_reciprocal_suggestion_overloads'/)
    expect(CODE).toMatch(/WHERE proname = 'create_reciprocal_suggestion'/)
  })
})

describe('catalog-recorded and body-text dependencies are separate and both labelled', () => {
  it('a pg_depend section exists for functions and procedures', () => {
    expect(CODE).toMatch(/dep_funcs_catalog AS \(/)
    expect(CODE).toMatch(/d\.classid\s*=\s*'pg_catalog\.pg_proc'::regclass/)
    expect(CODE).toMatch(/d\.refclassid\s*=\s*'pg_catalog\.pg_class'::regclass/)
  })

  it('the body-text search covers procedures as well as functions', () => {
    expect(CODE).toMatch(/p\.prokind IN \('f','p'\)/)
  })

  it('the output labels them distinctly and claims neither is exhaustive', () => {
    expect(CODE).toContain("'catalog_recorded_function_dependencies'")
    expect(CODE).toContain("'body_text_function_matches'")
    expect(SQL).toMatch(/NOT exhaustive/)
    expect(SQL).toMatch(/Neither is exhaustive alone/)
  })
})

describe('missing relations are explicit, never silently absent', () => {
  it('the tables object is built from the requested list, not from what was found', () => {
    expect(CODE).toMatch(/FROM requested r\s*\n\s*LEFT JOIN targets t ON t\.relname = r\.relname/)
    expect(CODE).toMatch(/CASE WHEN t\.oid IS NULL THEN jsonb_build_object\('present', false\)/)
  })

  it('missing_tables is retained as an independent check', () => {
    expect(CODE).toMatch(/'missing_tables'/)
  })
})

describe('the audit is read-only and returns no member data', () => {
  it('contains no DDL or DML statement', () => {
    // Privilege NAMES and policy-command CASE labels are strings, not statements, so match only
    // statement-initial usage.
    expect(CODE).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY)\b/mi)
  })

  it('selects from pg_catalog only — never from an audited table', () => {
    for (const r of RELATIONS) {
      expect(CODE, `reads rows from ${r}`).not.toMatch(new RegExp(`FROM\\s+public\\.${r}\\b`, 'i'))
    }
  })

  it('warns that the reciprocal function body embeds the admin address', () => {
    expect(SQL).toMatch(/bizdev91@gmail\.com/)
    expect(SQL).toMatch(/redact that one line/)
  })
})
