# Follow-up: introductions spend FREE credits only

**Status:** open. Product/accounting decision — deliberately NOT changed by the security work in
migrations 067/068.

## What the code does today

`public.consume_credits_and_create_match`, transcribed verbatim into migration 067 from the
operator's `pg_get_functiondef()` output, gates both deductions on the free pool:

```sql
UPDATE public.meeting_credits
SET free_credits = free_credits - 1,
    balance = (free_credits - 1) + COALESCE(premium_credits, 0)
WHERE user_id = p_user_a AND free_credits >= 1;
```

The `WHERE` clause tests `free_credits >= 1`, not `balance >= 1`. So a member whose free pool is
exhausted is refused with `insufficient_credits_a` / `insufficient_credits_b` **even when they hold
purchased premium credits and their balance is positive**.

## Why it was not changed

Migrations 067 and 068 exist to close a privilege hole: the function was executable by
PUBLIC/anon/authenticated, so any browser session could charge two members and manufacture a match
with no consent check. Transcribing the body and hardening name resolution is a security fix with no
behavioural change. Making premium credits spendable is a different kind of change — it alters who
can be matched and how purchased credits are consumed, and it would have shipped inside a security
migration where nobody was reviewing for it.

## What to decide

1. Should premium/purchased credits be spendable on an introduction, or are they reserved for
   another product surface? If they are not spendable anywhere, that is a refund/expectation issue.
2. If they should be spendable, what is the spend order (free first, then premium)?
3. The `balance` recalculation would need to change with it. Note the current expression re-derives
   `balance = free_credits + premium_credits` from the pre-update values rather than decrementing,
   so it also repairs drifted rows — preserve that property in any rewrite.
4. Section F of `supabase/audits/consume_credits_misuse_audit.sql` counts rows violating that
   invariant; run it before and after any change.
