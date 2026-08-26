# Follow-up: review HR / People role scores as a cohort

**Status:** open. Deliberately not addressed while adding recruiter onboarding.

## What we found

`roleScores` in `lib/scoring.ts` has no entry for any HR / People role:

| role_type | entry in `roleScores` | effective score |
|---|---|---|
| `CHRO` | none | 40 (fallback) |
| `Chief People Officer` | none | 40 (fallback) |
| `Head of Talent` | none | 40 (fallback) |
| `HR Executive` | none | 40 (fallback) |

40 is the same number an entirely unrecognised value receives. A CHRO therefore scores the same as
a typo. That is almost certainly not a decision anyone made — it is what happens when a taxonomy
grows and a scoring map does not grow with it.

Several other categories are in the same position: Marketing, Operations, Technology /
Cybersecurity, Government Affairs / Policy and Healthcare have no entries either. The gap is not
specific to HR — HR is simply where recruiter onboarding made it visible.

## Why nothing was changed

Adding scores would change the computed network-value score of existing members. That is a real
behaviour change to live data, it belongs to no one member's request, and it should be decided as a
cohort — not as a side effect of adding two recruiter labels.

`In-House Talent Leader` was therefore given an **explicit 40**, matching the HR / People baseline
exactly, so the new label confers no advantage over roles a member could already have chosen.

## What a review would need to decide

1. Should the map cover every ROLE_CATEGORIES title, or should the fallback be the intended
   behaviour for unlisted roles? (If the latter, the fallback should say so.)
2. If HR / People is scored, at what level relative to the existing anchors — Executive / C-Suite
   100, Investor 90, Founder 85, Law firm attorney 80, In-house attorney 75, Legal services 70,
   Consultant 65?
3. Whether `In-House Talent Leader` moves with that cohort. It should: the two overlap by design.
4. Who is affected, and whether the change should be announced. `computeNetworkValueScore` feeds
   the admin `compute-scores` route, not live matching, so member-visible impact is indirect —
   confirm that before assuming it is low-risk.

## Where to change it

- `lib/scoring.ts` — the `roleScores` map inside `computeNetworkValueScore`
- `lib/__tests__/recruiter-role.test.ts` — the "no existing role score changes" and
  "not scored above CHRO" assertions both pin the current baseline and will fail loudly,
  which is the intended tripwire.
