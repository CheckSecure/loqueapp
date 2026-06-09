'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'

interface ProfilePhotoLightboxProps {
  src: string
  name?: string | null
  onClose: () => void
}

// Image-focused lightbox overlay. Backdrop click, Escape, and the close
// button all dismiss. Body scroll is locked while open. z-[60] sits above
// existing z-50 form modals so it can't get clipped.
export function ProfilePhotoLightbox({ src, name, onClose }: ProfilePhotoLightboxProps) {
  useEffect(() => {
    // capture: true + stopPropagation so an underlying modal's keydown handler
    // (e.g., ConnectionDetailModal's Escape→onClose) doesn't also fire when the
    // lightbox is open. User dismisses lightbox; underlying modal stays open.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name ? `${name}'s profile photo` : 'Profile photo'}
      onClick={onClose}
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative max-w-md w-full"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-white shadow-md flex items-center justify-center hover:bg-slate-100 transition-colors"
        >
          <X className="w-4 h-4 text-slate-700" />
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={name ?? 'Profile photo'}
          className="w-full aspect-square rounded-2xl object-cover bg-slate-100 shadow-lg"
        />
        {name && (
          <p className="mt-3 text-center text-white text-sm font-medium">
            {name}
          </p>
        )}
      </div>
    </div>
  )
}
