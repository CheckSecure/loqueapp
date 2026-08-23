/**
 * Browser-safe resume copy. Deliberately a separate module with NO Node imports.
 *
 * The resume PAGE is a client component and needs this string; resumeToken.ts imports node:crypto.
 * Importing the constant from there dragged node:crypto into the client bundle and broke the build —
 * which is the build catching a real mistake, not an inconvenience: a module that mints tokens has
 * no business being reachable from browser code at all. The split keeps that boundary explicit.
 */

/** Every request gets this text. Success and every failure are indistinguishable to the caller. */
export const RESUME_GENERIC_RESPONSE =
  'If this invitation is still open, we have sent a secure sign-in link to the email address it was issued to. Please check your inbox.'
