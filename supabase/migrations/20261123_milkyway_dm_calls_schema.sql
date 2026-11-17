-- Repair deployments where the DM calls table was created without the columns used by the call client.
begin;

alter table public.mw_dm_calls
  add column if not exists caller_id uuid references auth.users(id) on delete cascade,
  add column if not exists callee_id uuid references auth.users(id) on delete cascade,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists status text not null default 'ringing';

update public.mw_dm_calls set created_at = now() where created_at is null;
update public.mw_dm_calls set status = 'ringing' where status is null;

alter table public.mw_dm_calls
  alter column created_at set default now(),
  alter column created_at set not null,
  alter column status set default 'ringing',
  alter column status set not null;

create index if not exists mw_dm_calls_incoming_idx
  on public.mw_dm_calls (callee_id, status, created_at desc);

commit;

notify pgrst, 'reload schema';
