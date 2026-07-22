import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildBackfillReport } from '@/lib/introductions/migration-backfill'

export const dynamic = 'force-dynamic'

/**
 * DRY-RUN report for the Unified Recommendation Queue migration. READ-ONLY — it
 * never writes. Returns the JSON the operator reviews before approving the schema
 * migration + production backfill: member counts, visible-recommendation
 * distribution, recommendations that would be discarded, and admin batches that
 * would materialize. Auth-gated to the admin account.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== 'bizdev91@gmail.com') {
    return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
  }
  try {
    const report = await buildBackfillReport(createAdminClient())
    return NextResponse.json({ dryRun: true, generatedAt: new Date().toISOString(), report })
  } catch (err: any) {
    return NextResponse.json({ error: err.message, hint: 'Apply migration 020 (recommendation_batches) first.' }, { status: 500 })
  }
}
