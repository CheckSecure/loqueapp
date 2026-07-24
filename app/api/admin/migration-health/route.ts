import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkMigrationHealth } from '@/lib/db/migrationHealth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Read-only schema/migration health. Reports any migration the current code
 * expects that has not been applied to the connected database (compatibility
 * mode). Admin-only. Surfaces the same data the dashboard banner renders.
 */
export async function GET() {
  const { error } = await requireAdmin()
  if (error) return error

  const admin = createAdminClient()
  const health = await checkMigrationHealth(admin)
  if (!health.ok) {
    console.warn(`[migration-health] ${health.pending.length} pending: ${health.pending.map((p) => p.migration).join(', ')}`)
  }
  return NextResponse.json(health, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  })
}
