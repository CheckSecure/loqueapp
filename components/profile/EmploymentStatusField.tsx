'use client'

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import {
  EMPLOYMENT_STATUS_OPTIONS,
  previewCompatibility,
  betweenRolesCompanyPrompt,
  type EmploymentStatus,
} from '@/lib/profile/employmentStatus'

/**
 * The employment-status question, asked directly instead of inferred from company text.
 *
 * ONE VOCABULARY. Labels, descriptions, the company requirement, and the compatibility verdict all
 * come from lib/profile/employmentStatus — the same module the server validates with. There is no
 * second client-side copy of the rules to drift out of step; the server stays the authority, and
 * this only means the member finds out at the field rather than at the submit button.
 *
 * IT NEVER CLEARS ANYTHING. Choosing "Between roles" with a company populated shows a confirmation
 * line explaining how that company will be displayed — it does not erase it. Deleting a member's
 * own data to resolve a display question would be the wrong trade. Nothing here writes to any
 * separate employment-history record; the value simply stays in the company field.
 */
export default function EmploymentStatusField({
  value,
  onChange,
  roleType,
  company,
  required = true,
  idPrefix = 'employment-status',
  className,
}: {
  value: string
  onChange: (next: EmploymentStatus) => void
  roleType: string | null | undefined
  company: string | null | undefined
  required?: boolean
  idPrefix?: string
  className?: string
}) {
  const selected = EMPLOYMENT_STATUS_OPTIONS.find((o) => o.value === value) ?? null

  // The verdict the SERVER will reach, computed from the same function.
  const verdict = useMemo(
    () => (value ? previewCompatibility({ role_type: roleType, current_status: value, company }) : null),
    [value, roleType, company],
  )
  const betweenPrompt = useMemo(
    () => betweenRolesCompanyPrompt({ nextStatus: value, company }),
    [value, company],
  )

  return (
    <div className={cn('min-w-0', className)}>
      <fieldset>
        <legend className="block text-sm font-semibold text-slate-800 mb-2">
          Employment status{required && <span className="text-red-500 ml-0.5" aria-hidden="true">*</span>}
        </legend>
        <div className="flex flex-col gap-2 min-w-0">
          {EMPLOYMENT_STATUS_OPTIONS.map((o) => {
            const active = value === o.value
            return (
              <label
                key={o.value}
                htmlFor={`${idPrefix}-${o.value}`}
                className={cn(
                  'flex items-start gap-3 rounded-lg border px-3.5 py-3 cursor-pointer transition-all min-w-0',
                  'focus-within:ring-2 focus-within:ring-[#1B2850] focus-within:ring-offset-1',
                  active
                    ? 'bg-[#1B2850] text-white border-[#1B2850]'
                    : 'bg-white text-slate-700 border-slate-200 hover:border-[#1B2850]/40',
                )}
              >
                <input
                  id={`${idPrefix}-${o.value}`}
                  type="radio"
                  name={idPrefix}
                  value={o.value}
                  checked={active}
                  onChange={() => onChange(o.value)}
                  className="mt-0.5 flex-shrink-0 accent-[#1B2850]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium break-words">{o.label}</span>
                  <span className={cn('block text-xs mt-0.5 leading-snug break-words', active ? 'text-white/75' : 'text-slate-500')}>
                    {o.description}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>

      {selected && (
        <p className="mt-2 text-xs text-slate-500 leading-relaxed break-words">
          <span className="font-medium text-slate-700">{selected.companyLabel}:</span>{' '}
          {selected.companyHint}
        </p>
      )}

      {betweenPrompt && (
        <p role="status" className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 leading-relaxed break-words">
          {betweenPrompt}
        </p>
      )}

      {verdict && !verdict.ok && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 leading-relaxed break-words"
        >
          {verdict.message}
        </p>
      )}
    </div>
  )
}
