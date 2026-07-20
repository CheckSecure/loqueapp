import { professionalIdentity, displayTitle, type ProfessionalIdentityInput } from '@/lib/professionalIdentity'
import { isLinkableCompany } from '@/lib/company/slug'
import CompanyLink from '@/components/CompanyLink'

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
 */
export default function IdentityLine({
  profile,
  linkClassName = 'font-semibold text-brand-navy hover:text-brand-gold hover:underline underline-offset-2 transition-colors',
  guardCardClick = false,
}: {
  profile: ProfessionalIdentityInput | null | undefined
  linkClassName?: string
  guardCardClick?: boolean
}) {
  const p = profile || {}
  const identity = professionalIdentity(p)

  if (isLinkableCompany(p.company)) {
    const title = displayTitle(p)
    const company = (p.company || '').trim()
    const link = (
      <CompanyLink company={p.company} className={linkClassName}>
        {company}
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
