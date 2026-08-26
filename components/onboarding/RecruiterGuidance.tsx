import { Users } from 'lucide-react'
import { recruiterGuidance } from '@/lib/onboarding/recruiterGuidance'

/**
 * The optional recruiter panel. Rendered ONLY when role_type is one of the two recruiter values.
 *
 * IT HAS NO INPUTS AND NO STATE. It explains, in recruiter language, what to put in the expertise /
 * desired-connections / purposes questions the member has already been shown. That is why it cannot
 * block completion, cannot be "half-filled", and why switching away from a recruiter role deletes
 * nothing: it never held anything.
 *
 * Server component — no client JS ships for it.
 */
export default function RecruiterGuidancePanel({ roleType }: { roleType: string | null | undefined }) {
  const g = recruiterGuidance(roleType)
  if (!g) return null

  return (
    <section
      aria-labelledby="recruiter-guidance-heading"
      className="mt-4 rounded-xl border border-brand-navy/12 bg-white/70 p-4 sm:p-5 min-w-0"
    >
      <div className="flex items-start gap-3 min-w-0">
        <span className="w-8 h-8 rounded-lg bg-brand-navy/[0.05] text-brand-gold flex items-center justify-center flex-shrink-0">
          <Users className="w-4 h-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 id="recruiter-guidance-heading" className="text-sm font-bold text-brand-navy break-words">
            {g.heading}
          </h3>
          <p className="mt-1 text-xs text-slate-600 leading-relaxed break-words">{g.intro}</p>
        </div>
      </div>

      <ul className="mt-3 space-y-2">
        {g.points.map((p) => (
          <li key={p.field} className="text-xs leading-relaxed min-w-0">
            <span className="font-semibold text-brand-navy">{p.label}:</span>{' '}
            <span className="text-slate-600 break-words">{p.hint}</span>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-[11px] text-slate-500 leading-relaxed break-words">{g.footnote}</p>
    </section>
  )
}
