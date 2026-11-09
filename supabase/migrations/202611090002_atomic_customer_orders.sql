-- Yosif Orders: atomic customer order creation and line-item pricing.
-- Apply manually only after reviewing the target Supabase schema.

begin;

create or replace function public.create_customer_order(
  p_phone text,
  p_custom_request text,
  p_customer_notes text default null,
  p_attached_images jsonb default '[]'::jsonb,
  p_payment_method text default 'cash',
  p_tip numeric default 0,
  p_items jsonb default '[]'::jsonb,
  p_scheduled_for timestamptz default null,
  p_latitude double precision default null,
  p_longitude double precision default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_order_id uuid;
  v_order_no bigint;
  v_subtotal numeric(12,2) := 0;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty numeric;
  v_count integer := 0;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if length(trim(coalesce(p_phone,''))) < 8 or length(p_phone) > 30 then
    raise exception 'Invalid phone number';
  end if;
  if length(trim(coalesce(p_custom_request,''))) = 0 or length(p_custom_request) > 2000 then
    raise exception 'Order description is required';
  end if;
  if p_payment_method not in ('cash','instapay','wallet','tab') then
    raise exception 'Unsupported payment method';
  end if;
  if coalesce(p_tip,0) < 0 or p_tip > 10000 then raise exception 'Invalid tip'; end if;
  if jsonb_typeof(coalesce(p_items,'[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_items,'[]'::jsonb)) > 100 then
    raise exception 'Invalid order items';
  end if;
  if jsonb_typeof(coalesce(p_attached_images,'[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_attached_images,'[]'::jsonb)) > 10 then
    raise exception 'Invalid image list';
  end if;

  -- Calculate authoritative line totals from current active catalog prices.
  for v_item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb))
  loop
    v_count := v_count + 1;
    if coalesce(v_item->>'product_id','') = '' then raise exception 'Product id is required'; end if;
    v_qty := (v_item->>'quantity')::numeric;
    if v_qty <= 0 or v_qty > 100 or v_qty <> trunc(v_qty) then
      raise exception 'Invalid item quantity';
    end if;

    select * into v_product
    from public.products
    where id = (v_item->>'product_id')::uuid and active = true
    for share;

    if not found then raise exception 'Product unavailable'; end if;
    v_subtotal := v_subtotal + (v_product.unit_price * v_qty);
  end loop;

  insert into public.orders (
    customer_id, phone, custom_request, customer_notes, attached_images,
    subtotal, shipping_fee, tip, payment_fee, total, payment_method,
    payment_proof_url, status, scheduled_for, latitude, longitude
  ) values (
    v_user, trim(p_phone), trim(p_custom_request),
    nullif(left(coalesce(p_customer_notes,''),5000),''),
    coalesce(p_attached_images,'[]'::jsonb),
    v_subtotal, 0, coalesce(p_tip,0), 0,
    v_subtotal + coalesce(p_tip,0),
    p_payment_method, null, 'pending_review',
    p_scheduled_for, p_latitude, p_longitude
  )
  returning id, order_no into v_order_id, v_order_no;

  for v_item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb))
  loop
    v_qty := (v_item->>'quantity')::numeric;
    select * into v_product
    from public.products
    where id = (v_item->>'product_id')::uuid and active = true
    for share;

    insert into public.order_items (
      order_id, product_id, quantity, unit_price, selected_options,
      line_total, item_note, product_name
    ) values (
      v_order_id, v_product.id, v_qty, v_product.unit_price,
      coalesce(v_item->'selected_options','{}'::jsonb),
      v_product.unit_price * v_qty,
      nullif(left(coalesce(v_item->>'item_note',''),500),''),
      v_product.name
    );
  end loop;

  insert into public.order_events(order_id,status,note)
  values (v_order_id,'pending_review','تم إنشاء الطلب');

  return jsonb_build_object('id',v_order_id,'order_no',v_order_no,'subtotal',v_subtotal);
end;
$$;

revoke all on function public.create_customer_order(text,text,text,jsonb,text,numeric,jsonb,timestamptz,double precision,double precision) from public, anon;
grant execute on function public.create_customer_order(text,text,text,jsonb,text,numeric,jsonb,timestamptz,double precision,double precision) to authenticated;

commit;
