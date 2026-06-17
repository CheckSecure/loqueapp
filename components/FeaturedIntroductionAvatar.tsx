'use client'

import { useState } from 'react'
import { ProfilePhotoLightbox } from '@/components/ProfilePhotoLightbox'

interface Props {
  id: string
  name?: string | null
  src?: string | null
}

function initialsFrom(name?: string | null): string {
  if (!name) return '?'
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?'
}

function hashToHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0
  }
  return h % 360
}

function gradientFromId(id: string): string {
  const h = hashToHue(id || 'default')
  const h2 = (h + 40) % 360
  return `linear-gradient(135deg, hsl(${h}, 55%, 55%), hsl(${h2}, 45%, 42%))`
}

export default function FeaturedIntroductionAvatar({ id, name, src }: Props) {
  const [open, setOpen] = useState(false)
  const sizeBox = 'w-32 h-32 sm:w-36 sm:h-36'
  const frame = 'rounded-full overflow-hidden ring-[3px] ring-brand-gold/25 shadow-[0_8px_28px_rgba(15,28,58,0.14)]'

  if (src) {
    return (
      <>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen(true) }}
          aria-label={name ? `View ${name}'s profile photo` : 'View profile photo'}
          className={`${sizeBox} ${frame} cursor-pointer transition hover:ring-brand-gold/45 focus-visible:outline-none focus-visible:ring-brand-navy/40`}
        >
          <img src={src} alt={name ?? 'Member'} className="w-full h-full object-cover" />
        </button>
        {open && (
          <ProfilePhotoLightbox src={src} name={name} onClose={() => setOpen(false)} />
        )}
      </>
    )
  }

  return (
    <div
      className={`${sizeBox} ${frame} flex items-center justify-center text-white text-3xl font-bold tracking-tight`}
      style={{ background: gradientFromId(id) }}
      aria-label={name ?? 'User avatar'}
    >
      {initialsFrom(name)}
    </div>
  )
}
