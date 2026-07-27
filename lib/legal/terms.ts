/**
 * Single source of truth for the Terms of Service version + effective date.
 *
 * Bump TERMS_VERSION (and TERMS_EFFECTIVE_DATE) whenever the Terms materially
 * change. The /terms page renders these so the published version and effective
 * date are always in lockstep with this constant, and any future acceptance-
 * capture flow can record TERMS_VERSION against a user without duplicating the
 * date anywhere else.
 *
 * Keep this deliberately minimal — one version string, one human-readable date.
 */
export const TERMS_VERSION = '2026-07-27'

/** Human-readable effective date shown on the Terms page. */
export const TERMS_EFFECTIVE_DATE = 'July 27, 2026'
