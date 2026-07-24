import { describe, it, expect } from 'vitest'
import {
  checkMigrationHealth,
  evaluateMigrationGate,
  migrationWarningMessage,
  probeExpectation,
  SCHEMA_EXPECTATIONS,
  type MigrationWarning,
  type SchemaExpectation,
} from '@/lib/db/migrationHealth'

// Minimal Supabase-query-builder stub: .from(table).select(col,{head}).limit()
// resolves to { error } per a table→error map.
function stubAdmin(errorsByTable: Record<string, { message: string; code?: string } | null>) {
  return {
    from(table: string) {
      const result = { error: errorsByTable[table] ?? null }
      const builder: any = {
        select: () => builder,
        limit: () => Promise.resolve(result),
      }
      return builder
    },
  }
}

const colExpect: SchemaExpectation = {
  migration: '024_enrichment_version.sql', kind: 'column', table: 'companies',
  column: 'enrichment_version', feature: 'x', impact: 'y',
}
const tableExpect: SchemaExpectation = {
  migration: '015_company_metadata.sql', kind: 'table', table: 'company_metadata', feature: 'x', impact: 'y',
}

describe('migrationWarningMessage', () => {
  it('produces the exact compatibility-mode message', () => {
    expect(migrationWarningMessage(colExpect)).toBe(
      'Database migration 024_enrichment_version.sql has not been applied. Running in compatibility mode.',
    )
  })
})

describe('probeExpectation', () => {
  it('present when the query succeeds', async () => {
    const admin = stubAdmin({ companies: null })
    expect(await probeExpectation(admin, colExpect)).toEqual({ present: true })
  })
  it('absent when the column does not exist', async () => {
    const admin = stubAdmin({ companies: { message: 'column companies.enrichment_version does not exist', code: '42703' } })
    expect((await probeExpectation(admin, colExpect)).present).toBe(false)
  })
  it('absent when the table is missing (PGRST205 / schema cache)', async () => {
    const admin = stubAdmin({ company_metadata: { message: 'Could not find the table in the schema cache', code: 'PGRST205' } })
    expect((await probeExpectation(admin, tableExpect)).present).toBe(false)
  })
  it('does not false-alarm on a transient/unknown error', async () => {
    const admin = stubAdmin({ companies: { message: 'fetch failed', code: '' } })
    expect((await probeExpectation(admin, colExpect)).present).toBe(true)
  })
})

describe('checkMigrationHealth', () => {
  it('ok when all expectations are satisfied', async () => {
    const admin = stubAdmin({ companies: null, company_metadata: null })
    const h = await checkMigrationHealth(admin)
    expect(h.ok).toBe(true)
    expect(h.pending).toHaveLength(0)
    expect(h.checked).toBe(SCHEMA_EXPECTATIONS.length)
  })

  it('flags exactly the unapplied migrations with messages', async () => {
    // 024 column missing; 015 table present.
    const admin = stubAdmin({
      companies: { message: 'column companies.enrichment_version does not exist', code: '42703' },
      company_metadata: null,
    })
    const h = await checkMigrationHealth(admin)
    expect(h.ok).toBe(false)
    expect(h.pending.map((p) => p.migration)).toEqual(['024_enrichment_version.sql'])
    expect(h.pending[0].message).toContain('024_enrichment_version.sql has not been applied')
  })

  it('flags multiple pending migrations', async () => {
    const admin = stubAdmin({
      companies: { message: 'column companies.enrichment_version does not exist', code: '42703' },
      company_metadata: { message: 'does not exist', code: 'PGRST205' },
    })
    const h = await checkMigrationHealth(admin)
    expect(h.pending).toHaveLength(2)
  })
})

describe('evaluateMigrationGate (deployment gate)', () => {
  const w = (migration: string): MigrationWarning => ({
    migration, kind: 'column', table: 't', feature: 'f', impact: 'i',
    message: migrationWarningMessage({ migration, kind: 'column', table: 't', feature: 'f', impact: 'i' }),
  })

  it('passes when nothing is pending', () => {
    const d = evaluateMigrationGate([], '')
    expect(d.pass).toBe(true)
    expect(d.blocking).toHaveLength(0)
  })

  it('blocks pending migrations when no compatibility mode is declared', () => {
    const d = evaluateMigrationGate([w('024_enrichment_version.sql')], undefined)
    expect(d.pass).toBe(false)
    expect(d.blocking.map((b) => b.migration)).toEqual(['024_enrichment_version.sql'])
  })

  it('waives everything when compatibility mode = all/1/true', () => {
    for (const spec of ['all', '1', 'true', 'ON']) {
      const d = evaluateMigrationGate([w('024_enrichment_version.sql'), w('015_company_metadata.sql')], spec)
      expect(d.pass).toBe(true)
      expect(d.waived).toHaveLength(2)
      expect(d.blocking).toHaveLength(0)
    }
  })

  it('waives only the explicitly listed migrations; others still block', () => {
    const d = evaluateMigrationGate(
      [w('024_enrichment_version.sql'), w('099_unexpected.sql')],
      '024_enrichment_version.sql',
    )
    expect(d.pass).toBe(false)
    expect(d.waived.map((x) => x.migration)).toEqual(['024_enrichment_version.sql'])
    expect(d.blocking.map((x) => x.migration)).toEqual(['099_unexpected.sql'])
  })

  it('passes when every pending migration is in the allow-list', () => {
    const d = evaluateMigrationGate(
      [w('024_enrichment_version.sql'), w('015_company_metadata.sql')],
      '024_enrichment_version.sql, 015_company_metadata.sql',
    )
    expect(d.pass).toBe(true)
    expect(d.blocking).toHaveLength(0)
  })
})
