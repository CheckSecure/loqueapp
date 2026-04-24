'use client';

/**
 * Toggle — 44x24 pill switch with sliding thumb.
 *
 * Off: slate-200 track, thumb on the left.
 * On:  brand-navy track, thumb on the right (with subtle shadow).
 *
 * Purely visual. The parent owns state; Toggle fires `onToggle` when clicked.
 * Disabled state reduces opacity and blocks interaction. Intended to replace
 * native checkboxes inside settings and preferences surfaces.
 */

interface ToggleProps {
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function Toggle({
  checked,
  onToggle,
  disabled = false,
  ariaLabel,
  className = '',
}: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onToggle}
      disabled={disabled}
      className={`
        relative inline-flex items-center h-6 w-11 flex-shrink-0 rounded-full
        transition-colors duration-200 ease-out
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold focus-visible:ring-offset-2
        disabled:opacity-50 disabled:cursor-not-allowed
        ${checked ? 'bg-brand-navy' : 'bg-slate-200'}
        ${className}
      `}
    >
      <span
        aria-hidden
        className={`
          inline-block h-5 w-5 rounded-full bg-white shadow-sm
          transition-transform duration-200 ease-out
          ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}
        `}
      />
    </button>
  );
}
