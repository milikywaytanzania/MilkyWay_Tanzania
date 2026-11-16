-- Repair drifted LIVE settings columns and publish per-follower post notifications over Supabase Realtime.
begin;

alter table public.mw_live_room_settings
  add column if not exists host_id uuid,
  add column if not exists settings jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

with room_hosts as (
  select room_name, min(host_id::text)::uuid as host_id
  from public.mw_video_live_sessions
  where host_id is not null
  group by room_name
  having count(distinct host_id) = 1
)
update public.mw_live_room_settings as room_settings
set host_id = room_hosts.host_id
from room_hosts
where room_settings.host_id is null
  and room_settings.room_name = room_hosts.room_name;

create unique index if not exists mw_live_room_settings_room_name_key
  on public.mw_live_room_settings (room_name);

alter table public.mw_live_room_settings enable row level security;
drop policy if exists mw_live_settings_read on public.mw_live_room_settings;
create policy mw_live_settings_read on public.mw_live_room_settings
  for select to authenticated using (true);
drop policy if exists mw_live_settings_host on public.mw_live_room_settings;
create policy mw_live_settings_host on public.mw_live_room_settings
  for all to authenticated
  using (public.mw_is_live_host(room_name))
  with check (public.mw_is_live_host(room_name) and host_id = auth.uid());
grant select, insert, update, delete on public.mw_live_room_settings to authenticated;

create table if not exists public.mw_post_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  post_id uuid not null references public.mw_posts(id) on delete cascade,
  actor_name text not null default 'MilkyWay',
  caption text not null default '',
  created_at timestamptz not null default now(),
  unique (recipient_id, post_id)
);
create index if not exists mw_post_notifications_recipient_idx
  on public.mw_post_notifications (recipient_id, created_at desc);

alter table public.mw_post_notifications enable row level security;
drop policy if exists mw_post_notifications_recipient_read on public.mw_post_notifications;
create policy mw_post_notifications_recipient_read on public.mw_post_notifications
  for select to authenticated using (recipient_id = auth.uid());
revoke all on public.mw_post_notifications from anon, authenticated;
grant select on public.mw_post_notifications to authenticated;

create or replace function public.mw_notify_post_followers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.mw_post_notifications
    (recipient_id, actor_id, post_id, actor_name, caption)
  select follow.follower_id, new.author_id::uuid, new.id,
         coalesce(nullif(to_jsonb(author)->>'display_name', ''),
                  nullif(to_jsonb(new)->>'author_name', ''), 'MilkyWay'),
         left(coalesce(new.caption, ''), 180)
  from public.mw_follows as follow
  join public.mw_profiles as recipient on recipient.id::text = follow.follower_id::text
  left join public.mw_profiles as author on author.id::text = new.author_id::text
  where follow.following_id::text = new.author_id::text
    and follow.follower_id::text <> new.author_id::text
    and coalesce(to_jsonb(recipient)->>'is_banned', 'false') <> 'true'
    and not exists (
      select 1
      from public.mw_blocks as block
      where (block.blocker_id::text = new.author_id::text and block.blocked_id::text = follow.follower_id::text)
         or (block.blocker_id::text = follow.follower_id::text and block.blocked_id::text = new.author_id::text)
    )
    and not exists (
      select 1 from public.mw_post_audience as audience
      where audience.post_id = new.id and audience.audience = 'only_me'
    )
  on conflict (recipient_id, post_id) do nothing;
  return new;
end;
$$;

revoke all on function public.mw_notify_post_followers() from public, anon, authenticated;
drop trigger if exists mw_posts_notify_followers on public.mw_posts;
create trigger mw_posts_notify_followers
  after insert on public.mw_posts
  for each row execute function public.mw_notify_post_followers();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'mw_post_notifications'
    ) then
    alter publication supabase_realtime add table public.mw_post_notifications;
  end if;
end $$;

commit;
notify pgrst, 'reload schema';
