/**
 * Durable record of an account deletion, for the paths that CANNOT be atomic.
 *
 * ─── WHY THIS FILE EXISTS SEPARATELY FROM THE SQL ─────────────────────────────────────────────
 * public.delete_user_account() removes the auth identity with `DELETE FROM auth.users` — plain SQL
 * inside the caller's transaction — so on that path the ledger write, the row deletions and the
 * auth deletion genuinely commit or roll back together. Migration 075 does that in SQL and needs
 * nothing from here.
 *
 * The admin paths are different and no amount of care makes them the same. `admin.auth.admin
 * .deleteUser()` is an HTTP call to the Supabase Auth API. It is not in the database transaction,
 * it cannot be rolled back, and it can succeed while the process dies before anything records it.
 * There is NO atomicity to be had across an HTTP boundary and a PostgreSQL transaction, and
 * claiming otherwise would be false.
 *
 * So this path uses a state machine written as APPEND-ONLY EVENTS instead:
 *
 *     requested ──▶ data_deleted ──▶ auth_deleted        (complete)
 *          │              │
 *          └──────────────┴───────▶ failed               (needs operator attention)
 *
 * Each transition is its own INSERT sharing a deletion_id, which is what lets the ledger stay
 * strictly append-only — advancing the state never requires UPDATE, so the immutability guarantee
 * is never relaxed to make room for progress.
 *
 * WHAT A CRASH LEAVES BEHIND, precisely:
 *   • crash before `requested`      — nothing was deleted yet; no record needed and none exists.
 *   • crash after `requested`       — a durable record that a deletion was ATTEMPTED, with no
 *                                     completion event. That is the state an operator can find and
 *                                     reconcile. It is exactly what was missing when a member
 *                                     disappeared and nothing could say what had happened.
 *   • crash after `data_deleted`    — the same, one stage further along: rows are gone, the auth
 *                                     identity may or may not be. Visible and actionable.
 *
 * A ledger row is therefore evidence of an ATTEMPT, never proof of a completed deletion. Only an
 * `auth_deleted` event means finished. Reading a missing terminal event as "probably fine" is the
 * mistake this design exists to prevent.
 */

export type DeletionStage = 'requested' | 'data_deleted' | 'auth_deleted' | 'failed'
export type ActorCategory = 'self' | 'admin' | 'system'
export type DeletionPath = 'self_service_rpc' | 'admin_invite_revoke' | 'admin_manage_link' | 'other'
export type ReasonCategory =
  | 'member_request' | 'invitation_revoked' | 'never_onboarded'
  | 'policy_enforcement' | 'duplicate_account' | 'unspecified'

/** Matches the database CHECK: lowercase, underscores, ≤40 chars. A CLASS, never a message. */
export type ErrorClass = 'auth_api_error' | 'timeout' | 'not_found' | 'db_error' | 'unknown'

/**
 * The one method this module needs. The service-role client is INJECTED rather than constructed
 * here: the caller already holds one, built with its own deadline/fetch configuration, and building
 * a second would both duplicate that configuration and fail in any context where the environment is
 * not populated. A narrow structural type keeps this testable without a Supabase instance.
 */
export interface LedgerClient {
  // Deliberately loose. supabase-js returns a thenable PostgrestFilterBuilder (not a bare Promise)
  // whose generics are keyed to a generated Database type this project does not carry, so a precise
  // signature would reject the real client. `await` is all this module needs from it.
  rpc(fn: string, params?: any, options?: any): PromiseLike<{ error: { code?: string } | null }>
}

export interface DeletionEvent {
  deletionId: string
  stage: DeletionStage
  actor: ActorCategory
  path: DeletionPath
  /** The subject's user id. Opaque, and deliberately not a foreign key — see migration 075. */
  deletedUserId?: string | null
  reason?: ReasonCategory
  /** Aggregate integer counts ONLY. The database rejects anything else. */
  counts?: Record<string, number>
  errorClass?: ErrorClass
}

/**
 * Writes one ledger event. Returns whether it was durably recorded.
 *
 * NEVER THROWS. Callers decide what a failure means, and the two answers are different:
 *   • before deleting anything → a false return MUST abort the deletion (fail closed).
 *   • after deleting           → a false return cannot un-delete; log loudly and continue.
 * Hiding that distinction behind a thrown exception is how a "safe" helper ends up either
 * blocking completion or silently losing the record.
 */
export async function recordDeletionEvent(client: LedgerClient, e: DeletionEvent): Promise<boolean> {
  try {
    const { error } = await client.rpc('record_account_deletion_event', {
      p_deletion_id: e.deletionId,
      p_stage: e.stage,
      p_actor_category: e.actor,
      p_deletion_path: e.path,
      p_deleted_user_id: e.deletedUserId ?? null,
      p_reason_category: e.reason ?? null,
      p_object_counts: e.counts ?? null,
      p_error_class: e.errorClass ?? null,
    })
    if (error) {
      // The message may echo input, so only its shape is logged — never its text.
      console.error(JSON.stringify({
        event: 'deletion_ledger_write_failed',
        stage: e.stage, path: e.path, code: error.code ?? 'unknown',
      }))
      return false
    }
    return true
  } catch {
    // A transport-level throw (network, abort, a deadline signal firing) never reaches the caller as
    // an exception — it becomes a false, which the call site must treat as "do not proceed".
    console.error(JSON.stringify({ event: 'deletion_ledger_unavailable', stage: e.stage, path: e.path }))
    return false
  }
}

/**
 * Opens a deletion: captures actor and target and records the intent BEFORE anything is destroyed.
 *
 * Returns null when the record could not be written. A null return means DO NOT PROCEED — that is
 * the whole contract. The alternative is another deletion that leaves no trace, which is the defect
 * this exists to close.
 */
export async function openDeletion(
  client: LedgerClient,
  deletionId: string,
  input: Omit<DeletionEvent, 'deletionId' | 'stage' | 'errorClass'>,
): Promise<string | null> {
  const ok = await recordDeletionEvent(client, { ...input, deletionId, stage: 'requested' })
  return ok ? deletionId : null
}
