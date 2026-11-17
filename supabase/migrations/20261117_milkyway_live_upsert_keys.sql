-- Repair uniqueness drift for LIVE room member and settings UPSERT conflict targets.
begin;

-- A room has one current row per member. Keep the most recently updated state if an older
-- deployment allowed duplicate rows before installing the composite uniqueness key.
delete from public.mw_live_room_members as member
using (
  select ctid,
         row_number() over (
           partition by room_name, user_id
           order by updated_at desc nulls last, ctid desc
         ) as row_number
  from public.mw_live_room_members
) as duplicate
where member.ctid = duplicate.ctid
  and duplicate.row_number > 1;

create unique index if not exists mw_live_room_members_room_user_uidx
  on public.mw_live_room_members (room_name, user_id);

-- Settings UPSERTs also require a single settings row per Live room.
delete from public.mw_live_room_settings as setting
using (
  select ctid,
         row_number() over (
           partition by room_name
           order by updated_at desc nulls last, ctid desc
         ) as row_number
  from public.mw_live_room_settings
) as duplicate
where setting.ctid = duplicate.ctid
  and duplicate.row_number > 1;

create unique index if not exists mw_live_room_settings_room_name_uidx
  on public.mw_live_room_settings (room_name);

commit;

notify pgrst, 'reload schema';
