begin;

alter table if exists public.mw_profiles add column if not exists username text;

create or replace function public.mw_create_auth_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  handle text := lower(nullif(btrim(new.raw_user_meta_data->>'username'), ''));
begin
  if handle is not null and handle !~ '^[a-z0-9._]{2,30}$' then
    raise exception 'Username must be 2–30 letters, numbers, dots or underscores.';
  end if;

  insert into public.mw_profiles (id, username)
  values (new.id, handle)
  on conflict (id) do update
  set username = coalesce(nullif(public.mw_profiles.username, ''), excluded.username);

  return new;
end;
$$;

drop trigger if exists mw_create_auth_profile on auth.users;
create trigger mw_create_auth_profile
after insert on auth.users
for each row execute function public.mw_create_auth_profile();

revoke all on function public.mw_create_auth_profile() from public;

commit;
