import type { ReactNode, HTMLAttributes } from 'react';

/**
 * Card — the shared container primitive for Andrel surfaces.
 *
 * Variants:
 *   - default:  white background, slate-100 border, subtle shadow. Standard.
 *   - premium:  same as default, plus a gold left accent. For featured content
 *               (e.g. curated opportunities, admin-introduced intros).
 *   - outlined: transparent background, slate-200 border, no shadow. For
 *               secondary content that shouldn't pull focus.
 *
 * All variants share rounded-2xl radius and p-6 padding.
 */

type Variant = 'default' | 'premium' | 'outlined';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: Variant;
  children: ReactNode;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  default:
    'bg-white border border-slate-100 shadow-sm',
  premium:
    'bg-white border border-slate-100 border-l-4 border-l-brand-gold shadow-sm',
  outlined:
    'bg-transparent border border-slate-200',
};

export function Card({
  variant = 'default',
  className = '',
  children,
  ...rest
}: CardProps) {
  const base = 'rounded-2xl p-6 transition-shadow';
  const variantClass = VARIANT_CLASSES[variant];
  return (
    <div className={`${base} ${variantClass} ${className}`} {...rest}>
      {children}
    </div>
  );
}
