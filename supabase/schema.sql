-- Singularity Scout database (Supabase / Postgres).
-- Already applied to the singularity-scout project. Kept here so the setup can be
-- recreated in a new project: paste into Supabase → SQL Editor → Run.

-- Every board record is one JSON document addressed by a path, e.g. 'scouts/om0x234a',
-- 'events/2026-USCALACAS1', 'events/2026-USCALACAS1/teams/49'.
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
  select p ~ '^(settings/main|scouts/[A-Za-z0-9_-]{1,40}|requests/[0-9]{4}-[A-Z0-9]{1,30}|events/[0-9]{4}-[A-Z0-9]{1,30}|events/[0-9]{4}-[A-Z0-9]{1,30}/teams/[0-9]{1,6})$'
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
