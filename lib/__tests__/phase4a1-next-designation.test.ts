import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { normalizeEmail } from '@/lib/auth/normalizeEmail'

/**
 * PHASE 4A-1 — the guardrails, installed before anything can use them.
 *
 * The load-bearing claim of this stage is NEGATIVE: after it, the application is STILL incapable of
 * creating a Next member. So most of these tests assert absence, and the behavioural proof that the
 * database invariants actually bite lives in the disposable PostgreSQL harness run (documented in
 * docs/PHASE4A_NEXT_DESIGNATION.md) rather than here — a TypeScript test cannot execute a trigger.
 */

const M = 'supabase/migrations/099_next_community_designation_foundation.sql'
const SQL = readFileSync(M, 'utf8')
const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('the migration exists and adds no new community value', () => {
  it('is the next number and does not touch 095-098', () => {
    expect(existsSync(M)).toBe(true)
    // Tracked changes AND untracked additions — the migration may still be unstaged locally.
    const changed = execSync('git diff --name-only origin/main -- supabase/migrations/ || true', { encoding: 'utf8' })
      .split('\n').filter(Boolean)
    const added = execSync('git ls-files --others --exclude-standard supabase/migrations/ || true', { encoding: 'utf8' })
      .split('\n').filter(Boolean)
    expect(Array.from(new Set([...changed, ...added]))).toEqual([M])
  })

  it('recognises exactly professional and next', () => {
    expect(code).toContain("CHECK (intended_member_type IN ('professional', 'next'))")
    const communities = Array.from(code.matchAll(/'(professional|next)'/g)).map((m) => m[1])
    expect(new Set(communities)).toEqual(new Set(['professional', 'next']))
  })

  it('leaves the Phase 3 boundary alone', () => {
    expect(code).not.toMatch(/CREATE OR REPLACE FUNCTION public\.community_pair_allowed/)
    expect(code).not.toMatch(/DROP FUNCTION/)
    // The only DROP TRIGGERs are this migration's own idempotent re-create pattern.
    const drops = Array.from(code.matchAll(/DROP TRIGGER IF EXISTS (\w+)/g)).map((m) => m[1]).sort()
    expect(drops).toEqual(['profiles_member_type_immutable_bu', 'waitlist_intent_no_conflict_biu'])
    expect(code).toContain('community_pair_allowed disappeared')   // asserted, not modified
  })
})

describe('intended community: server-controlled, Professional-safe', () => {
  it('lives on the waitlist row, NOT NULL, defaulted Professional', () => {
    expect(code).toMatch(/ALTER TABLE public\.waitlist\s+ADD COLUMN IF NOT EXISTS intended_member_type text NOT NULL DEFAULT 'professional'/)
  })

  it('every existing waitlist row becomes Professional, proven after apply', () => {
    expect(code).toContain('a waitlist row carries an unrecognised intended_member_type')
  })

  it('no browser role can reach it, and no client parameter selects it', () => {
    // The column is on waitlist, which the browser cannot write; and nothing in production names it.
    const hits = execSync("grep -rln 'intended_member_type' --include='*.ts' --include='*.tsx' app lib components || true",
      { encoding: 'utf8' }).split('\n').filter(Boolean).filter((f) => !f.includes('__tests__'))
    expect(hits).toEqual(['lib/db/migrationHealth.ts'])   // registration only, not a writer
  })
})

describe('conflicting intent is refused at issuance AND detectable at provisioning', () => {
  it('the issuance trigger refuses only a DIFFERENT live intent, so replay stays idempotent', () => {
    expect(code).toContain('w.intended_member_type IS DISTINCT FROM NEW.intended_member_type')
    expect(code).toContain("COALESCE(w.status, '') <> 'revoked'")
    expect(code).toMatch(/CREATE TRIGGER waitlist_intent_no_conflict_biu\s+BEFORE INSERT OR UPDATE/)
  })

  it('the provisioning resolver answers resolved / ambiguous / not_found and never guesses', () => {
    const fn = code.slice(code.indexOf('FUNCTION public.resolve_intended_member_type'))
    for (const outcome of ["'outcome', 'resolved'", "'outcome', 'ambiguous'", "'outcome', 'not_found'"]) {
      expect(fn, outcome).toContain(outcome)
    }
    // More than one distinct live intent is a refusal, not a pick.
    expect(fn).toMatch(/array_length\(v_types, 1\) > 1[\s\S]{0,120}ambiguous/)
  })

  it('protection is NOT solely at issuance — the resolver is independent of the trigger', () => {
    // It queries waitlist directly, so a dropped/disabled trigger or a legacy row still yields
    // 'ambiguous'. Proven behaviourally in the harness by disabling the trigger and smuggling a row.
    const fn = code.slice(code.indexOf('FUNCTION public.resolve_intended_member_type'))
    expect(fn).toContain('FROM public.waitlist w')
    expect(fn).not.toContain('tg_waitlist_intent_no_conflict')
  })

  it('identity is the repository’s existing normalization, not a new one', () => {
    // TypeScript: lower + trim. SQL: lower(btrim(...)). One rule, two languages.
    expect(normalizeEmail('  A@X.com ')).toBe('a@x.com')
    const occurrences = code.match(/pg_catalog\.lower\(pg_catalog\.btrim\(/g) ?? []
    expect(occurrences.length).toBeGreaterThanOrEqual(3)
    expect(readFileSync('supabase/migrations/078_invitation_resume_tokens.sql', 'utf8'))
      .toContain('pg_catalog.lower(pg_catalog.btrim(')
  })
})

describe('member_type immutability', () => {
  const fn = code.slice(code.indexOf('FUNCTION public.tg_profiles_member_type_immutable'))

  it('is a BEFORE UPDATE row trigger on profiles — it binds service_role, which bypasses RLS', () => {
    expect(code).toMatch(/CREATE TRIGGER profiles_member_type_immutable_bu\s+BEFORE UPDATE ON public\.profiles\s+FOR EACH ROW/)
  })

  it('rejects any change, and allows an UPDATE that names the same value', () => {
    expect(fn).toContain('NEW.member_type IS DISTINCT FROM OLD.member_type')
    expect(fn).toContain('immutable after provisioning')
  })

  it('does NOT restrict INSERT — 4A-2 must still be able to create a Next member', () => {
    expect(code).not.toMatch(/BEFORE INSERT[^\n]*ON public\.profiles/)
    expect(code).toMatch(/CREATE TRIGGER profiles_member_type_immutable_bu\s+BEFORE UPDATE/)
  })

  it('has no bypass of any kind', () => {
    expect(code).not.toMatch(/ADMIN_EMAIL|bizdev91|is_admin|bypass|allow_change|force|override|session_user|current_setting/i)
  })

  it('does not create the future correction mechanism', () => {
    expect(code).not.toMatch(/correct_member_type|change_member_type|set_member_type|promote_member/i)
  })
})

describe('4A-1 ships NO production writer — the central claim of this stage', () => {
  const productionMemberTypeWrites = () =>
    execSync("grep -rn 'member_type' --include='*.ts' --include='*.tsx' app lib components 2>/dev/null | grep -v __tests__ || true",
      { encoding: 'utf8' }).split('\n').filter(Boolean)

  it('no production file writes profiles.member_type', () => {
    const files = Array.from(new Set(productionMemberTypeWrites().map((l) => l.split(':')[0])))
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, `${f} writes member_type`).not.toMatch(/\.(insert|update|upsert)\([\s\S]{0,20}\{[^}]*member_type/)
    }
  })

  it("no production code assigns 'next' to a member", () => {
    const hits = execSync(`grep -rnE "member_type[^\\n]*[:=][^=]*'next'" --include='*.ts' --include='*.tsx' app lib components || true`,
      { encoding: 'utf8' }).split('\n').filter(Boolean).filter((l) => !l.includes('__tests__'))
    expect(hits).toEqual([])
  })

  // Replaces an earlier `git diff --name-only origin/main` guard. That form asserted the 4A-1 BRANCH
  // did not touch three named files; once 4A-1 merged, `origin/main` became the branch itself, so the
  // guard compared main to main and asserted nothing. It also named lib/provisioning.ts, which no
  // longer exists — the invite-time provisioner and its admin reconciler were removed once
  // generateLink({type:'invite'}) made invite-time profile creation impossible by design.
  //
  // This is the content assertion the diff guard was standing in for, and it is strictly stronger:
  // it enumerates the creation paths from the source every run, so ADDING a new one fails here —
  // which the diff form never detected.
  it('the live profile-creation paths are exactly the two expected, and none writes member_type', () => {
    const creators = execSync(
      "grep -rlnE \"from\\('profiles'\\)\\s*\\.\\s*(insert|upsert)\\(\" --include='*.ts' --include='*.tsx' app lib components 2>/dev/null | grep -v __tests__ || true",
      { encoding: 'utf8' },
    ).split('\n').filter(Boolean).sort()

    expect(creators).toEqual(['app/actions.ts', 'app/api/profile/initialize/route.ts'])

    for (const f of creators) {
      expect(readFileSync(f, 'utf8'), `${f} writes member_type`)
        .not.toMatch(/\.(insert|update|upsert)\([\s\S]{0,20}\{[^}]*member_type/)
    }
  })

  it('profile editing still cannot accept member_type — the allowlist is unchanged', () => {
    const payload = readFileSync('lib/profile/updatePayload.ts', 'utf8')
    expect(payload).not.toContain('member_type')
    // Enumerated allowlist, not a spread: an unknown FormData key cannot reach the write.
    expect(payload).toMatch(/if \(has\('title'\)\) payload\.title =/)
    expect(payload).not.toMatch(/Object\.assign|\.\.\.(body|formData|raw|input)/)
  })

  it('no admin or community bypass was introduced anywhere', () => {
    const changed = execSync("git diff --name-only origin/main -- 'app/*' 'lib/*' || true", { encoding: 'utf8' })
      .split('\n').filter(Boolean).filter((f) => !f.includes('__tests__'))
    expect(changed).toEqual(['lib/db/migrationHealth.ts'])
  })
})
