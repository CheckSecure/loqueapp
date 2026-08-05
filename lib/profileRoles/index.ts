// Additional roles & affiliations — the data-access + validation layer for the
// `profile_roles` table (migration 042).
//
// ISOLATION GUARANTEE: this module reads/writes ONLY `profile_roles`. It never
// touches profiles.company / role_type / seniority / title, so a member's primary
// identity, same-company exclusion, business-solution class, matching, and profile
// completion are all unaffected by additional roles.
//
// FAIL-OPEN: every operation degrades gracefully if migration 042 has not been
// applied yet (missing table) — reads return [], writes return a handled error —
// so profile/admin pages never crash pre-migration.

import { isMissingColumnError } from '@/lib/db/isMissingColumn'

export const ROLE_CATEGORIES = [
  'primary_employment',
  'board_member',
  'advisor',
  'professional_association',
  'committee_leadership',
  'investor_fund',
  'academic',
  'government_policy',
  'nonprofit',
  'other',
] as const
export type RoleCategory = (typeof ROLE_CATEGORIES)[number]

/** Human labels for the categories (UI + admin display). */
export const ROLE_CATEGORY_LABELS: Record<RoleCategory, string> = {
  primary_employment: 'Primary employment',
  board_member: 'Board member',
  advisor: 'Advisor',
  professional_association: 'Professional association',
  committee_leadership: 'Committee leadership',
  investor_fund: 'Investor / fund',
  academic: 'Academic',
  government_policy: 'Government / policy',
  nonprofit: 'Nonprofit',
  other: 'Other',
}

export const MAX_ORG_LEN = 120
export const MAX_TITLE_LEN = 120
export const MAX_INDUSTRY_LEN = 80
export const MAX_DESCRIPTION_LEN = 500
/** Belt-and-suspenders cap on how many additional roles one member may hold. */
export const MAX_ROLES_PER_PROFILE = 25

export interface ProfileRole {
  id: string
  profile_id: string
  organization_name: string
  organization_id: string | null
  title: string | null
  role_category: RoleCategory
  industry: string | null
  is_current: boolean
  is_primary: boolean
  description: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface RoleInput {
  organization_name?: unknown
  title?: unknown
  role_category?: unknown
  industry?: unknown
  is_current?: unknown
  description?: unknown
}

export interface NormalizedRole {
  organization_name: string
  title: string | null
  role_category: RoleCategory
  industry: string | null
  is_current: boolean
  description: string | null
}

const clean = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * Validate + normalize a submitted role. Rejects a blank organization and an
 * invalid category; trims/collapses whitespace; caps field lengths. Pure — the
 * exact rules are unit-tested and shared by every write path.
 */
export function normalizeRole(
  input: RoleInput,
): { ok: true; value: NormalizedRole } | { ok: false; error: string } {
  const organization_name = clean(input.organization_name, MAX_ORG_LEN)
  if (!organization_name) return { ok: false, error: 'Organization is required.' }

  const role_category = String(input.role_category ?? '').trim()
  if (!ROLE_CATEGORIES.includes(role_category as RoleCategory)) {
    return { ok: false, error: 'Please choose a valid role category.' }
  }

  const title = clean(input.title, MAX_TITLE_LEN) || null
  const industry = clean(input.industry, MAX_INDUSTRY_LEN) || null
  const description = clean(input.description, MAX_DESCRIPTION_LEN) || null
  // Default to current unless explicitly false-ish.
  const is_current = !(input.is_current === false || input.is_current === 'false' || input.is_current === 'past')

  return { ok: true, value: { organization_name, title, role_category: role_category as RoleCategory, industry, is_current, description } }
}

const ROLE_COLS =
  'id, profile_id, organization_name, organization_id, title, role_category, industry, is_current, is_primary, description, sort_order, created_at, updated_at'

/** Is this a "table not in schema yet" error (migration 042 pending)? */
function isMissingTable(error: any): boolean {
  return isMissingColumnError(error) // matches 42P01 / PGRST205 / "schema cache"
}

export interface RoleResult {
  ok: boolean
  status: number
  role?: ProfileRole
  error?: string
  /** false when the table is missing (migration 042 pending) — fail-open signal. */
  persisted?: boolean
}

/** List a member's additional roles, ordered. Fail-open → [] if the table is missing. */
export async function listRoles(db: any, profileId: string): Promise<ProfileRole[]> {
  const { data, error } = await db
    .from('profile_roles')
    .select(ROLE_COLS)
    .eq('profile_id', profileId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) {
    if (!isMissingTable(error)) console.error('[profileRoles] list error:', error.message)
    return []
  }
  return (data ?? []) as ProfileRole[]
}

/**
 * List roles for MANY members in ONE query (no N+1), grouped by profile_id.
 * Fail-open → {} if the table is missing. Used by the admin members view.
 */
export async function listRolesForProfiles(
  db: any,
  profileIds: string[],
): Promise<Record<string, ProfileRole[]>> {
  const out: Record<string, ProfileRole[]> = {}
  if (profileIds.length === 0) return out
  const { data, error } = await db
    .from('profile_roles')
    .select(ROLE_COLS)
    .in('profile_id', profileIds)
    .order('sort_order', { ascending: true })
  if (error) {
    if (!isMissingTable(error)) console.error('[profileRoles] bulk list error:', error.message)
    return out
  }
  for (const r of (data ?? []) as ProfileRole[]) {
    ;(out[r.profile_id] ||= []).push(r)
  }
  return out
}

/** Create an additional role for a member. Always is_primary=false in v1. */
export async function createRole(db: any, profileId: string, input: RoleInput): Promise<RoleResult> {
  const norm = normalizeRole(input)
  if (!norm.ok) return { ok: false, status: 400, error: norm.error }

  // Bound the number of roles (single count query — no N+1).
  const { count } = await db
    .from('profile_roles')
    .select('id', { count: 'exact', head: true })
    .eq('profile_id', profileId)
  if ((count ?? 0) >= MAX_ROLES_PER_PROFILE) {
    return { ok: false, status: 400, error: `You can add up to ${MAX_ROLES_PER_PROFILE} roles.` }
  }

  const nowIso = new Date().toISOString()
  const { data, error } = await db
    .from('profile_roles')
    .insert({
      profile_id: profileId,
      ...norm.value,
      is_primary: false, // v1: additional roles are never primary
      sort_order: (count ?? 0),
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select(ROLE_COLS)
    .single()
  if (error) {
    if (isMissingTable(error)) return { ok: false, status: 503, error: 'Additional roles are not available yet.', persisted: false }
    console.error('[profileRoles] create error:', error.message)
    return { ok: false, status: 500, error: 'Could not add the role. Please try again.' }
  }
  return { ok: true, status: 200, role: data as ProfileRole, persisted: true }
}

/** Update a member's own role (ownership enforced by the profile_id filter). */
export async function updateRole(db: any, profileId: string, roleId: string, input: RoleInput): Promise<RoleResult> {
  const norm = normalizeRole(input)
  if (!norm.ok) return { ok: false, status: 400, error: norm.error }

  const { data, error } = await db
    .from('profile_roles')
    .update({ ...norm.value, updated_at: new Date().toISOString() })
    .eq('id', roleId)
    .eq('profile_id', profileId) // ownership: a member can only touch their own rows
    .select(ROLE_COLS)
  if (error) {
    if (isMissingTable(error)) return { ok: false, status: 503, error: 'Additional roles are not available yet.', persisted: false }
    console.error('[profileRoles] update error:', error.message)
    return { ok: false, status: 500, error: 'Could not update the role. Please try again.' }
  }
  if (!data || data.length === 0) return { ok: false, status: 404, error: 'Role not found.' }
  return { ok: true, status: 200, role: data[0] as ProfileRole, persisted: true }
}

/** Delete a member's own role. Idempotent (deleting a gone row still returns ok). */
export async function deleteRole(db: any, profileId: string, roleId: string): Promise<RoleResult> {
  const { error } = await db
    .from('profile_roles')
    .delete()
    .eq('id', roleId)
    .eq('profile_id', profileId) // ownership
  if (error) {
    if (isMissingTable(error)) return { ok: false, status: 503, error: 'Additional roles are not available yet.', persisted: false }
    console.error('[profileRoles] delete error:', error.message)
    return { ok: false, status: 500, error: 'Could not delete the role. Please try again.' }
  }
  return { ok: true, status: 200, persisted: true }
}

/**
 * Reorder a member's roles. `orderedIds` is the desired order; sort_order is set
 * to the array index. Ownership-scoped; ignores ids not owned by the member.
 */
export async function reorderRoles(db: any, profileId: string, orderedIds: string[]): Promise<RoleResult> {
  // One ownership-scoped fetch, then bounded parallel updates (roles are few).
  const owned = await listRoles(db, profileId)
  const ownedIds = new Set(owned.map((r) => r.id))
  const toApply = orderedIds.filter((id) => ownedIds.has(id))
  const nowIso = new Date().toISOString()
  const results = await Promise.all(
    toApply.map((id, idx) =>
      db.from('profile_roles').update({ sort_order: idx, updated_at: nowIso }).eq('id', id).eq('profile_id', profileId),
    ),
  )
  const failed = results.find((r: any) => r?.error)
  if (failed?.error) {
    if (isMissingTable(failed.error)) return { ok: false, status: 503, error: 'Additional roles are not available yet.', persisted: false }
    console.error('[profileRoles] reorder error:', failed.error.message)
    return { ok: false, status: 500, error: 'Could not reorder roles. Please try again.' }
  }
  return { ok: true, status: 200, persisted: true }
}

// ── Admin data-quality helpers (pure) ────────────────────────────────────────
export interface RoleQualityFlags {
  hasBlankOrg: boolean
  hasInvalidCategory: boolean
  duplicateOrganizations: string[]
  multiplePrimary: boolean
}

/** Compute read-only data-quality flags for a member's roles (admin display). */
export function roleQualityFlags(roles: ProfileRole[]): RoleQualityFlags {
  const seen = new Map<string, number>()
  for (const r of roles) {
    const k = (r.organization_name || '').trim().toLowerCase()
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  return {
    hasBlankOrg: roles.some((r) => !(r.organization_name || '').trim()),
    hasInvalidCategory: roles.some((r) => !ROLE_CATEGORIES.includes(r.role_category)),
    duplicateOrganizations: Array.from(seen.entries()).filter(([, n]) => n > 1).map(([k]) => k),
    multiplePrimary: roles.filter((r) => r.is_primary).length > 1,
  }
}
