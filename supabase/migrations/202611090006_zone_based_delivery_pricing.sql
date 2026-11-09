-- Yosif Orders: derive delivery charges from the active server-side zone.
begin;

create or replace function public.enforce_order_delivery_zone()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_zone record;
begin
  if new.latitude is not null and new.longitude is not null then
    select dz.id,dz.name,dz.delivery_fee,dz.min_order into v_zone
    from public.delivery_zones dz
    where dz.active = true and public.delivery_point_inside_polygon(new.latitude,new.longitude,dz.polygon)
    order by dz.created_at asc limit 1;
    if not found then raise exception 'Customer location is outside active delivery zones'; end if;
    new.shipping_fee := coalesce(v_zone.delivery_fee,0);
  end if;
  return new;
end;
$$;

-- GPS orders use the server-calculated zone fee, not a browser-supplied fee.
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
  v_zone record;
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

  if v_order.latitude is not null and v_order.longitude is not null then
    select dz.id,dz.name,dz.delivery_fee,dz.min_order into v_zone
    from public.delivery_zones dz
    where dz.active = true and public.delivery_point_inside_polygon(v_order.latitude,v_order.longitude,dz.polygon)
    order by dz.created_at asc limit 1;
    if not found then raise exception 'Customer location is outside active delivery zones'; end if;
    if p_subtotal < coalesce(v_zone.min_order,0) then
      raise exception 'Minimum order for % is %; current subtotal is %',coalesce(v_zone.name,'this delivery zone'),coalesce(v_zone.min_order,0),p_subtotal;
    end if;
    v_shipping := coalesce(v_zone.delivery_fee,0);
  else
    v_shipping := p_shipping_fee;
  end if;
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

commit;