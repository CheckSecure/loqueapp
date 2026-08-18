/**
 * The single required-field marker for every signup / onboarding form.
 *
 * WHY ONE COMPONENT: the marker was previously hand-written per field, so it drifted —
 * some required fields carried a bare red asterisk, some carried only an sr-only
 * "(required)", and most carried nothing at all. Rendering it from one place makes the
 * styling identical everywhere and makes "is this field marked?" a single, testable fact.
 *
 * ACCESSIBILITY: the asterisk is decorative (aria-hidden), and the requirement is carried
 * for assistive tech by the visually-hidden "(required)" text — so the state is never
 * communicated by colour or by a glyph alone. Put this INSIDE the field's <label> so the
 * hidden text is announced as part of the accessible name.
 *
 * SCOPE: this is a LABEL annotation only. It does not add, remove, or change any
 * validation. Whether a field is actually required is still decided solely by the HTML
 * `required` attribute, the client-side gate, and the server/API validation — this only
 * makes an existing requirement visible.
 */
export function RequiredMark() {
  return (
    <>
      {' '}
      <span className="text-red-500" aria-hidden="true">*</span>
      <span className="sr-only">(required)</span>
    </>
  )
}

/**
 * The legend that explains the marker, shown once near the top of a form that contains
 * required fields. Kept in the same module so the asterisk and its explanation can never
 * disagree about styling.
 */
export function RequiredLegend({ className = '' }: { className?: string }) {
  return (
    <p className={`text-xs text-slate-500 ${className}`}>
      <span className="text-red-500" aria-hidden="true">*</span> Required
    </p>
  )
}
