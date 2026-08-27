# Follow-up: intro_preferences vocabulary drift

Recorded 2026-08-27. **Not fixed** — deliberately deferred so the batch-scoring wiring could be
measured on its own. Nothing here is urgent; all three are correctness-of-design issues that
will bite again the next time someone touches preference matching.

Context: `intro_preferences` stores role CATEGORIES or RELATIONSHIPS; `role_type` stores job
TITLES. Every scorer compared them as raw strings, so the +30/+20 preference bonus in
`lib/matching/batch-scoring.ts` — 50 of the 40 points needed to clear `MIN_RELEVANCE_SCORE` —
fired for essentially nobody. On production, exactly ONE member held a `role_type` that
literally equalled a preference value. Fixed for the admin batch only, via
`lib/matching/introPreferenceMatch.ts`.

## 1. Three onboarding forms write three vocabularies to one column

| File | Constant | Values |
|---|---|---|
| `components/OnboardingForm.tsx:38` | `MEET_ROLE_TYPES` | Executive / C-Suite, Investor / VC, Government / Policy, Finance, Healthcare, Legal |
| `components/OnboardingStep2.tsx:10` | `INTRO_PREFS` | Investors, Founders, Potential hires, Collaborators, Mentors, Customers |
| `components/ProfileForm.tsx:41` | `INTRO_PREFS` | (identical to Step2) |

All three write `intro_preferences`. Nothing reconciles them. The first is role CATEGORIES; the
other two are RELATIONSHIPS — a different axis, and four of those six values
(Collaborators, Potential hires, Customers, Mentors) can never be satisfied by any `role_type`.

They should be one vocabulary, sourced from `lib/role-taxonomy.ts` rather than hardcoded three
times. If relationship-style preferences are wanted, they need their own column and their own
matching rule — `Mentors` in particular is already modelled by `mentorship_role` (+25 in
`scoreMatch`), so matching it here too would double-count.

## 2. Five comparison sites, three different semantics

| Site | Comparison | `Founders` → `Founder`? |
|---|---|---|
| `lib/matching/batch-scoring.ts:230` | **FIXED** — category via `preferenceMatchesRole` | yes |
| `lib/generate-recommendations.ts:36` | bidirectional substring | yes, by accident |
| `lib/generate-recommendations.ts:193` | exact equality `===` | no |
| `lib/generate-recommendations.ts:485` | bidirectional substring | yes, by accident |
| `app/api/admin/batch/[batchId]/generate-replacements/route.ts:96,102` | exact equality | no |
| `lib/matching/scoring.ts:92` | one-directional substring (role contains pref) | no |

The same member is treated differently depending on which engine runs. The substring sites also
produce false positives in the other direction: any preference that happens to be a substring of
a title matches, e.g. `Legal` would match `Chief Legal Officer` and `Legal Operations` but not
`General Counsel` — arbitrary rather than wrong-in-a-consistent-way.

All should route through `preferenceMatchesRole`.

## 3. A comment that states the false premise

`lib/generate-recommendations.ts:190-192`:

```
// Exact match (case-insensitive). Both fields store canonical role_type
// strings; substring matching would create false positives if a non-role_type
// value ever lands in intro_preferences.
```

`intro_preferences` has never stored `role_type` strings — it stores what the three pickers
above write. The comment is the reason the mismatch survived review: it asserts the invariant
that the defect violates. Correct it when site 2 is fixed.
