-- Yosif Orders: transactional order pricing, promotions, wallet debit/refund.
-- Apply manually in Supabase after reviewing the live schema.
begin;

alter table public.orders
  add column if not exists coupon_id uuid,
  add column if not exists reward_id uuid,
  add column if not exists discount_amount numeric(12,2) not null default 0,
  add column if not exists wallet_used numeric(12,2) not null default 0,
  add column if not exists wallet_refunded_at timestamptz;

-- Attach a coupon and/or an unused customer reward to an order before pricing.
create or replace function public.set_order_promotions(
  p_order_id uuid,
  p_coupon_code text default null,
  p_reward_id uuid default null
) returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  v_user uuid := auth.uid();
  v_order public.orders%rowtype;
  v_coupon public.coupons%rowtype;
  v_reward public.customer_rewards%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.customer_id <> v_user then raise exception 'Order not found'; end if;
  if v_order.status <> 'pending_review' then raise exception 'Promotions can only be selected before pricing'; end if;

  if nullif(trim(coalesce(p_coupon_code,'')),'') is not null then
    select * into v_coupon from public.coupons
    where upper(code)=upper(trim(p_coupon_code)) and active=true
    for update;
    if not found then raise exception 'Coupon is invalid or inactive'; end if;
    if v_coupon.starts_at is not null and v_coupon.starts_at > now() then raise exception 'Coupon is not active yet'; end if;
    if v_coupon.ends_at is not null and v_coupon.ends_at < now() then raise exception 'Coupon has expired'; end if;
    if v_coupon.usage_limit is not null and v_coupon.used_count >= v_coupon.usage_limit then raise exception 'Coupon usage limit reached'; end if;
  else
    v_coupon.id := null;
  end if;

  if p_reward_id is not null then
    select * into v_reward from public.customer_rewards
    where id=p_reward_id and user_id=v_user and used_at is null
      and (expires_at is null or expires_at > now())
    for update;
    if not found then raise exception 'Reward is unavailable or expired'; end if;
  end if;

  update public.orders set coupon_id=v_coupon.id, reward_id=p_reward_id
  where id=p_order_id;

  return jsonb_build_object('success',true,'coupon_id',v_coupon.id,'reward_id',p_reward_id);
end;
$$;
revoke all on function public.set_order_promotions(uuid,text,uuid) from public,anon;
grant execute on function public.set_order_promotions(uuid,text,uuid) to authenticated;

-- Admin-only first pricing pass. All discounts, fees and wallet debit are
-- calculated here under row locks; the browser never supplies a payable total.
create or replace function public.admin_save_order_pricing(
  p_order_id uuid,
  p_subtotal numeric,
  p_shipping_fee numeric,
  p_tip numeric,
  p_status text
) returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  v_order public.orders%rowtype;
  v_coupon public.coupons%rowtype;
  v_reward public.customer_rewards%rowtype;
  v_wallet numeric(12,2);
  v_discount numeric(12,2):=0;
  v_coupon_discount numeric(12,2):=0;
  v_reward_discount numeric(12,2):=0;
  v_shipping numeric(12,2);
  v_fee numeric(12,2):=0;
  v_total numeric(12,2);
  v_base numeric(12,2);
  v_coupon_type text;
  v_reward_type text;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_status not in ('priced','preparing','courier_near','out_for_delivery','delivered') then
    raise exception 'Unsupported order status for pricing';
  end if;
  if p_subtotal is null or p_shipping_fee is null or p_tip is null
     or p_subtotal < 0 or p_shipping_fee < 0 or p_tip < 0
     or p_subtotal > 1000000 or p_shipping_fee > 100000 or p_tip > 10000 then
    raise exception 'Invalid order amounts';
  end if;

  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if v_order.status='cancelled' then raise exception 'Cancelled orders cannot be reopened'; end if;
  if v_order.status <> 'pending_review' then
    -- Subsequent status transitions do not re-charge or re-apply promotions.
    update public.orders set status=p_status,updated_at=now() where id=p_order_id;
    insert into public.order_events(order_id,status,note)
      values(p_order_id,p_status,'تحديث حالة الطلب');
    return jsonb_build_object('success',true,'status',p_status,'already_priced',true);
  end if;

  v_shipping := p_shipping_fee;
  if v_order.reward_id is not null then
    select * into v_reward from public.customer_rewards
    where id=v_order.reward_id and user_id=v_order.customer_id and used_at is null
      and (expires_at is null or expires_at > now())
    for update;
    if not found then raise exception 'Selected reward is no longer available'; end if;
    v_reward_type := lower(v_reward.reward_type);
    if v_reward_type='free_delivery' then v_shipping := 0; end if;
  end if;
  v_base := p_subtotal + v_shipping;

  if v_order.coupon_id is not null then
    select * into v_coupon from public.coupons where id=v_order.coupon_id for update;
    if not found or v_coupon.active is not true
      or (v_coupon.starts_at is not null and v_coupon.starts_at > now())
      or (v_coupon.ends_at is not null and v_coupon.ends_at < now())
      or (v_coupon.usage_limit is not null and v_coupon.used_count >= v_coupon.usage_limit) then
      raise exception 'Selected coupon is no longer valid';
    end if;
    v_coupon_type := lower(v_coupon.discount_type);
    if v_coupon_type in ('percentage','percent') then
      v_coupon_discount := round(v_base * least(greatest(v_coupon.discount_value,0),100) / 100,2);
    elsif v_coupon_type in ('fixed','amount','fixed_amount') then
      v_coupon_discount := least(greatest(v_coupon.discount_value,0),v_base);
    else
      raise exception 'Unsupported coupon discount type';
    end if;
    update public.coupons set used_count=coalesce(used_count,0)+1 where id=v_coupon.id;
  end if;

  if v_order.reward_id is not null then
    if v_reward_type='percentage_discount' then
      v_reward_discount := round(greatest(0,v_base-v_coupon_discount) * least(greatest(v_reward.reward_value,0),100) / 100,2);
    elsif v_reward_type='fixed_discount' then
      v_reward_discount := least(greatest(v_reward.reward_value,0),greatest(0,v_base-v_coupon_discount));
    elsif v_reward_type <> 'free_delivery' then
      raise exception 'Selected reward type cannot be redeemed at checkout';
    end if;
    update public.customer_rewards set used_at=now() where id=v_reward.id;
  end if;

  v_discount := least(v_base,v_coupon_discount+v_reward_discount);
  if v_order.payment_method='instapay' then
    v_fee := 2;
  elsif v_order.payment_method='wallet' then
    v_fee := round(greatest(0,p_subtotal+v_shipping-v_discount)*0.01,2);
  end if;
  v_total := greatest(0,p_subtotal+v_shipping+p_tip-v_discount+v_fee);

  if v_order.payment_method='wallet' then
    insert into public.wallets(user_id,balance) values(v_order.customer_id,0)
      on conflict(user_id) do nothing;
    select balance into v_wallet from public.wallets where user_id=v_order.customer_id for update;
    if v_total>0 then
      if v_wallet < v_total then raise exception 'Insufficient wallet balance: required %, available %',v_total,v_wallet; end if;
      update public.wallets set balance=v_wallet-v_total,updated_at=now() where user_id=v_order.customer_id;
      insert into public.wallet_transactions(user_id,amount,balance_after,performed_by,transaction_type,description,order_id)
        values(v_order.customer_id,v_total,v_wallet-v_total,auth.uid(),'order_debit','دفع الطلب من المحفظة',p_order_id);
    end if;
  end if;

  update public.orders set
    subtotal=p_subtotal,shipping_fee=v_shipping,tip=p_tip,payment_fee=v_fee,
    discount_amount=v_discount,wallet_used=case when payment_method='wallet' then v_total else 0 end,
    total=v_total,status=p_status,updated_at=now()
  where id=p_order_id;

  insert into public.order_events(order_id,status,note)
    values(p_order_id,p_status,'تم التسعير وتطبيق الخصومات وحساب الإجمالي على الخادم');

  return jsonb_build_object('success',true,'subtotal',p_subtotal,'shipping_fee',v_shipping,
    'discount_amount',v_discount,'payment_fee',v_fee,'total',v_total,
    'wallet_used',case when v_order.payment_method='wallet' then v_total else 0 end);
end;
$$;
revoke all on function public.admin_save_order_pricing(uuid,numeric,numeric,numeric,text) from public,anon;
grant execute on function public.admin_save_order_pricing(uuid,numeric,numeric,numeric,text) to authenticated;

-- Cancellation and wallet refund are one transaction. wallet_refunded_at plus
-- the locked order makes repeated cancellation requests idempotent.
create or replace function public.admin_cancel_order(p_order_id uuid,p_note text default 'تم إلغاء الطلب')
returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  v_order public.orders%rowtype;
  v_balance numeric(12,2);
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if v_order.status='cancelled' then
    return jsonb_build_object('success',true,'already_cancelled',true,'refunded',false);
  end if;
  if v_order.status='delivered' then raise exception 'Delivered orders cannot be cancelled through this flow'; end if;

  if coalesce(v_order.wallet_used,0)>0 and v_order.wallet_refunded_at is null then
    insert into public.wallets(user_id,balance) values(v_order.customer_id,0)
      on conflict(user_id) do nothing;
    select balance into v_balance from public.wallets where user_id=v_order.customer_id for update;
    update public.wallets set balance=v_balance+v_order.wallet_used,updated_at=now()
      where user_id=v_order.customer_id;
    insert into public.wallet_transactions(user_id,amount,balance_after,performed_by,transaction_type,description,order_id)
      values(v_order.customer_id,v_order.wallet_used,v_balance+v_order.wallet_used,auth.uid(),'order_refund','استرداد قيمة الطلب الملغي',p_order_id);
    update public.orders set wallet_refunded_at=now(),wallet_used=0 where id=p_order_id;
  end if;

  if v_order.coupon_id is not null and v_order.status <> 'pending_review' then
    update public.coupons set used_count=greatest(0,coalesce(used_count,0)-1) where id=v_order.coupon_id;
  end if;
  if v_order.reward_id is not null then
    update public.customer_rewards set used_at=null where id=v_order.reward_id and user_id=v_order.customer_id;
  end if;
  update public.orders set status='cancelled',updated_at=now() where id=p_order_id;
  insert into public.order_events(order_id,status,note)
    values(p_order_id,'cancelled',left(coalesce(p_note,'تم إلغاء الطلب'),500));
  return jsonb_build_object('success',true,'refunded',coalesce(v_order.wallet_used,0)>0);
end;
$$;
revoke all on function public.admin_cancel_order(uuid,text) from public,anon;
grant execute on function public.admin_cancel_order(uuid,text) to authenticated;

-- Ensure wheel discount prizes satisfy the existing customer_rewards CHECK:
-- wallet rewards go to the wallet; discount rewards use percentage_discount.
create or replace function public.spin_customer_wheel()
returns jsonb language plpgsql security definer set search_path=public
as $$
declare
  v_user uuid:=auth.uid();
  v_settings public.spin_settings%rowtype;
  v_count integer;
  v_index integer;
  v_reward jsonb;
  v_type text;
  v_value numeric(12,2);
  v_expires integer;
  v_balance numeric(12,2);
  v_reward_id uuid;
  v_reward_type text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_settings from public.spin_settings where id=1 for update;
  if not found or coalesce(v_settings.enabled,false) is not true then raise exception 'Wheel is currently disabled'; end if;
  if coalesce(v_settings.daily_limit,0)<1 or v_settings.daily_limit>50 then raise exception 'Invalid daily spin limit'; end if;
  select count(*) into v_count from public.spin_logs
    where user_id=v_user and created_at>=date_trunc('day',now())
      and created_at<date_trunc('day',now())+interval '1 day';
  if v_count>=v_settings.daily_limit then raise exception 'Daily spin limit reached'; end if;
  if jsonb_typeof(v_settings.rewards)<>'array' or jsonb_array_length(v_settings.rewards)=0 then
    raise exception 'No wheel rewards configured';
  end if;
  v_index:=floor(random()*jsonb_array_length(v_settings.rewards))::integer;
  v_reward:=v_settings.rewards->v_index;
  v_type:=v_reward->>'type';
  v_value:=coalesce((v_reward->>'value')::numeric,0);
  v_expires:=greatest(1,least(coalesce((v_reward->>'expires_in_days')::integer,7),90));
  if v_type not in ('wallet','discount','free_delivery') then raise exception 'Unsupported reward type'; end if;
  if v_value<0 or v_value>100000 then raise exception 'Invalid reward value'; end if;
  if v_type='discount' and (v_value<=0 or v_value>100) then raise exception 'Discount percentage must be between 1 and 100'; end if;
  if v_type='wallet' and v_value<=0 then raise exception 'Wallet reward must be positive'; end if;

  if v_type='wallet' then
    insert into public.wallets(user_id,balance) values(v_user,0) on conflict(user_id) do nothing;
    select balance into v_balance from public.wallets where user_id=v_user for update;
    if v_balance+v_value>1000000 then raise exception 'Wallet balance limit exceeded'; end if;
    update public.wallets set balance=balance+v_value,updated_at=now() where user_id=v_user;
    insert into public.wallet_transactions(user_id,amount,balance_after,transaction_type,description)
      values(v_user,v_value,v_balance+v_value,'spin_reward',left(coalesce(v_reward->>'label','مكافأة عجلة الحظ'),500));
  else
    v_reward_type:=case when v_type='discount' then 'percentage_discount' else 'free_delivery' end;
    insert into public.customer_rewards(user_id,reward_value,expires_at,reward_type,source)
      values(v_user,v_value,now()+make_interval(days=>v_expires),v_reward_type,'spin')
      returning id into v_reward_id;
  end if;
  insert into public.spin_logs(user_id,reward) values(v_user,v_reward);
  return jsonb_build_object('success',true,'reward',v_reward,'reward_id',v_reward_id,
    'wallet_balance',case when v_type='wallet' then v_balance+v_value else null end,
    'spins_used_today',v_count+1,'daily_limit',v_settings.daily_limit);
end;
$$;
revoke all on function public.spin_customer_wheel() from public,anon;
grant execute on function public.spin_customer_wheel() to authenticated;

commit;
