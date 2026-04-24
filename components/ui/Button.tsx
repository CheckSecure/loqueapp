import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

/**
 * Button — shared button primitive with four variants and three sizes.
 *
 * Variants:
 *   - primary:   navy background, white text. Main calls-to-action.
 *   - secondary: white background, navy border + text. Alternate actions.
 *   - ghost:     transparent, slate text. Tertiary actions, cancels.
 *   - danger:    red background, white text. Destructive actions only.
 *
 * Sizes:
 *   - sm: compact (px-3 py-1.5 text-sm)
 *   - md: standard (px-4 py-2.5 text-sm) — default
 *   - lg: prominent (px-6 py-3 text-base)
 *
 * All buttons share rounded-xl corners, font-medium weight, smooth transitions,
 * and disabled state opacity.
 */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    'bg-brand-navy text-white hover:bg-brand-navy-dark focus-visible:ring-2 focus-visible:ring-brand-gold focus-visible:ring-offset-2',
  secondary:
    'bg-white border border-brand-navy text-brand-navy hover:bg-brand-navy hover:text-white focus-visible:ring-2 focus-visible:ring-brand-gold focus-visible:ring-offset-2',
  ghost:
    'bg-transparent text-slate-700 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400',
  danger:
    'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2',
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2.5 text-sm',
  lg: 'px-6 py-3 text-base',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    className = '',
    children,
    type = 'button',
    ...rest
  },
  ref
) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none';
  return (
    <button
      ref={ref}
      type={type}
      className={`${base} ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});
