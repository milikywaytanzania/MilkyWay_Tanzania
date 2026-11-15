-- MilkyWay owner dashboard: the app owner (mw_is_admin()) can remove any post and end any LIVE from the in-app Admin panel.
-- Idempotent. Included in supabase/milkyway-schema-repair.sql.
begin;

create or replace function public.mw_admin_delete_post(p_post uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.mw_is_admin() then raise exception 'Not allowed.' using errcode = '42501'; end if;
  delete from public.mw_posts where id = p_post;
  if not found then raise exception 'Post not found.' using errcode = 'P0002'; end if;
end $$;

create or replace function public.mw_admin_end_live(p_room text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.mw_is_admin() then raise exception 'Not allowed.' using errcode = '42501'; end if;
  update public.mw_video_live_sessions set is_live = false where room_name = p_room;
  begin
    execute 'update public.mw_video_live_sessions set ended_at = now() where room_name = $1 and ended_at is null' using p_room;
  exception when undefined_column then null;
  end;
end $$;

revoke all on function public.mw_admin_delete_post(uuid) from public, anon;
revoke all on function public.mw_admin_end_live(text) from public, anon;
grant execute on function public.mw_admin_delete_post(uuid) to authenticated;
grant execute on function public.mw_admin_end_live(text) to authenticated;

commit;
