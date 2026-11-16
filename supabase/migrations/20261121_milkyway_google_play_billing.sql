begin;

create table if not exists public.mw_wallet_google_play_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  purchase_token_hash text not null unique check (purchase_token_hash ~ '^[a-f0-9]{64}$'),
  product_id text not null,
  order_id text,
  coins numeric(18,2) not null check (coins > 0),
  coins_after numeric(18,2) not null check (coins_after >= 0),
  created_at timestamptz not null default now()
);
create index if not exists mw_wallet_google_play_purchases_user_idx
  on public.mw_wallet_google_play_purchases (user_id, created_at desc);
alter table public.mw_wallet_google_play_purchases enable row level security;
revoke all on public.mw_wallet_google_play_purchases from public, anon, authenticated;

create or replace function public.mw_wallet_credit_google_play(
  p_user uuid,
  p_purchase_token_hash text,
  p_product_id text,
  p_order_id text,
  p_coins numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  purchase_id uuid := gen_random_uuid();
  previous public.mw_wallet_google_play_purchases;
  wallet_row public.mw_wallets;
  inserted_id uuid;
begin
  if p_user is null
    or p_purchase_token_hash is null
    or p_purchase_token_hash !~ '^[a-f0-9]{64}$'
    or p_product_id is null
    or char_length(p_product_id) > 150
    or p_coins is null
    or p_coins <= 0 then
    raise exception 'Invalid Google Play purchase.';
  end if;

  insert into public.mw_wallet_google_play_purchases (
    id, user_id, purchase_token_hash, product_id, order_id, coins, coins_after
  ) values (
    purchase_id, p_user, p_purchase_token_hash, p_product_id, nullif(left(p_order_id, 200), ''), p_coins, 0
  )
  on conflict (purchase_token_hash) do nothing
  returning id into inserted_id;

  if inserted_id is null then
    select * into previous
    from public.mw_wallet_google_play_purchases
    where purchase_token_hash = p_purchase_token_hash;
    if previous.user_id <> p_user
      or previous.product_id <> p_product_id
      or previous.coins <> p_coins then
      raise exception 'This Google Play purchase was already claimed.';
    end if;
    select * into wallet_row from public.mw_wallets where user_id = p_user;
    return jsonb_build_object(
      'ok', true, 'coins', coalesce(wallet_row.coins, previous.coins_after),
      'added', 0, 'duplicate', true
    );
  end if;

  wallet_row := public.mw_wallet_apply(p_user, p_coins, 0, 0, 'topup', purchase_id);
  update public.mw_wallet_google_play_purchases
  set coins_after = wallet_row.coins
  where id = purchase_id;

  return jsonb_build_object(
    'ok', true, 'coins', wallet_row.coins, 'added', p_coins, 'duplicate', false
  );
end;
$$;

revoke all on function public.mw_wallet_credit_google_play(uuid, text, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.mw_wallet_credit_google_play(uuid, text, text, text, numeric)
  to service_role;

commit;
notify pgrst, 'reload schema';
