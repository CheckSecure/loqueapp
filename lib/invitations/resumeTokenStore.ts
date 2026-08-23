import { mintResumeToken, buildResumeLink } from './resumeToken'

/**
 * Persistence for resume tokens. One place, so every insert binds an auth identity and stores only
 * a digest.
 *
 * An unbound token (auth_user_id NULL) could never be invalidated by profile completion — the claim
 * function's completion check would match no row. The column is NOT NULL in migration 078 and this
 * module is the only thing that writes it, so that failure mode is unrepresentable rather than
 * merely avoided.
 *
 * The plaintext exists inside these functions and in the returned link, and nowhere else. It is
 * never persisted, logged, returned to a browser, or placed in a query string.
 */
export async function mintBoundResumeLink(
  admin: any,
  args: { waitlistId: string; authUserId: string; siteUrl: string },
): Promise<{ link: string; tokenId: string } | null> {
  if (!args.waitlistId || !args.authUserId) return null
  const { token, tokenSha256 } = mintResumeToken()
  const { data, error } = await admin
    .from('invitation_resume_tokens')
    .insert({
      waitlist_id: args.waitlistId,
      auth_user_id: args.authUserId,          // NOT NULL — completion must be able to invalidate it
      token_sha256: `\\x${tokenSha256.toString('hex')}`,
    })
    .select('id')
    .maybeSingle()
  if (error || !data?.id) return null          // fail closed: no row, no link
  return { link: buildResumeLink(args.siteUrl, token), tokenId: data.id }
}

/**
 * Revoke one token. Used when a provider send DEFINITIVELY failed, so the plaintext reached nobody
 * and the row would otherwise be an orphan capability. Never called for an uncertain outcome — the
 * message may have arrived, and killing a link sitting in someone's inbox is the worse error.
 */
export async function revokeResumeToken(admin: any, tokenId: string): Promise<boolean> {
  const { error } = await admin
    .from('invitation_resume_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', tokenId)
    .is('revoked_at', null)
  return !error
}
