import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { auditMissingProvisioning, reconcileMissingProvisioning } from '@/lib/provisioning'

export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

async function requireAdmin() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return !!user && user.email === ADMIN_EMAIL
}

/**
 * GET — audit only (no mutation). Returns every waitlist-backed account missing a profile
 * or credit balance, with the recommended repair action. Use this as the standing report.
 */
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
  try {
    const affected = await auditMissingProvisioning(createAdminClient())
    return NextResponse.json({ audited: affected.length, affected })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'audit failed' }, { status: 500 })
  }
}

/**
 * POST — reconcile (idempotent repair). Body:
 *   { dryRun?: boolean, emails?: string[] }
 * `emails` restricts the repair to a reviewed subset; omit to repair all affected accounts.
 * Safe to run repeatedly — provisioning converges and never duplicates records.
 */
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
  try {
    const body = await req.json().catch(() => ({}))
    const dryRun = body?.dryRun === true
    const emails = Array.isArray(body?.emails) ? body.emails.filter((e: unknown) => typeof e === 'string') : undefined
    const outcome = await reconcileMissingProvisioning(createAdminClient(), { dryRun, emails })
    return NextResponse.json(outcome)
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'reconcile failed' }, { status: 500 })
  }
}
