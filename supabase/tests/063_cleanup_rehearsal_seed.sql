-- Seeds the disposable database with the EXACT production manifest captured 2026-08-19T22:52:44Z,
-- so the cleanup can be rehearsed against the same ids it will encounter in production, plus six
-- UNRELATED pre-existing wrong-status rows that must be proven disjoint and left untouched.
-- Requires 063_fixture.sql (schema) to have been applied first.

INSERT INTO auth.users (id) SELECT u FROM unnest(ARRAY[
  '9738c747-c00e-4588-a4fc-1b74dcfd85e6','d11d1c98-e016-497f-9308-e5a4f3caa146',
  'a8111428-6825-49c3-a2a0-419cd8b11b52','d5a385d5-5526-4c8e-b17b-74a371b7fd6d',
  '96fd1e65-3ff0-4f2f-9250-45c4aa1d4104','9ae6f563-ae0b-492e-b2ae-a7b24024c76c',
  '7365cb8f-3ecf-437e-9a66-1b59d1e12f2d','fe06c087-c82e-445a-a3cf-6b44dd542574',
  '7a5789ae-5d9d-4d7d-b175-a14bf25de2b1','d9168bc9-8674-41ad-a2cd-2fd07ec24e5e',
  '889f4b2e-90c4-4a3d-a344-5c11ce971679','e0c4e38d-0868-4f17-a79a-7313fec0a8b7',
  '11111111-2222-4333-8444-555555555501','11111111-2222-4333-8444-555555555502',
  '11111111-2222-4333-8444-555555555503','11111111-2222-4333-8444-555555555504'
]::uuid[]) u ON CONFLICT DO NOTHING;

INSERT INTO public.profiles (id, email, profile_complete, location)
SELECT u, 'seed-'||u::text||'@example.test', true, 'New York, NY'   -- FULL uuid: the
-- synthetic members share their first 8 chars, and profiles_email_key would silently drop them.
FROM unnest(ARRAY[
  '9738c747-c00e-4588-a4fc-1b74dcfd85e6','d11d1c98-e016-497f-9308-e5a4f3caa146',
  'a8111428-6825-49c3-a2a0-419cd8b11b52','d5a385d5-5526-4c8e-b17b-74a371b7fd6d',
  '96fd1e65-3ff0-4f2f-9250-45c4aa1d4104','9ae6f563-ae0b-492e-b2ae-a7b24024c76c',
  '7365cb8f-3ecf-437e-9a66-1b59d1e12f2d','fe06c087-c82e-445a-a3cf-6b44dd542574',
  '7a5789ae-5d9d-4d7d-b175-a14bf25de2b1','d9168bc9-8674-41ad-a2cd-2fd07ec24e5e',
  '889f4b2e-90c4-4a3d-a344-5c11ce971679','e0c4e38d-0868-4f17-a79a-7313fec0a8b7',
  '11111111-2222-4333-8444-555555555501','11111111-2222-4333-8444-555555555502',
  '11111111-2222-4333-8444-555555555503','11111111-2222-4333-8444-555555555504'
]::uuid[]) u ON CONFLICT DO NOTHING;

-- the two reciprocal pairs (canonical order enforced by member_pairs_canonical_ck)
INSERT INTO public.member_pairs (id, user_a_id, user_b_id, source, status, recommend_count,
                                 created_at, first_recommended_at, last_recommended_at) VALUES
 ('b4243cdb-87a8-4205-a01c-1ff72f132d95','9738c747-c00e-4588-a4fc-1b74dcfd85e6','d11d1c98-e016-497f-9308-e5a4f3caa146',
  'onboarding','active',1,'2026-08-12T20:03:03.682614+00','2026-08-12T20:03:03.682614+00','2026-08-12T20:03:03.682614+00'),
 ('fcb68220-59d5-4f81-8490-401c46dc66d8','a8111428-6825-49c3-a2a0-419cd8b11b52','d5a385d5-5526-4c8e-b17b-74a371b7fd6d',
  'onboarding','active',1,'2026-08-13T15:58:24.228047+00','2026-08-13T15:58:24.228047+00','2026-08-13T15:58:24.228047+00');

-- the four active admin batches (all share reciprocal_batch_id, as production shows)
INSERT INTO public.recommendation_batches (batch_id, member_id, batch_source, state, reciprocal_batch_id,
                                           created_at, generated_at, displayed_at) VALUES
 ('838a72af-1fe1-4e6a-b804-3e0005703408','9738c747-c00e-4588-a4fc-1b74dcfd85e6','admin_reciprocal','active','37802a5c-7420-44e8-ac94-9a413a6ab5bb','2026-08-13T23:19:21.855+00','2026-08-13T23:19:21.855+00','2026-08-13T23:19:21.855+00'),
 ('1f0db080-9094-4db4-a741-18a134389139','a8111428-6825-49c3-a2a0-419cd8b11b52','admin_reciprocal','active','37802a5c-7420-44e8-ac94-9a413a6ab5bb','2026-08-13T23:19:19.507+00','2026-08-13T23:19:19.507+00','2026-08-13T23:19:19.507+00'),
 ('3b424572-0ec9-43af-933d-b72de1ed6c11','d11d1c98-e016-497f-9308-e5a4f3caa146','admin_reciprocal','active','37802a5c-7420-44e8-ac94-9a413a6ab5bb','2026-08-13T23:19:19.275+00','2026-08-13T23:19:19.275+00','2026-08-13T23:19:19.275+00'),
 ('4f7f5f15-9ecb-40cb-9819-d2e211eb1674','d5a385d5-5526-4c8e-b17b-74a371b7fd6d','admin_reciprocal','active','37802a5c-7420-44e8-ac94-9a413a6ab5bb','2026-08-13T23:19:20.684+00','2026-08-13T23:19:20.684+00','2026-08-13T23:19:20.684+00');

-- the four reciprocal cards (batch_id NULL, pair_id set)
INSERT INTO public.intro_requests (id, requester_id, target_user_id, status, pair_id, batch_id, created_at, updated_at) VALUES
 ('286844dd-4774-4510-a1e7-673b3b0a248c','9738c747-c00e-4588-a4fc-1b74dcfd85e6','d11d1c98-e016-497f-9308-e5a4f3caa146','suggested','b4243cdb-87a8-4205-a01c-1ff72f132d95',NULL,'2026-08-12T20:03:03.682614+00','2026-08-12T20:03:03.682614+00'),
 ('bedcc78f-8107-462b-b8c6-3d9c885aeb02','d11d1c98-e016-497f-9308-e5a4f3caa146','9738c747-c00e-4588-a4fc-1b74dcfd85e6','suggested','b4243cdb-87a8-4205-a01c-1ff72f132d95',NULL,'2026-08-12T20:03:03.682614+00','2026-08-12T20:03:03.682614+00'),
 ('51a1e565-0a15-43c2-aadc-aa869d4d9786','a8111428-6825-49c3-a2a0-419cd8b11b52','d5a385d5-5526-4c8e-b17b-74a371b7fd6d','suggested','fcb68220-59d5-4f81-8490-401c46dc66d8',NULL,'2026-08-13T15:58:24.228047+00','2026-08-13T15:58:24.228047+00'),
 ('376fac0a-81e2-4705-9230-382705aee204','d5a385d5-5526-4c8e-b17b-74a371b7fd6d','a8111428-6825-49c3-a2a0-419cd8b11b52','suggested','fcb68220-59d5-4f81-8490-401c46dc66d8',NULL,'2026-08-13T15:58:24.228047+00','2026-08-13T15:58:24.228047+00');

-- the eight admin cards (both cards of a member share created_at, so the id tie-break decides)
INSERT INTO public.intro_requests (id, requester_id, target_user_id, status, batch_id, match_reason, created_at, updated_at) VALUES
 ('d1e85858-41dc-45be-9afd-8070611b67d8','9738c747-c00e-4588-a4fc-1b74dcfd85e6','96fd1e65-3ff0-4f2f-9250-45c4aa1d4104','suggested','838a72af-1fe1-4e6a-b804-3e0005703408','reason A1','2026-08-13T23:19:21.855+00','2026-08-13T23:19:21.855+00'),
 ('c2444511-e3d5-43e5-ae4d-b29e42576bca','9738c747-c00e-4588-a4fc-1b74dcfd85e6','9ae6f563-ae0b-492e-b2ae-a7b24024c76c','suggested','838a72af-1fe1-4e6a-b804-3e0005703408','reason A2','2026-08-13T23:19:21.855+00','2026-08-13T23:19:21.855+00'),
 ('87d02f58-a954-4904-9718-08d7740fca3c','a8111428-6825-49c3-a2a0-419cd8b11b52','7365cb8f-3ecf-437e-9a66-1b59d1e12f2d','suggested','1f0db080-9094-4db4-a741-18a134389139','reason B1','2026-08-13T23:19:19.507+00','2026-08-13T23:19:19.507+00'),
 ('18c2a37d-9680-4d98-8911-e5df318fa572','a8111428-6825-49c3-a2a0-419cd8b11b52','fe06c087-c82e-445a-a3cf-6b44dd542574','suggested','1f0db080-9094-4db4-a741-18a134389139','reason B2','2026-08-13T23:19:19.507+00','2026-08-13T23:19:19.507+00'),
 ('77f368e5-fa2a-4ed1-b38c-5379c7dbcea8','d11d1c98-e016-497f-9308-e5a4f3caa146','7a5789ae-5d9d-4d7d-b175-a14bf25de2b1','suggested','3b424572-0ec9-43af-933d-b72de1ed6c11','reason C1','2026-08-13T23:19:19.275+00','2026-08-13T23:19:19.275+00'),
 ('212363e9-4e15-4225-be65-73c1077b56de','d11d1c98-e016-497f-9308-e5a4f3caa146','d9168bc9-8674-41ad-a2cd-2fd07ec24e5e','suggested','3b424572-0ec9-43af-933d-b72de1ed6c11','reason C2','2026-08-13T23:19:19.275+00','2026-08-13T23:19:19.275+00'),
 ('dbfbff2a-baa9-45af-8bc6-07fec628e442','d5a385d5-5526-4c8e-b17b-74a371b7fd6d','889f4b2e-90c4-4a3d-a344-5c11ce971679','suggested','4f7f5f15-9ecb-40cb-9819-d2e211eb1674','reason D1','2026-08-13T23:19:20.684+00','2026-08-13T23:19:20.684+00'),
 ('46d19e29-e9f0-4ddc-9d14-0098fd9c08c6','d5a385d5-5526-4c8e-b17b-74a371b7fd6d','e0c4e38d-0868-4f17-a79a-7313fec0a8b7','suggested','4f7f5f15-9ecb-40cb-9819-d2e211eb1674','reason D2','2026-08-13T23:19:20.684+00','2026-08-13T23:19:20.684+00');

-- SIX UNRELATED pre-existing wrong-status rows, on members OUTSIDE the manifest. They reproduce the
-- production baseline (batches_with_wrong_status_rows = 6) that must be proven disjoint and left
-- exactly as found: an active batch holding archived rows, and a queued batch holding a passed row.
INSERT INTO public.recommendation_batches (batch_id, member_id, batch_source, state, created_at, generated_at, displayed_at) VALUES
 ('aaaa1111-0000-4000-8000-00000000ff01','11111111-2222-4333-8444-555555555501','weekly','active', now(), now(), now()),
 ('aaaa1111-0000-4000-8000-00000000ff02','11111111-2222-4333-8444-555555555502','weekly','active', now(), now(), now()),
 ('aaaa1111-0000-4000-8000-00000000ff03','11111111-2222-4333-8444-555555555503','weekly','queued', now(), now(), NULL);
INSERT INTO public.intro_requests (requester_id, target_user_id, status, batch_id, created_at, updated_at) VALUES
 ('11111111-2222-4333-8444-555555555501','11111111-2222-4333-8444-555555555504','archived','aaaa1111-0000-4000-8000-00000000ff01', now(), now()),
 ('11111111-2222-4333-8444-555555555501','96fd1e65-3ff0-4f2f-9250-45c4aa1d4104','archived','aaaa1111-0000-4000-8000-00000000ff01', now(), now()),
 ('11111111-2222-4333-8444-555555555502','11111111-2222-4333-8444-555555555504','archived','aaaa1111-0000-4000-8000-00000000ff02', now(), now()),
 ('11111111-2222-4333-8444-555555555502','9ae6f563-ae0b-492e-b2ae-a7b24024c76c','passed','aaaa1111-0000-4000-8000-00000000ff02', now(), now()),
 ('11111111-2222-4333-8444-555555555503','11111111-2222-4333-8444-555555555504','passed','aaaa1111-0000-4000-8000-00000000ff03', now(), now()),
 ('11111111-2222-4333-8444-555555555503','7365cb8f-3ecf-437e-9a66-1b59d1e12f2d','suggested','aaaa1111-0000-4000-8000-00000000ff03', now(), now());
