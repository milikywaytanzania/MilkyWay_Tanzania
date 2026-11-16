-- Repair drifted LIVE settings schemas where host_id was missing.
begin;

alter table public.mw_live_room_settings
  add column if not exists host_id uuid;

update public.mw_live_room_settings settings
set host_id = sessions.host_id
from public.mw_video_live_sessions sessions
where settings.host_id is null
  and sessions.room_name = settings.room_name;

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

commit;
notify pgrst, 'reload schema';
