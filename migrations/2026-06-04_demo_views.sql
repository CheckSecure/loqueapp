-- Andrel | demo engagement analytics | 2026-06-04
create table if not exists public.demo_views (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  ref_code    text,
  event_type  text not null check (event_type in ('page_view', 'video_start', 'video_complete')),
  session_id  text not null,
  user_agent  text
);

create index if not exists demo_views_created_at_idx
  on public.demo_views (created_at desc);

create index if not exists demo_views_ref_code_idx
  on public.demo_views (ref_code)
  where ref_code is not null;

alter table public.demo_views enable row level security;
-- No policies: service role (used by /api/demo/track) bypasses RLS;
-- anon/authenticated roles have no read or write access.
