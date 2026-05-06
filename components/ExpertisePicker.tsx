'use client'

import { EXPERTISE_OPTIONS } from '@/lib/profile-options'

interface ExpertisePickerProps {
  selected: string[]
  onChange: (next: string[]) => void
  options?: string[]
}

export default function ExpertisePicker({
  selected,
  onChange,
  options = EXPERTISE_OPTIONS,
}: ExpertisePickerProps) {
  function toggle(tag: string) {
    onChange(
      selected.includes(tag)
        ? selected.filter((t) => t !== tag)
        : [...selected, tag]
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((tag) => (
        <button
          type="button"
          key={tag}
          onClick={() => toggle(tag)}
          className={`rounded-full border px-3 py-1 text-xs ${
            selected.includes(tag)
              ? 'border-[#1B2850] bg-[#1B2850] text-white'
              : 'border-slate-300 text-slate-600 hover:border-slate-400'
          }`}
        >
          {tag}
        </button>
      ))}
    </div>
  )
}
