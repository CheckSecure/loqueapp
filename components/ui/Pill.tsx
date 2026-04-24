import type { ReactNode } from 'react';

/**
 * Pill — small status/tag indicator.
 *
 * Variants:
 *   - default: slate — neutral labels
 *   - gold:    accent — highlighted/featured status
 *   - navy:    brand — tier indicators, selected filters
 *   - success: green — completed states, introduced
 *   - info:    blue — info-only messages
 *
 * Optional `dot` prop renders a small leading circle of matching color.
 */

type Variant = 'default' | 'gold' | 'navy' | 'success' | 'info';

interface PillProps {
  variant?: Variant;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  default: 'bg-slate-50 text-slate-600 border-slate-100',
  gold: 'bg-brand-gold-soft text-brand-gold border-brand-gold/20',
  navy: 'bg-brand-cream text-brand-navy border-brand-navy/10',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  info: 'bg-blue-50 text-blue-700 border-blue-100',
};

const DOT_CLASSES: Record<Variant, string> = {
  default: 'bg-slate-400',
  gold: 'bg-brand-gold',
  navy: 'bg-brand-navy',
  success: 'bg-emerald-500',
  info: 'bg-blue-500',
};

export function Pill({
  variant = 'default',
  dot = false,
  children,
  className = '',
}: PillProps) {
  const base =
    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium';
  return (
    <span className={`${base} ${VARIANT_CLASSES[variant]} ${className}`}>
      {dot && (
        <span
          aria-hidden
          className={`w-1.5 h-1.5 rounded-full ${DOT_CLASSES[variant]}`}
        />
      )}
      {children}
    </span>
  );
}
