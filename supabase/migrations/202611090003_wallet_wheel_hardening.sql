-- Yosif Orders: wallet ledger hardening and server-authoritative daily wheel.
-- Manual migration only. Review against the live schema before applying.
-- Does not modify existing balances or customer/order rows.

begin;

-- Record debit amounts as positive magnitudes; direction is represented by
-- transaction_type. This is compatible with wallet_transactions.amount >= 0.
create or replace function public.adjust_customer_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_description text default 'تعديل رصيد من الإدارة'
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric(12,2);
  v_new_balance numeric(12,2);
  v_type text;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_user_id is null or p_amount is null or abs(p_amount) > 1000000 then
    raise exception 'Invalid wallet adjustment';
  end if;

  insert into public.wallets(user_id,balance)
  values (p_user_id,0)
  on conflict (user_id) do nothing;

  select balance into v_balance
  from public.wallets
  where user_id = p_user_id
  for update;

  v_new_balance := v_balance + p_amount;
  if v_new_balance < 0 then raise exception 'Insufficient wallet balance'; end if;
  if v_new_balance > 1000000 then raise exception 'Wallet balance limit exceeded'; end if;

  if p_amount = 0 then return v_balance; end if;

  update public.wallets
  set balance = v_new_balance, updated_at = now()
  where user_id = p_user_id;

  v_type := case when p_amount > 0 then 'admin_credit' else 'admin_debit' end;
  insert into public.wallet_transactions(
    user_id,amount,balance_after,performed_by,transaction_type,description
  ) values (
    p_user_id,abs(p_amount),v_new_balance,auth.uid(),v_type,
    left(coalesce(p_description,'تعديل رصيد من الإدارة'),500)
  );

  return v_new_balance;
end;
$$;

revoke all on function public.adjust_customer_wallet(uuid,numeric,text) from public, anon;
grant execute on function public.adjust_customer_wallet(uuid,numeric,text) to authenticated;

-- Explicit set-balance operation supports setting a customer's balance to zero.
-- The ledger stores the positive magnitude and identifies direction by type.
create or replace function public.set_customer_wallet_balance(
  p_user_id uuid,
  p_new_balance numeric,
  p_description text default 'تسوية رصيد من الإدارة'
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old numeric(12,2);
  v_delta numeric(12,2);
  v_type text;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_user_id is null or p_new_balance is null
     or p_new_balance < 0 or p_new_balance > 1000000 then
    raise exception 'Invalid target balance';
  end if;

  insert into public.wallets(user_id,balance)
  values (p_user_id,0)
  on conflict (user_id) do nothing;

  select balance into v_old
  from public.wallets where user_id = p_user_id for update;

  v_delta := p_new_balance - v_old;
  if v_delta = 0 then return v_old; end if;

  update public.wallets
  set balance = p_new_balance, updated_at = now()
  where user_id = p_user_id;

  v_type := case when v_delta > 0 then 'admin_credit' else 'admin_debit' end;
  insert into public.wallet_transactions(
    user_id,amount,balance_after,performed_by,transaction_type,description
  ) values (
    p_user_id,abs(v_delta),p_new_balance,auth.uid(),v_type,
    left(coalesce(p_description,'تسوية رصيد من الإدارة'),500)
  );

  return p_new_balance;
end;
$$;

revoke all on function public.set_customer_wallet_balance(uuid,numeric,text) from public, anon;
grant execute on function public.set_customer_wallet_balance(uuid,numeric,text) to authenticated;

-- Daily wheel spin. A row lock on the singleton settings row serializes spin
-- attempts, preventing simultaneous requests from exceeding the daily limit.
-- rewards JSON array entries: { "type":"wallet|discount|free_delivery",
-- "value": number, "label": string, "expires_in_days": integer }
create or replace function public.spin_customer_wheel()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_settings public.spin_settings%rowtype;
  v_count integer;
  v_index integer;
  v_reward jsonb;
  v_type text;
  v_value numeric(12,2);
  v_expires integer;
  v_balance numeric(12,2);
  v_reward_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;

  select * into v_settings
  from public.spin_settings
  where id = 1
  for update;

  if not found or coalesce(v_settings.enabled,false) is not true then
    raise exception 'Wheel is currently disabled';
  end if;
  if coalesce(v_settings.daily_limit,0) < 1 or v_settings.daily_limit > 50 then
    raise exception 'Invalid daily spin limit';
  end if;

  select count(*) into v_count
  from public.spin_logs
  where user_id = v_user
    and created_at >= date_trunc('day',now())
    and created_at < date_trunc('day',now()) + interval '1 day';

  if v_count >= v_settings.daily_limit then
    raise exception 'Daily spin limit reached';
  end if;

  if jsonb_typeof(v_settings.rewards) <> 'array'
     or jsonb_array_length(v_settings.rewards) = 0 then
    raise exception 'No wheel rewards configured';
  end if;

  v_index := floor(random() * jsonb_array_length(v_settings.rewards))::integer;
  v_reward := v_settings.rewards -> v_index;
  v_type := v_reward ->> 'type';
  v_value := coalesce((v_reward ->> 'value')::numeric,0);
  v_expires := greatest(1,least(coalesce((v_reward ->> 'expires_in_days')::integer,7),90));

  if v_type not in ('wallet','discount','free_delivery') then
    raise exception 'Unsupported reward type';
  end if;
  if v_value < 0 or v_value > 100000 then raise exception 'Invalid reward value'; end if;
  if v_type = 'discount' and v_value > 100 then
    raise exception 'Discount percentage cannot exceed 100';
  end if;
  if v_type = 'wallet' and v_value <= 0 then
    raise exception 'Wallet reward must be positive';
  end if;

  if v_type = 'wallet' then
    insert into public.wallets(user_id,balance)
    values (v_user,0)
    on conflict (user_id) do nothing;

    select balance into v_balance
    from public.wallets where user_id = v_user for update;

    if v_balance + v_value > 1000000 then raise exception 'Wallet balance limit exceeded'; end if;

    update public.wallets
    set balance = balance + v_value, updated_at = now()
    where user_id = v_user;

    insert into public.wallet_transactions(
      user_id,amount,balance_after,transaction_type,description
    ) values (
      v_user,v_value,v_balance + v_value,'spin_reward',
      left(coalesce(v_reward->>'label','مكافأة عجلة الحظ'),500)
    );
  else
    insert into public.customer_rewards(
      user_id,reward_value,expires_at,reward_type,source
    ) values (
      v_user,v_value,now() + make_interval(days => v_expires),v_type,'spin'
    ) returning id into v_reward_id;
  end if;

  insert into public.spin_logs(user_id,reward)
  values (v_user,v_reward);

  return jsonb_build_object(
    'success',true,
    'reward',v_reward,
    'reward_id',v_reward_id,
    'wallet_balance',case when v_type = 'wallet' then v_balance + v_value else null end,
    'spins_used_today',v_count + 1,
    'daily_limit',v_settings.daily_limit
  );
end;
$$;

revoke all on function public.spin_customer_wheel() from public, anon;
grant execute on function public.spin_customer_wheel() to authenticated;

commit;
