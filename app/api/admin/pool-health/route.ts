import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadPoolHealth } from '@/lib/introductions/poolHealth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Read-only recommendation candidate-pool health (tiered introduction-history
 * model). Surfaces each member's fresh pool size, HARD / SOFT exclusion counts,
 * artifact rows ignored, how many members sit below the 20/15/10/5 thresholds,
 * and whether the exhaustion safety valve engaged for anyone. Use this to watch
 * for approaching exhaustion BEFORE enabling RECOMMENDATION_EXHAUSTION_THRESHOLD.
 * Admin-only.
 */
export async function GET() {
  const { error } = await requireAdmin()
  if (error) return error

  const admin = createAdminClient()
  const report = await loadPoolHealth(admin)
  if (report.membersBelowThreshold[10] > 0 || report.valve.activatedMembers > 0) {
    console.warn(`[pool-health] ${report.membersBelowThreshold[10]} members below 10 candidates; valve activated for ${report.valve.activatedMembers}`)
  }
  return NextResponse.json(report, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } })
}
