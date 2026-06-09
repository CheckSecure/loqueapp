'use client';

import { useState } from 'react';
import { ProfilePhotoLightbox } from '@/components/ProfilePhotoLightbox';

/**
 * Avatar — photo or deterministic gradient fallback.
 *
 * If the user has an avatar_url, renders it as a circular image.
 * Otherwise, renders initials on a gradient background derived from the user's
 * stable ID. The same ID always produces the same gradient, so avatars feel
 * consistent across sessions.
 *
 * Sizes follow a scale tuned for Andrel's card hierarchy:
 *   - sm (32px):  inline lists, compact rows
 *   - md (48px):  standard card headers
 *   - lg (64px):  featured card headers (introductions, detail surfaces)
 *   - xl (96px):  profile pages
 *
 * Opt-in `enlargeable`: when true AND an image src is provided, clicking the
 * avatar opens a centered ProfilePhotoLightbox. Initials-only avatars are
 * never clickable, regardless of the flag.
 */

type Size = 'sm' | 'md' | 'lg' | 'xl';

interface AvatarProps {
  id: string;
  name?: string | null;
  src?: string | null;
  size?: Size;
  className?: string;
  enlargeable?: boolean;
}

const SIZE_CONFIG: Record<Size, { box: string; text: string }> = {
  sm: { box: 'w-8 h-8', text: 'text-xs' },
  md: { box: 'w-12 h-12', text: 'text-sm' },
  lg: { box: 'w-16 h-16', text: 'text-base' },
  xl: { box: 'w-24 h-24', text: 'text-2xl' },
};

function hashToHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

function initialsFrom(name?: string | null): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

function gradientFromId(id: string): string {
  const h = hashToHue(id || 'default');
  const h2 = (h + 40) % 360;
  return `linear-gradient(135deg, hsl(${h}, 55%, 55%), hsl(${h2}, 45%, 42%))`;
}

export function Avatar({ id, name, src, size = 'md', className = '', enlargeable = false }: AvatarProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const { box, text } = SIZE_CONFIG[size];
  const base = `${box} rounded-full flex-shrink-0 overflow-hidden ${className}`;

  if (src) {
    const img = (
      <img
        src={src}
        alt={name ?? 'User'}
        className={`${base} object-cover`}
      />
    );
    if (enlargeable) {
      return (
        <>
          <button
            type="button"
            // stopPropagation so parent cards with onClick (e.g., IntroductionCard
            // row navigation) don't fire alongside the lightbox open.
            onClick={(e) => { e.stopPropagation(); setLightboxOpen(true); }}
            aria-label={name ? `View ${name}'s profile photo` : 'View profile photo'}
            className="rounded-full cursor-pointer transition hover:ring-2 hover:ring-brand-navy/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/30"
          >
            {img}
          </button>
          {lightboxOpen && (
            <ProfilePhotoLightbox
              src={src}
              name={name}
              onClose={() => setLightboxOpen(false)}
            />
          )}
        </>
      );
    }
    return img;
  }

  const initials = initialsFrom(name);
  const background = gradientFromId(id);

  return (
    <div
      className={`${base} ${text} flex items-center justify-center font-semibold text-white`}
      style={{ background }}
      aria-label={name ?? 'User avatar'}
    >
      {initials}
    </div>
  );
}
