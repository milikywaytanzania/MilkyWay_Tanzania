-- Repair deployments where LIVE room members are missing the timestamp used by the API ordering and updates.
begin;

alter table public.mw_live_room_members
  add column if not exists updated_at timestamptz default now();

update public.mw_live_room_members
set updated_at = now()
where updated_at is null;

alter table public.mw_live_room_members
  alter column updated_at set default now(),
  alter column updated_at set not null;

create index if not exists mw_live_room_members_updated_idx
  on public.mw_live_room_members (room_name, updated_at desc);

commit;

notify pgrst, 'reload schema';
