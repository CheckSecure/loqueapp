/**
 * Company metadata FALLBACK store (admin-editable, DB-backed).
 *
 * The lowest-precedence source of description/industry/headquarters/logo — used
 * only when neither an existing `companies` value nor a fresh homepage scrape
 * produced one. Replaces the former in-code fallback content. See
 * supabase/migrations/015_company_metadata.sql.
 *
 * DEPLOY-SAFE: every function no-ops cleanly if the table isn't applied yet
 * (PGRST205 / "does not exist"), so the pipeline degrades to "scrape or null".
 */

export type CompanyMetadata = {
  description?: string | null
  industry?: string | null
  headquarters?: string | null
  logo_url?: string | null
}

const ABSENT = /PGRST205|schema cache|does not exist|relation .* does not exist/i

/** Read the curated fallback for a slug. Returns {} when absent/unavailable. */
export async function getCompanyMetadata(admin: any, slug: string): Promise<CompanyMetadata> {
  if (!slug) return {}
  try {
    const { data, error } = await admin
      .from('company_metadata')
      .select('description, industry, headquarters, logo_url')
      .eq('slug', slug)
      .maybeSingle()
    if (error) {
      if (!ABSENT.test(`${error.message} ${error.code}`)) {
        console.error('[company-metadata] read failed:', error.message)
      }
      return {}
    }
    return data || {}
  } catch {
    return {}
  }
}

/** Upsert curated fallback metadata for a slug (admin action). */
export async function upsertCompanyMetadata(
  admin: any,
  slug: string,
  fields: CompanyMetadata,
  editor?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!slug) return { ok: false, error: 'slug required' }
  // Only persist provided keys; empty string clears a field.
  const row: Record<string, unknown> = { slug, updated_at: new Date().toISOString(), updated_by: editor ?? null }
  for (const k of ['description', 'industry', 'headquarters', 'logo_url'] as const) {
    if (k in fields) row[k] = (fields[k] ?? '').toString().trim() || null
  }
  try {
    const { error } = await admin.from('company_metadata').upsert(row, { onConflict: 'slug' })
    if (error) {
      if (ABSENT.test(`${error.message} ${error.code}`)) return { ok: false, error: 'company_metadata table not applied (migration 015)' }
      return { ok: false, error: error.message }
    }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'upsert_failed' }
  }
}
