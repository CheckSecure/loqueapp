'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  ROLE_CATEGORIES,
  type Category,
  titleToCategory,
  isStructuredTitle,
} from '@/lib/role-taxonomy'

interface Props {
  /** Current role_type value. May be '', a Phase B canonical title, 'Other', or a legacy string. */
  value: string
  /** Called with the new role_type string. */
  onChange: (next: string) => void
}

/**
 * Two-step category → title picker for the live onboarding form
 * (components/OnboardingForm.tsx). Replaces the prior flat button list.
 *
 * Behavior:
 * - Top row: 12 category chips + an 'Other' chip.
 * - Clicking a category chip expands the title chips for that category;
 *   value is unchanged until the user clicks a title.
 * - Clicking a title chip sets value to that title.
 * - Clicking 'Other' sets value to 'Other' immediately (no sub-step).
 * - Legacy values (stored role_type not in any category and not 'Other')
 *   render as a pinned "Current: <value>" chip at the top; clicking it
 *   re-selects the legacy value verbatim (never blanked).
 */
export function RoleCategoryPicker({ value, onChange }: Props) {
  const initialCategory: Category | null = (() => {
    const cat = titleToCategory(value)
    return cat && cat !== 'Other' ? (cat as Category) : null
  })()
  const [activeCategory, setActiveCategory] = useState<Category | null>(initialCategory)

  // Legacy = stored value is non-empty and not in the structured set.
  const isLegacy = value !== '' && !isStructuredTitle(value)

  const categoryButtonClass = (selected: boolean) =>
    cn(
      'px-3.5 py-2 rounded-lg text-sm font-medium border transition-all',
      selected
        ? 'bg-[#1B2850] text-white border-[#1B2850]'
        : 'bg-white text-slate-600 border-slate-200 hover:border-[#1B2850]/40 hover:text-[#1B2850]'
    )

  const titleButtonClass = (selected: boolean) =>
    cn(
      'px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
      selected
        ? 'bg-[#1B2850] text-white border-[#1B2850]'
        : 'bg-white text-slate-600 border-slate-200 hover:border-[#1B2850]/40 hover:text-[#1B2850]'
    )

  return (
    <div className="space-y-3">
      {isLegacy && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onChange(value)}
            className={categoryButtonClass(true)}
            aria-label={`Keep current role: ${value}`}
          >
            Current: {value}
          </button>
        </div>
      )}

      {/* Category chips */}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(ROLE_CATEGORIES) as Category[]).map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setActiveCategory(cat)}
            className={categoryButtonClass(activeCategory === cat)}
          >
            {cat}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            setActiveCategory(null)
            onChange('Other')
          }}
          className={categoryButtonClass(value === 'Other')}
        >
          Other
        </button>
      </div>

      {/* Title chips for active category */}
      {activeCategory && (
        <div>
          <p className="text-xs text-slate-500 mb-2">Pick a title in {activeCategory}:</p>
          <div className="flex flex-wrap gap-2">
            {(ROLE_CATEGORIES[activeCategory] as readonly string[]).map((title) => (
              <button
                key={title}
                type="button"
                onClick={() => onChange(title)}
                className={titleButtonClass(value === title)}
              >
                {title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
