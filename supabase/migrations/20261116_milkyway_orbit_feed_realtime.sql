-- Public Orbit reads include all posts from public profiles while the existing privacy and audience policies still gate
-- private accounts, blocked relationships, followers-only posts and only-me posts.
begin;

alter table public.mw_posts enable row level security;
grant select on public.mw_posts to anon, authenticated;
drop policy if exists mw_posts_orbit_read on public.mw_posts;
create policy mw_posts_orbit_read on public.mw_posts for select to anon, authenticated
using (public.mw_profile_posts_visible(author_id::text));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mw_posts'
    ) then
    alter publication supabase_realtime add table public.mw_posts;
  end if;
end $$;

commit;
notify pgrst, 'reload schema';
