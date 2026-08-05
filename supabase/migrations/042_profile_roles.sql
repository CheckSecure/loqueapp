-- 042 — Additional roles & affiliations (Phase A)
--
-- A member's PRIMARY professional role stays authoritative on `profiles`
-- (title/company/role_type/seniority) and continues to drive the headline,
-- same-company exclusion, and all matching. This table holds ADDITIONAL current
-- or past affiliations only (board seats, advisory, committees, associations,
-- investment funds, nonprofits, universities, government commissions).
--
-- Additive · idempotent · non-destructive · no backfill · safe when empty.
-- Isolated by design: nothing here is read by matching, completion, same-company,
-- or business-solution logic in Phase A/B.

CREATE TABLE IF NOT EXISTS public.profile_roles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  organization_name text NOT NULL,
  organization_id   uuid NULL REFERENCES public.companies(id),
  title             text NULL,
  role_category     text NOT NULL,
  industry          text NULL,
  is_current        boolean NOT NULL DEFAULT true,
  is_primary        boolean NOT NULL DEFAULT false,
  description       text NULL,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_roles_role_category_chk CHECK (role_category IN (
    'primary_employment','board_member','advisor','professional_association',
    'committee_leadership','investor_fund','academic','government_policy',
    'nonprofit','other'
  ))
);

-- Lookups by member.
CREATE INDEX IF NOT EXISTS profile_roles_profile_id_idx
  ON public.profile_roles(profile_id);

-- At most ONE primary role per profile (v1 never sets is_primary=true, but the
-- invariant is enforced at the DB level for the future primary-role migration).
CREATE UNIQUE INDEX IF NOT EXISTS profile_roles_one_primary_idx
  ON public.profile_roles(profile_id) WHERE is_primary;

COMMENT ON TABLE public.profile_roles IS
  'Additional (non-primary) professional roles & affiliations for a member. Isolated from primary identity (profiles.*); never read by matching/completion/same-company in Phase A/B.';
