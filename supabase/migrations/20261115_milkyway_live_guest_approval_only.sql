-- Guests reach the LIVE stage only through the host's approval.
-- Viewers may write their own member row as 'viewer' or 'pending' (request to join / cancel / leave). The 'speaker'
-- state — which the token gateway uses to sign publisher tokens — can only be written by the host (or by the server
-- acting for the host). The old "anyone can join" (admission = 'direct') exception is removed.
drop policy if exists mw_live_members_self on public.mw_live_room_members;
create policy mw_live_members_self on public.mw_live_room_members for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and state in ('viewer', 'pending') and host_muted = false);

-- Rooms saved with the retired admission mode fall back to request & approve.
update public.mw_live_room_settings
   set settings = jsonb_set(settings, '{admission}', '"approval"')
 where settings ->> 'admission' = 'direct';

notify pgrst, 'reload schema';
