import Link from 'next/link'
import { professionalIdentity, displayTitle, type ProfessionalIdentityInput } from '@/lib/professionalIdentity'
import { isLinkableCompany } from '@/lib/company/slug'
import CompanyLink from '@/components/CompanyLink'
import CompanyLogo from '@/components/CompanyLogo'

/**
 * Single source of truth for rendering a member's professional-identity line
 * with the COMPANY NAME as a clickable link (only the name — not the title).
 * Placeholder companies (Independent / Stealth / Confidential / blank) render as
 * plain text. Returns inline content, so callers keep their own wrapper element
 * and icon.
 *
 * Client-safe (pure helpers + next/link), so it works in server components and
 * inside 'use client' components (NetworkCard, ConnectionDetailModal, Messages).
 *
 * `guardCardClick` wraps the link in a `data-card-action` span so that, inside a
 * click-to-open card (NetworkCard), clicking the company navigates to the
 * company page instead of also triggering the card's open handler.
 *
 * OPTIONAL `company` — the canonical joined company (profiles.company_id →
 * companies). When provided WITH a slug, the company link also shows the company
 * logo (fixed size, initials fallback) and links to /company/{slug}. Only the full
 * profile passes this; every other caller omits it and keeps the exact free-text
 * behavior below. Never inferred/guessed — absent company_id → no logo, no change.
 */
export default function IdentityLine({
  profile,
  linkClassName = 'font-semibold text-brand-navy hover:text-brand-gold hover:underline underline-offset-2 transition-colors',
  guardCardClick = false,
  company,
}: {
  profile: ProfessionalIdentityInput | null | undefined
  linkClassName?: string
  guardCardClick?: boolean
  company?: { name?: string | null; slug?: string | null; logo_url?: string | null } | null
}) {
  const p = profile || {}
  const identity = professionalIdentity(p)

  if (isLinkableCompany(p.company)) {
    const title = displayTitle(p)
    const name = (p.company || '').trim()

    // Canonical company available → logo + name in ONE link to /company/{slug}.
    // Both the logo and the name are inside the link (both clickable, one focus
    // target). Falls through to the free-text CompanyLink when no canonical slug.
    const link = company?.slug ? (
      <Link href={`/company/${company.slug}`} className={`inline-flex items-center gap-1 align-middle ${linkClassName}`}>
        <CompanyLogo url={company.logo_url} name={company.name || name} size={22} />
        {company.name || name}
      </Link>
    ) : (
      <CompanyLink company={p.company} className={linkClassName}>
        {name}
      </CompanyLink>
    )

    return (
      <>
        {title ? `${title} at ` : ''}
        {guardCardClick ? <span data-card-action>{link}</span> : link}
      </>
    )
  }

  return <>{identity.primary || ''}</>
}
