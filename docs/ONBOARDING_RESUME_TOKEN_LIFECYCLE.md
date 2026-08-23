# Resume tokens: what expires, what does not, and what retires what

> ## Rollout dependency — apply migrations before deploying code
>
> **Migrations 077, 078 and 079 must be applied BEFORE this application code is deployed.**
>
> The invitation path now fails closed when a bound resume token cannot be persisted. Deploying the
> code first would mean `invitation_resume_tokens` does not exist yet, so **every invitation would
> refuse to send** — visibly and safely, but nobody would get invited until the migrations landed.
> The reminder worker, the resume endpoint, the catch-up campaign and rotation all depend on
> functions that only exist after 078.
>
> Order: `077_078_preflight.sql` → 077 → 078 → 079 → `077_078_postapply.sql` (expect every row
> `PASS`) → deploy.

There are **two kinds of link** in every Andrel invitation email, and conflating them is what
produced the original failure — people were told a link would work, and it did not.

## 1. Supabase authentication link (the button)

Signs the recipient in. **Expires by design.** Minted by `generateLink({type:'invite'|'recovery'})`,
carried in the URL fragment to `/auth/recover`, and consumed only on a deliberate click.

## 2. Resume link (the fallback)

**Authenticates nobody and does not expire.** Opening it does nothing at all; pressing its button
asks the server to email a *fresh* authentication link to the address already on the invitation. A
forwarded resume link cannot let anyone in — at worst it causes mail to arrive in the rightful
owner's inbox.

Only the SHA-256 of the token is stored, bound to a non-null `auth_user_id`. The plaintext exists
in the sending process and in the recipient's inbox, nowhere else.

## Which actions issue tokens, and which retire them

| Action | Issues a token | Retires older tokens |
|---|---|---|
| First invitation (`/api/admin/send-invite`) | **yes** | no |
| Access-resend (`sendSecureInviteForWaitlist`) | **yes** | no |
| Staged reminder 1 / 2 / 3 | **yes** | no |
| Admin catch-up campaign | **yes** | no |
| A member pressing "Continue setting up" | no | no — the token is not consumed |
| **Admin rotation** (`/api/admin/invitations/rotate-resume`) | **yes** | **yes — all of them** |

Multiple resume tokens are simultaneously valid for one invitation, deliberately. A member who kept
the first email is not holding a dead link after reminder 2 arrives.

## What ends the capability

Checked at claim time on every request, so all tokens for an invitation die together:

- `profile_complete = true`
- waitlist status is anything other than exactly `invited`
- the unique auth identity no longer equals the one bound at issuance (deleted, recreated, replaced)
- the invitation row is deleted
- the address is suppressed at the provider (any historical bounce / block / complaint)
- admin rotation or revocation

There is **no expiry**, because there is nothing to expire: the token confers no access.

## Rotation is prepare → send → finalize

Retiring old tokens *before* sending would be wrong. Email has three outcomes, and on a failed or
uncertain send the member would hold only dead links with no way to be told.

1. **Prepare** — mint the replacement. Everything stays live; the member has one *more* working link.
2. **Send** — one provider call under an idempotency key derived from the durable delivery claim.
3. **Finalize** — only on a *definite* acceptance, atomically supersede every other live token.

- Definite failure → revoke the replacement; every prior link keeps working.
- Uncertain outcome → change nothing. Both sets stay live.

The trade is stated rather than hidden: an uncertain send leaves **more** live tokens than intended,
never fewer. An extra working link is a smaller harm than a member locked out by a rotation nobody
can confirm happened.

## What the email copy may and may not say

- It may say the sign-in link expires, and offer the fallback: *"If this sign-in link expires,
  request a fresh secure link."*
- It must **not** say the original link remains valid.
- It must **not** say "reset your password" or link to `/auth/forgot-password`.
- It must **not** promise acceptance, matches or introductions.

## Resume-access dispatch: the exact state ordering

A resume-access send moves through four database states. The order exists so that **no crash can be
read as "never attempted"**.

| # | Step | Row state after | Auto-retryable? |
|---|---|---|---|
| 1 | Atomic claim (`claim_resume_access_attempt`) | `claimed` + `pending` | **yes**, once the lease expires |
| 2 | Generate the Supabase recovery link | `claimed` + `pending` | **yes** — genuinely pre-dispatch |
| 3 | `begin_resume_dispatch` — must transition **exactly one** row | `claimed` + `dispatching` | **no** |
| 4 | Call the provider | *(unchanged)* | **no** |
| 5a | Provider accepted | `accepted` + `dispatched` | n/a — done |
| 5b | Provider definitely refused | `failed` + `dispatched` | **yes** — no message exists |
| 5c | Provider outcome unknown | `claimed` + `uncertain` | **no** |
| 5d | **Any post-provider update fails** | stays `claimed` + `dispatching` | **no** |

**Step 3 is the fix.** Previously the row stayed `pending` across the whole provider call, so a
process that died mid-call — or after acceptance but before the post-call update — left a row
indistinguishable from one where nothing had happened. The lease retired it as `stale_pre_dispatch`
and a second email went out under a new idempotency key. One crash, two emails.

**Only `pending` is ever retired by the lease.** `dispatching` and `uncertain` never expire. No
elapsed-time branch can convert either into a fresh claim — only durable webhook evidence (moving
the row to `delivered`/`bounced`/`failed`) or explicit admin review resolves them.

**Every transition checks its `{ error }` result.** Supabase query builders return errors rather than
throwing, so `try/catch` alone would sail past a failed update. When a post-provider update fails,
the row is deliberately left saying *a dispatch may have happened* — the safe direction is always
"possibly sent; do not resend".
