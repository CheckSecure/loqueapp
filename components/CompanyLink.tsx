import Link from 'next/link'
import { companySlug, isLinkableCompany } from '@/lib/company/slug'

/**
 * Renders a company name as a link to its Company Context page — but only when
 * the name is a real, linkable company. Placeholders ("Independent", "Stealth",
 * "Confidential") and blanks render as plain text (or `children`), never a dead
 * link. Drop-in anywhere a company name appears.
 */
export default function CompanyLink({
  company,
  className,
  children,
}: {
  company?: string | null
  className?: string
  children?: React.ReactNode
}) {
  if (!isLinkableCompany(company)) {
    return <>{children ?? company ?? null}</>
  }
  return (
    <Link href={`/company/${companySlug(company)}`} className={className}>
      {children ?? company}
    </Link>
  )
}
