begin;

alter table public.mw_posts add column if not exists scheduled_at timestamptz;
create index if not exists mw_posts_scheduled_idx on public.mw_posts (scheduled_at) where scheduled_at is not null;

drop policy if exists mw_posts_read on public.mw_posts;
create policy mw_posts_read on public.mw_posts for select to anon, authenticated
  using (
    (auth.uid() is not null and author_id::text = auth.uid()::text)
    or (
      (scheduled_at is null or scheduled_at <= now())
      and public.mw_profile_posts_visible(author_id::text)
    )
  );
drop policy if exists mw_posts_orbit_read on public.mw_posts;
create policy mw_posts_orbit_read on public.mw_posts for select to anon, authenticated
  using (
    (scheduled_at is null or scheduled_at <= now())
    and public.mw_profile_posts_visible(author_id::text)
  );

create table if not exists public.mw_creator_services (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 80),
  category text not null check (char_length(category) between 2 and 60),
  description text not null check (char_length(description) between 10 and 1000),
  pricing text not null default '' check (char_length(pricing) <= 100),
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mw_creator_services_public_idx
  on public.mw_creator_services (creator_id, created_at desc) where is_published;

create table if not exists public.mw_service_inquiries (
  id uuid primary key default gen_random_uuid(),
  service_id uuid references public.mw_creator_services(id) on delete set null,
  creator_id uuid not null references auth.users(id) on delete cascade,
  requester_id uuid not null references auth.users(id) on delete cascade,
  client_name text not null check (char_length(client_name) between 1 and 80),
  message text not null check (char_length(message) between 10 and 2000),
  preferred_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'completed')),
  creator_reply text check (creator_reply is null or char_length(creator_reply) <= 500),
  created_at timestamptz not null default now(),
  check (creator_id <> requester_id)
);
create index if not exists mw_service_inquiries_creator_idx
  on public.mw_service_inquiries (creator_id, created_at desc);
create index if not exists mw_service_inquiries_requester_idx
  on public.mw_service_inquiries (requester_id, created_at desc);

create table if not exists public.mw_creator_pins (
  creator_id uuid primary key references auth.users(id) on delete cascade,
  post_id uuid not null unique references public.mw_posts(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.mw_post_views (
  post_id uuid not null references public.mw_posts(id) on delete cascade,
  viewer_id uuid not null references auth.users(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (post_id, viewer_id)
);
create index if not exists mw_post_views_viewer_idx on public.mw_post_views (viewer_id, viewed_at desc);

alter table public.mw_creator_services enable row level security;
alter table public.mw_service_inquiries enable row level security;
alter table public.mw_creator_pins enable row level security;
alter table public.mw_post_views enable row level security;

drop policy if exists mw_creator_services_read on public.mw_creator_services;
create policy mw_creator_services_read on public.mw_creator_services for select to anon, authenticated
  using (is_published or creator_id = (select auth.uid()));
drop policy if exists mw_creator_services_owner on public.mw_creator_services;
create policy mw_creator_services_owner on public.mw_creator_services for all to authenticated
  using (creator_id = (select auth.uid()))
  with check (creator_id = (select auth.uid()));

drop policy if exists mw_service_inquiries_read on public.mw_service_inquiries;
create policy mw_service_inquiries_read on public.mw_service_inquiries for select to authenticated
  using (creator_id = (select auth.uid()) or requester_id = (select auth.uid()));
drop policy if exists mw_service_inquiries_request on public.mw_service_inquiries;
create policy mw_service_inquiries_request on public.mw_service_inquiries for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and creator_id <> (select auth.uid())
    and status = 'pending'
    and creator_reply is null
    and exists (
      select 1 from public.mw_creator_services service
      where service.id = mw_service_inquiries.service_id
        and service.creator_id = mw_service_inquiries.creator_id
        and service.is_published
    )
  );
drop policy if exists mw_service_inquiries_creator_update on public.mw_service_inquiries;
create policy mw_service_inquiries_creator_update on public.mw_service_inquiries for update to authenticated
  using (creator_id = (select auth.uid()))
  with check (creator_id = (select auth.uid()));

drop policy if exists mw_creator_pins_read on public.mw_creator_pins;
create policy mw_creator_pins_read on public.mw_creator_pins for select to anon, authenticated using (true);
drop policy if exists mw_creator_pins_owner on public.mw_creator_pins;
create policy mw_creator_pins_owner on public.mw_creator_pins for all to authenticated
  using (creator_id = (select auth.uid()))
  with check (
    creator_id = (select auth.uid())
    and exists (
      select 1 from public.mw_posts post
      where post.id = post_id and post.author_id::text = (select auth.uid())::text
    )
  );

drop policy if exists mw_post_views_creator_read on public.mw_post_views;
create policy mw_post_views_creator_read on public.mw_post_views for select to authenticated
  using (exists (
    select 1 from public.mw_posts post
    where post.id = post_id and post.author_id::text = (select auth.uid())::text
  ));
drop policy if exists mw_post_views_authenticated_insert on public.mw_post_views;
create policy mw_post_views_authenticated_insert on public.mw_post_views for insert to authenticated
  with check (
    viewer_id = (select auth.uid())
    and exists (
      select 1 from public.mw_posts post
      where post.id = post_id and post.author_id::text <> (select auth.uid())::text
    )
  );

grant select on public.mw_creator_services, public.mw_creator_pins to anon, authenticated;
grant insert, update, delete on public.mw_creator_services, public.mw_creator_pins to authenticated;
grant select on public.mw_post_views to authenticated;
grant insert on public.mw_post_views to authenticated;
grant select on public.mw_service_inquiries to authenticated;
grant insert (service_id, creator_id, requester_id, client_name, message, preferred_at)
  on public.mw_service_inquiries to authenticated;
grant update (status, creator_reply) on public.mw_service_inquiries to authenticated;

drop trigger if exists mw_posts_notify_followers on public.mw_posts;
create trigger mw_posts_notify_followers
  after insert on public.mw_posts
  for each row
  when (new.scheduled_at is null or new.scheduled_at <= now())
  execute function public.mw_notify_post_followers();
drop trigger if exists mw_posts_notify_followers_on_publish on public.mw_posts;
create trigger mw_posts_notify_followers_on_publish
  after update of scheduled_at on public.mw_posts
  for each row
  when (new.scheduled_at is null)
  execute function public.mw_notify_post_followers();

commit;
notify pgrst, 'reload schema';
