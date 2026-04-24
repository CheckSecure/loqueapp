import type { ReactNode } from 'react';

/**
 * EmptyState — placeholder for zero-data list views.
 *
 * Renders: icon (optional) → title → description (optional) → CTA slot (optional).
 * Use inside a Card or as a standalone centered container.
 *
 * Example:
 *   <EmptyState
 *     icon={<Inbox className="w-6 h-6 text-slate-400" />}
 *     title="No introductions yet"
 *     description="Your next match is being curated."
 *   >
 *     <Button variant="secondary" size="sm">Complete your profile</Button>
 *   </EmptyState>
 */

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  children,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={`rounded-2xl bg-white border border-slate-100 px-8 py-14 text-center ${className}`}
    >
      {icon && (
        <div className="w-12 h-12 rounded-full bg-slate-50 flex items-center justify-center mx-auto mb-4">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {description && (
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
          {description}
        </p>
      )}
      {children && <div className="mt-5 flex justify-center">{children}</div>}
    </div>
  );
}
