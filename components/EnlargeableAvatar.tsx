'use client'

import { useState, type ReactNode } from 'react'
import { ProfilePhotoLightbox } from '@/components/ProfilePhotoLightbox'

interface EnlargeableAvatarProps {
  src: string | null | undefined
  name?: string | null
  children: ReactNode
  className?: string
}

// Thin click-to-enlarge wrapper for surfaces that already render their own
// inline <img> (or initials fallback). When src is truthy, wraps children
// in a button that opens ProfilePhotoLightbox. When src is falsy (initials
// fallback), renders children unwrapped — initials are never clickable.
export function EnlargeableAvatar({ src, name, children, className = '' }: EnlargeableAvatarProps) {
  const [open, setOpen] = useState(false)

  if (!src) {
    return <>{children}</>
  }

  return (
    <>
      <button
        type="button"
        // stopPropagation so parent cards with onClick (e.g., NetworkCard's row
        // navigation) don't fire alongside the lightbox open.
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        aria-label={name ? `View ${name}'s profile photo` : 'View profile photo'}
        className={`rounded-full cursor-pointer transition hover:ring-2 hover:ring-brand-navy/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/30 ${className}`}
      >
        {children}
      </button>
      {open && (
        <ProfilePhotoLightbox
          src={src}
          name={name}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
