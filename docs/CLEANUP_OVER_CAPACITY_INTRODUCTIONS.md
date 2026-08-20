# Cleanup proposal — members over the VISIBLE introduction cap

**Status: PROPOSAL. Nothing has been executed. No mutation SQL appears in this document.**

Migration 063 *prevents new* violations. It deliberately does not correct existing rows.

All figures below come from a read-only production query on 2026-08-19. Members are anonymised.

---

## 1. Who is actually affected — and it is not 66

The earlier audit reported 66 members "over cap", but that counted `suggested` and `queued` against a
single limit of 2. Under the two-tier contract most of that set is legal and must not be touched:

| Shape (visible + reserved) | Members | Under the two-tier contract |
|---|---|---|
| 2 visible + 2 reserved | 53 | **At cap, legal.** |
| 2 visible + 1 reserved | 6 | **Legal.** |
| 1 visible + 2 reserved | 3 | **Legal.** A reservation never blocks a visible slot. |
| **3 visible + 0 reserved** | **4** | **The only genuine violation.** |

Re-confirmed 2026-08-19: 153 `suggested` rows, 4 members with >2 visible, **0 members with >2 reserved**.

## 2. The four cases are two reciprocal pairs

This is the finding that changes the recommendation. The four members are not independent:

- **Pair P-α** — Case 1 ↔ Case 3 (`member_pairs.source = 'onboarding'`, created 2026-08-13 15:58 UTC)
- **Pair P-β** — Case 2 ↔ Case 4 (`member_pairs.source = 'onboarding'`, created 2026-08-12 20:03 UTC)

Every one of the four has the identical shape:

| | Case 1 | Case 2 | Case 3 | Case 4 |
|---|---|---|---|---|
| reciprocal card (`batch_id` NULL) | 08-13 15:58 | 08-12 20:03 | 08-13 15:58 | 08-12 20:03 |
| admin batch, 2 rows, `state='active'` | 08-13 23:19 | 08-13 23:19 | 08-13 23:19 | 08-13 23:19 |
| `completed_at` on that batch | null | null | null | null |
| visible / reserved | 3 / 0 | 3 / 0 | 3 / 0 | 3 / 0 |
| expressed interest on any of the three | no | no | no | no |

The UI orders `created_at DESC` and slices to 2, so the **two admin cards are shown and the
reciprocal card is hidden — on both sides of both pairs.** Neither participant has ever seen the
introduction, and neither has acted on it.

**There is no asymmetry today.** The earlier proposal asserted that the counterpart could see a card
its partner could not; the data shows both sides hide it symmetrically. That claim was wrong.

## 3. What waiting actually costs

`expire_stale_reciprocal_pairs` (rotation, 14 days) expires a pair when both directions are still
`suggested` — true for both pairs. It runs inside the weekly cron, Thursdays 14:00 UTC:

- **Pair P-β** (`last_recommended_at` 2026-08-12) → stale at the **2026-08-27** run.
- **Pair P-α** (`last_recommended_at` 2026-08-13 15:58) → still inside the window at the 08-27 run
  (cutoff 08-13 14:00), so it expires at the **2026-09-03** run.

So the state self-heals within 8–15 days, and the members' visible counts fall back to 2 without any
write. Nothing is corrupt; the cost is that an onboarding introduction generated for four members is
silently discarded without ever being shown.

**One real risk of waiting.** The symmetry holds only while nobody acts. If one member passes or
expresses interest in an admin card, their visible count drops to 2, the reciprocal card surfaces for
them alone, and the counterpart still cannot see it. If that member then expresses interest, the
counterpart receives an "interested in you" signal for an introduction they have never been shown.
That is the private-interest confusion worth avoiding, and it needs only one ordinary member action.

## 4. Recommendation: **B, applied per PAIR, before 2026-08-27**

Demote exactly one legacy admin card per member to `queued`, restoring the reciprocal card to
visibility — and do it for **both members of a pair in one transaction**, never one side alone.
Fixing one side would manufacture the exact asymmetry §3 warns about.

**A (no cleanup) remains defensible** and is the right choice if the operator prefers zero writes to
live member data: the state is currently invisible and self-heals. Choosing A means accepting that
four members lose their onboarding introduction and that the §3 asymmetry can occur in the interim.
What is *not* defensible is a partial cleanup that touches one side of a pair.

### Selection rule — a deterministic demotion rule, NOT a ranking

**Keep the reciprocal card. Demote one admin card by a mechanical, repeatable rule.**

These rows carry **no persisted score, rank or ordering column**. Calling either card
"lower-ranked" would assert a quality judgement the data cannot support. The rule is:
`ORDER BY created_at DESC, id DESC` → demote the first row — the later-created card, and since both
rows of each batch share a `created_at` to the microsecond, in practice the `id` comparison decides.
Arbitrary but stable, repeatable, and the same order `place_batch_rows` uses when it stops placing.

1. **The reciprocal card is two-sided.** Removing it orphans the counterpart. An admin batch card is
   one-directional.
2. **It is the card nobody can see.** Promoting it into visibility delivers what was intended;
   demoting one admin card removes something the member was never shown. **No member loses a card
   they can see today** — they see two before and two after.
3. **Reserved, not deleted.** The demoted card becomes `queued` and returns through normal promotion
   once a visible slot frees. Fully reversible.

The chosen row id is written to the run log so the choice is auditable and hand-reversible.

### Batch-metadata consequence

The demoted row belongs to an ACTIVE batch, which would then hold one `suggested` and one `queued`
row — violating the "an active batch's rows are all `suggested`" invariant and confusing
`promote_queued_rows`. The repair must **split** the demoted row into a new `recommendation_batches`
row with `state='queued'`, carrying the original `batch_source` and `created_at` — exactly what
`promote_queued_rows` does in the same situation. All four members have no queued batch today, so the
one-queued-per-member index permits it; that must still be re-checked in-transaction.

## 5. Safeguards required before any write

1. **Apply migration 063 first.** Repairing before enforcement exists lets the next run recreate it.
2. **One transaction per PAIR** (both members), taking
   `pg_advisory_xact_lock(hashtextextended(member_id::text, 0))` for both participants **in canonical
   (sorted) order** — the same key and order the RPCs use, so it cannot deadlock against them.
3. **Re-verify inside the transaction:** each member has exactly 3 visible, 0 reserved, exactly 1 row
   with `pair_id`, no queued batch, and the shared `pair_id` matches. Any mismatch → roll that pair
   back and skip. Four members is small; a skip is cheap and a wrong write is not.
4. **Touch only `status`, `batch_id`, `updated_at`.** Never `pair_id`, `match_reason`, `created_at`.
   The reciprocal rows are not touched at all.
5. **Never delete, archive or expire.** If a delete ever looks correct, the rule does not fit the
   data — stop and re-review.
6. **No notification, no email.** The visible count is unchanged and neither card is new to the
   member. Any send would be a surprise about a card they never saw.
7. **Bounded to 2 pairs / 4 members** in one run.
8. **Capture before/after row sets** in the run log so the change can be reversed by hand. Reversal
   is possible precisely because nothing is destroyed.
9. **Deadline.** After the 2026-09-03 rotation both pairs are gone and the repair is moot. Do not run
   it against an expired pair.

## 6. Verification after the run

```sql
-- read-only: must return ZERO rows
SELECT requester_id, count(*) FROM public.intro_requests
WHERE status = 'suggested' GROUP BY requester_id HAVING count(*) > 2;

-- read-only: the reserved tier must not have been pushed over either
SELECT requester_id, count(*) FROM public.intro_requests
WHERE status = 'queued' GROUP BY requester_id HAVING count(*) > 2;

-- read-only: THE check that matters — every live reciprocal pair still has BOTH directions visible
SELECT pair_id, count(*) FROM public.intro_requests
WHERE pair_id IS NOT NULL AND status = 'suggested'
GROUP BY pair_id HAVING count(*) <> 2;

-- read-only: no batch may mix row statuses
SELECT b.batch_id, b.state, i.status, count(*)
FROM public.recommendation_batches b JOIN public.intro_requests i ON i.batch_id = b.batch_id
WHERE (b.state = 'active' AND i.status = 'queued') OR (b.state = 'queued' AND i.status = 'suggested')
GROUP BY 1, 2, 3;
```

The third query is the one to watch: it is the check that the repair did not break the two-sided
guarantee it exists to protect. It must return zero rows both before and after.


---

## 7. The guarded SQL exists and has been rehearsed — but NOT run against production

`supabase/cleanup/063_cleanup_over_capacity_pairs.sql` implements exactly this proposal: preflight,
rollback rehearsal, apply, post-check. It is **not** part of migration 063 and requires separate
approval.

It was exercised end-to-end against a disposable local PostgreSQL 16.15 with the production shape
reconstructed (2 reciprocal pairs, 4 members, 3 visible / 0 reserved each):

- **Preflight** returned exactly `4, 4, 4, 4, 4, 4, 4, 2` and `pairs_with_both_directions_visible = 2`.
- **Rehearsal** demoted 4 rows, created 4 queued batches, satisfied every post-condition, reported
  `members_over_visible_cap = 0, members_over_reserved_cap = 0, pairs_not_both_visible = 0`, then
  **rolled back** — leaving the database at 3 visible / 0 reserved and 0 queued batches.
- **Abort guards fired** on each injected divergence (interest expressed since preflight; a pair
  losing a visible side; a changed member count), each aborting the entire transaction with nothing
  written.

Production was never touched.
