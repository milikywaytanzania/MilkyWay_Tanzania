-- Fixes: new row violates row-level security policy for table "mw_saves".
--
-- Saving a post inserts { post_id, user_id } as the signed-in user (upsert with "ignore duplicates"). The table had no
-- usable INSERT policy for that, so every save was refused. This resets mw_saves to one clear set of rules:
-- people read, add and remove only their own saves. Idempotent: safe to run more than once.
begin;

create table if not exists public.mw_saves (
  post_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
-- Rows written without a user id belong to the caller.
alter table public.mw_saves alter column user_id set default auth.uid();

-- The app upserts on (post_id, user_id), which needs a unique index on exactly those columns.
delete from public.mw_saves a using public.mw_saves b
  where a.ctid < b.ctid and a.post_id = b.post_id and a.user_id = b.user_id;
create unique index if not exists mw_saves_post_user_key on public.mw_saves (post_id, user_id);
create index if not exists mw_saves_user_idx on public.mw_saves (user_id, created_at desc);

alter table public.mw_saves enable row level security;

-- Replace whatever policies exist (some checked the wrong column or only allowed reads).
do $$
declare policy record;
begin
  for policy in select policyname from pg_policies where schemaname = 'public' and tablename = 'mw_saves' loop
    execute format('drop policy if exists %I on public.mw_saves', policy.policyname);
  end loop;
end $$;

create policy mw_saves_select_own on public.mw_saves for select to authenticated using (user_id::text = (select auth.uid())::text);
create policy mw_saves_insert_own on public.mw_saves for insert to authenticated with check (user_id::text = (select auth.uid())::text);
create policy mw_saves_update_own on public.mw_saves for update to authenticated using (user_id::text = (select auth.uid())::text) with check (user_id::text = (select auth.uid())::text);
create policy mw_saves_delete_own on public.mw_saves for delete to authenticated using (user_id::text = (select auth.uid())::text);

revoke all on public.mw_saves from anon;
grant select, insert, update, delete on public.mw_saves to authenticated;

-- Likes ("lights") use the same upsert. Add the missing own-row write rules only where none exist, so the
-- existing read rules (public like counts) stay as they are.
do $$
begin
  if to_regclass('public.mw_signals') is not null then
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'mw_signals' and cmd in ('INSERT', 'ALL')) then
      create policy mw_signals_insert_own on public.mw_signals for insert to authenticated with check (user_id::text = (select auth.uid())::text);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'mw_signals' and cmd in ('DELETE', 'ALL')) then
      create policy mw_signals_delete_own on public.mw_signals for delete to authenticated using (user_id::text = (select auth.uid())::text);
    end if;
    grant select, insert, delete on public.mw_signals to authenticated;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
