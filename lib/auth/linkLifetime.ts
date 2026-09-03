/**
 * How long a Supabase email link lives, in prose, for the person reading it.
 *
 * ONE STRING FOR THE WHOLE APP, because the number is NOT ours to set. Invitations, resends and
 * password resets all land on supabase.auth.verifyOtp({token_hash}), so their lifetime is a single
 * project-level setting — the Email OTP expiry (MAILER_OTP_EXP) in the Supabase dashboard. It is
 * not a value in this repo, and generateLink accepts no expiry option, so nothing here can read it
 * back. Every place that tells someone how long they have is therefore an ASSERTION about that
 * dashboard, and the only way to keep those assertions honest is to have exactly one of them.
 *
 * WHEN THE DASHBOARD SETTING CHANGES, CHANGE THIS LINE AND NOTHING ELSE.
 *
 * This module exists because that is precisely what went wrong: the invite email, the reset-password
 * page and RECOVERY_MESSAGES each stated the duration independently, so raising the expiry from one
 * hour to eight left two of them quietly lying to the people most likely to be reading them — the
 * ones who just hit a dead link.
 *
 * Deliberately dependency-free so a client component can import it without pulling anything in.
 */
export const AUTH_LINK_LIFETIME_PROSE = 'about 8 hours'

/** The shared "why this died" sentence, for surfaces that explain an already-expired link. */
export const AUTH_LINK_EXPIRY_NOTE =
  `Links are single-use and expire ${AUTH_LINK_LIFETIME_PROSE} after they are sent.`
