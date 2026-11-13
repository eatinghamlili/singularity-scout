-- Singularity Scout database (Supabase / Postgres).
-- Already applied to the singularity-scout project. Kept here so the setup can be
-- recreated in a new project: paste into Supabase → SQL Editor → Run.

-- Every board record is one JSON document addressed by a path, e.g. 'scouts/om0x234a',
-- 'events/2026-USCALACAS1', 'events/2026-USCALACAS1/teams/49', 'events/2026-USCALACAS2/matches/Q-0-12'.
create table public.docs (
  path text primary key,
  parent text generated always as (regexp_replace(path, '/[^/]+$', '')) stored,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index docs_parent_idx on public.docs (parent);

-- Only the board's own record shapes, and nothing huge.
create or replace function public.docs_path_ok(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p ~ '^(settings/main|scouts/[A-Za-z0-9_-]{1,40}|requests/[0-9]{4}-[A-Z0-9]{1,30}|events/[0-9]{4}-[A-Z0-9]{1,30}|events/[0-9]{4}-[A-Z0-9]{1,30}/teams/[0-9]{1,6}|events/[0-9]{4}-[A-Z0-9]{1,30}/matches/[A-Za-z0-9_-]{1,24})$'
$$;

create or replace function public.docs_shape_ok(p text, d jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(d) = 'object'
     and pg_column_size(d) < 200000
     and case
       when p = 'settings/main' then (d - array['us','event','size','weights']) = '{}'::jsonb
       when p like 'scouts/%' then (d - array['name','hash','lead','color','createdAt']) = '{}'::jsonb
                                   and length(coalesce(d->>'name','')) <= 40 and length(coalesce(d->>'hash','')) <= 80
       when p like 'requests/%' then (d - array['season','code','by','at','status','error']) = '{}'::jsonb
       when p ~ '/teams/' then (d - array['number','name','city','ev','season','loadedAt','status','dnp','tags','ratings','notes','aiRecap','mobility']) = '{}'::jsonb
       when p ~ '/matches/' then (d - array['label','notes']) = '{}'::jsonb
       else true
     end
$$;

-- Deep merge: nested objects merge key by key (two scouts' notes on one team never overwrite
-- each other); anything else, including arrays and null, replaces the old value.
create or replace function public.jsonb_deep_merge(a jsonb, b jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb; result jsonb := coalesce(a, '{}'::jsonb);
begin
  if jsonb_typeof(result) <> 'object' or jsonb_typeof(b) <> 'object' then return b; end if;
  for k, v in select * from jsonb_each(b) loop
    if jsonb_typeof(v) = 'object' and jsonb_typeof(result -> k) = 'object' then
      result := jsonb_set(result, array[k], public.jsonb_deep_merge(result -> k, v));
    else
      result := jsonb_set(result, array[k], v, true);
    end if;
  end loop;
  return result;
end $$;

-- Merge a change into one record, creating it if needed. Runs with the caller's rights,
-- so row-level security still applies.
create or replace function public.merge_doc(p_path text, p_patch jsonb) returns void
language sql security invoker set search_path = '' as $$
  insert into public.docs (path, data, updated_at) values (p_path, p_patch, now())
  on conflict (path) do update set data = public.jsonb_deep_merge(public.docs.data, excluded.data), updated_at = now();
$$;

alter table public.docs enable row level security;

-- Anyone with the website can read the board and add scouting (scout codes tell people apart).
create policy "read board" on public.docs for select to anon, authenticated using (true);
create policy "add records" on public.docs for insert to anon, authenticated
  with check (public.docs_path_ok(path) and public.docs_shape_ok(path, data));
create policy "change records" on public.docs for update to anon, authenticated
  using (public.docs_path_ok(path)) with check (public.docs_path_ok(path) and public.docs_shape_ok(path, data));
-- Only roster entries and competition requests can be removed; competitions and teams never are.
create policy "remove scouts and requests" on public.docs for delete to anon, authenticated
  using (path like 'scouts/%' or path like 'requests/%');

grant select, insert, update, delete on public.docs to anon, authenticated;
grant execute on function public.merge_doc(text, jsonb) to anon, authenticated;

-- Live updates to every open board.
alter table public.docs replica identity full;
alter publication supabase_realtime add table public.docs;


-- ---------------------------------------------------------------------------------------------
-- Server-checked sign-in (2026-11-08). Codes move to a private table; the public may only read.
-- All writes go through the `board` edge function (supabase/functions/board), which runs with the
-- service role and checks each change against the signed-in scout.
create extension if not exists pgcrypto;
create table if not exists public.scout_keys (id text primary key, hash text not null unique, updated_at timestamptz not null default now());
alter table public.scout_keys enable row level security;
revoke all on public.scout_keys from anon, authenticated;
create table if not exists public.auth_attempts (ip text not null, at timestamptz not null default now());
create index if not exists auth_attempts_ip_at on public.auth_attempts (ip, at);
alter table public.auth_attempts enable row level security;
revoke all on public.auth_attempts from anon, authenticated;
create table if not exists public.app_secrets (name text primary key, value text not null);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;
insert into public.app_secrets (name, value) values ('token_key', encode(extensions.gen_random_bytes(32), 'hex')) on conflict (name) do nothing;
insert into public.scout_keys (id, hash) select split_part(path, '/', 2), data->>'hash' from public.docs
  where path like 'scouts/%' and coalesce(data->>'hash','') ~ '^[0-9a-f]{64}$' on conflict (id) do update set hash = excluded.hash;
update public.docs set data = data - 'hash' where path like 'scouts/%' and data ? 'hash';
drop policy if exists "add records" on public.docs;
drop policy if exists "change records" on public.docs;
drop policy if exists "remove scouts and requests" on public.docs;
revoke insert, update, delete on public.docs from anon, authenticated;
revoke execute on function public.merge_doc(text, jsonb) from anon, authenticated, public;

-- 2026-11-12 security pass: the public roles only ever read the board. Remove the leftover
-- table permissions they were given by default (they can't be used through the website's API,
-- but there's no reason to have them).
revoke truncate, trigger, references on public.docs from anon, authenticated;

-- 2026-11-12: per-scout hourly limits on saving and photo uploads (used by the board function only).
create table if not exists public.rate_log (sid text not null, kind text not null, n int not null default 1, at timestamptz not null default now());
create index if not exists rate_log_sid_kind_at on public.rate_log (sid, kind, at);
alter table public.rate_log enable row level security;
revoke all on public.rate_log from anon, authenticated;
