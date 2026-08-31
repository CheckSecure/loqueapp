/**
 * HTML escaping for email bodies.
 *
 * Lives in its own module so the pure email BUILDERS can use it without importing lib/email.ts,
 * which constructs the Resend client at module load and therefore needs an API key just to be
 * imported. A builder that cannot be imported without a provider key is not actually pure, and
 * cannot be unit-tested or previewed.
 *
 * The em-dash for an empty value is long-standing behaviour across every existing template and is
 * preserved exactly: callers rely on it to render a placeholder rather than an empty cell.
 */
export function escapeHtml(s: string | null | undefined): string {
  if (!s) return '—'
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
