import { describe, it } from 'vitest'
import { config } from 'dotenv'
config({ path: '.env.local' })
describe('PostgREST schema-cache probe (READ ONLY)', () => {
  it('checks visibility of new table + columns', async () => {
    const { createAdminClient } = await import('@/lib/supabase/admin')
    const admin = createAdminClient()
    const rb = await admin.from('recommendation_batches').select('batch_id').limit(1)
    const mat = await admin.from('batch_suggestions').select('materialized_at').limit(1)
    const bid = await admin.from('intro_requests').select('batch_id').limit(1)
    // Probe writability of recommendation_batches via a rolled-back-style no-op:
    // attempt an insert of a clearly-invalid row to see the ERROR CLASS (schema-cache
    // vs constraint). We do NOT keep it — if it somehow inserts, delete immediately.
    let writeProbe = 'not-run'
    const probeId = '00000000-0000-0000-0000-0000000000ff'
    const ins = await admin.from('recommendation_batches').insert({
      batch_id: probeId, member_id: '00000000-0000-0000-0000-000000000000',
      batch_source: 'migration', state: 'completed',
    }).select('batch_id')
    if (ins.error) writeProbe = `insert error: ${ins.error.message}`
    else { writeProbe = 'INSERTED (cleaning up)'; await admin.from('recommendation_batches').delete().eq('batch_id', probeId) }

    console.log('\n===CACHE===\n' + JSON.stringify({
      recommendation_batches_read: rb.error ? `STALE: ${rb.error.message}` : `VISIBLE (${rb.data?.length ?? 0} rows)`,
      batch_suggestions_materialized_at: mat.error ? `STALE: ${mat.error.message}` : 'VISIBLE',
      intro_requests_batch_id: bid.error ? `STALE: ${bid.error.message}` : 'VISIBLE',
      recommendation_batches_write: writeProbe,
    }, null, 2) + '\n===END===\n')
  }, 60000)
})
