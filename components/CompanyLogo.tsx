'use client'

import { useState } from 'react'
import { companyInitials } from '@/lib/company/slug'

/**
 * Company logo with a guaranteed-graceful fallback: if there's no URL, or the
 * image fails to load, it renders an elegant initials avatar instead of a
 * broken image.
 */
export default function CompanyLogo({
  url,
  name,
  size = 56,
}: {
  url?: string | null
  name: string
  size?: number
}) {
  const [failed, setFailed] = useState(false)

  if (url && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={name}
        onError={() => setFailed(true)}
        className="rounded-xl object-contain bg-white border border-slate-200/70"
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <div
      className="rounded-xl bg-brand-navy/[0.04] border border-slate-200/70 flex items-center justify-center text-brand-navy font-semibold flex-shrink-0"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}
      aria-label={name}
    >
      {companyInitials(name)}
    </div>
  )
}
