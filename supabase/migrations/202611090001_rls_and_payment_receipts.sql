-- Yosif Orders: least-privilege RLS foundation
-- Review and apply manually in Supabase SQL Editor. This file is NOT auto-applied.
-- Existing customer/order data is not modified.

begin;

-- Read-only customer access to public configuration and catalog data.
drop policy if exists "Public can read active delivery zones" on public.delivery_zones;
create policy "Public can read active delivery zones"
  on public.delivery_zones for select to anon, authenticated
  using (active = true);

-- Wallet balances are visible to their owner and admins, but never writable
-- directly from a browser. Mutations must go through SECURITY DEFINER RPCs.
drop policy if exists "Wallet owner or admin can read wallet" on public.wallets;
create policy "Wallet owner or admin can read wallet"
  on public.wallets for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Wallet owner or admin can read transactions" on public.wallet_transactions;
create policy "Wallet owner or admin can read transactions"
  on public.wallet_transactions for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Coupons may be listed only while active and within their validity window.
drop policy if exists "Customers can read active coupons" on public.coupons;
create policy "Customers can read active coupons"
  on public.coupons for select to authenticated
  using (
    active = true
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at >= now())
  );

drop policy if exists "Customers can read own rewards" on public.customer_rewards;
create policy "Customers can read own rewards"
  on public.customer_rewards for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Customers can read spin settings" on public.spin_settings;
create policy "Customers can read spin settings"
  on public.spin_settings for select to authenticated
  using (enabled = true or public.is_admin());

drop policy if exists "Customers can read own spin logs" on public.spin_logs;
create policy "Customers can read own spin logs"
  on public.spin_logs for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Order line items: customers can read items belonging to their orders.
-- Inserts/updates/deletes are intentionally admin/RPC-only.
drop policy if exists "Order owner can read order items" on public.order_items;
create policy "Order owner can read order items"
  on public.order_items for select to authenticated
  using (
    exists (
      select 1 from public.orders o
      where o.id = order_items.order_id
        and (o.customer_id = auth.uid() or public.is_admin())
    )
  );

drop policy if exists "Admins manage order items" on public.order_items;
create policy "Admins manage order items"
  on public.order_items for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Installment plans and their schedule are private to the customer/admin.
drop policy if exists "Installment owner or admin reads plans" on public.installment_plans;
create policy "Installment owner or admin reads plans"
  on public.installment_plans for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Admins manage installment plans" on public.installment_plans;
create policy "Admins manage installment plans"
  on public.installment_plans for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Installment owner or admin reads installments" on public.installments;
create policy "Installment owner or admin reads installments"
  on public.installments for select to authenticated
  using (
    exists (
      select 1 from public.installment_plans p
      where p.id = installments.plan_id
        and (p.user_id = auth.uid() or public.is_admin())
    )
  );

drop policy if exists "Admins manage installments" on public.installments;
create policy "Admins manage installments"
  on public.installments for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Payment receipts: owner can submit and view their own receipt; only admins
-- can review/update it. No broad UPDATE policy is granted on orders.
drop policy if exists "Receipt owner or admin reads receipts" on public.payment_receipts;
create policy "Receipt owner or admin reads receipts"
  on public.payment_receipts for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Customer submits own payment receipt" on public.payment_receipts;
create policy "Customer submits own payment receipt"
  on public.payment_receipts for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.orders o
      where o.id = payment_receipts.order_id
        and o.customer_id = auth.uid()
    )
  );

drop policy if exists "Admins review payment receipts" on public.payment_receipts;
create policy "Admins review payment receipts"
  on public.payment_receipts for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins manage payment receipts" on public.payment_receipts;
create policy "Admins manage payment receipts"
  on public.payment_receipts for delete to authenticated
  using (public.is_admin());

-- Conversations and messages are visible only to the customer attached to the
-- conversation and admins. Customer message inserts are scoped to own threads.
drop policy if exists "Conversation owner or admin reads conversations" on public.chat_conversations;
create policy "Conversation owner or admin reads conversations"
  on public.chat_conversations for select to authenticated
  using (customer_id = auth.uid() or public.is_admin());

drop policy if exists "Customer opens own conversation" on public.chat_conversations;
create policy "Customer opens own conversation"
  on public.chat_conversations for insert to authenticated
  with check (
    customer_id = auth.uid()
    and (order_id is null or exists (
      select 1 from public.orders o
      where o.id = chat_conversations.order_id and o.customer_id = auth.uid()
    ))
  );

drop policy if exists "Admins manage conversations" on public.chat_conversations;
create policy "Admins manage conversations"
  on public.chat_conversations for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Conversation participants read messages" on public.chat_messages;
create policy "Conversation participants read messages"
  on public.chat_messages for select to authenticated
  using (
    exists (
      select 1 from public.chat_conversations c
      where c.id = chat_messages.conversation_id
        and (c.customer_id = auth.uid() or public.is_admin())
    )
  );

drop policy if exists "Customer sends message in own conversation" on public.chat_messages;
create policy "Customer sends message in own conversation"
  on public.chat_messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.chat_conversations c
      where c.id = chat_messages.conversation_id
        and c.customer_id = auth.uid()
    )
  );

drop policy if exists "Admins manage chat messages" on public.chat_messages;
create policy "Admins manage chat messages"
  on public.chat_messages for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Customer-managed cart reminders; dispatching/sending remains server-side.
drop policy if exists "Customer reads own cart reminders" on public.cart_reminders;
create policy "Customer reads own cart reminders"
  on public.cart_reminders for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "Customer creates own cart reminders" on public.cart_reminders;
create policy "Customer creates own cart reminders"
  on public.cart_reminders for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Customer deletes own cart reminders" on public.cart_reminders;
create policy "Customer deletes own cart reminders"
  on public.cart_reminders for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Courier coordinates are readable only by the order owner/admin. Writes are
-- reserved to admins until a dedicated courier role/auth model exists.
drop policy if exists "Order owner reads courier locations" on public.courier_locations;
create policy "Order owner reads courier locations"
  on public.courier_locations for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.orders o
      where o.id = courier_locations.order_id and o.customer_id = auth.uid()
    )
  );

drop policy if exists "Admins manage courier locations" on public.courier_locations;
create policy "Admins manage courier locations"
  on public.courier_locations for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Reviews: public can read visible reviews; users can submit reviews for
-- products they have actually ordered. No customer edit/delete path.
drop policy if exists "Visible product reviews are public" on public.product_reviews;
create policy "Visible product reviews are public"
  on public.product_reviews for select to anon, authenticated
  using (is_visible = true or user_id = auth.uid() or public.is_admin());

drop policy if exists "Customer reviews purchased products" on public.product_reviews;
create policy "Customer reviews purchased products"
  on public.product_reviews for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where oi.product_id = product_reviews.product_id
        and o.customer_id = auth.uid()
        and o.status = 'delivered'
    )
  );

drop policy if exists "Admins manage product reviews" on public.product_reviews;
create policy "Admins manage product reviews"
  on public.product_reviews for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Wishlist is private to each customer.
drop policy if exists "Customer manages own wishlist" on public.wishlists;
create policy "Customer manages own wishlist"
  on public.wishlists for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Keep payment proof objects private and user-scoped. Existing objects are not
-- moved or deleted by this migration; upload path must begin with auth.uid().
drop policy if exists "Customer uploads own payment proof" on storage.objects;
create policy "Customer uploads own payment proof"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'payment-proofs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Customer reads own payment proof" on storage.objects;
create policy "Customer reads own payment proof"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'payment-proofs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Admins read payment proofs" on storage.objects;
create policy "Admins read payment proofs"
  on storage.objects for select to authenticated
  using (bucket_id = 'payment-proofs' and public.is_admin());

drop policy if exists "Admins delete payment proofs" on storage.objects;
create policy "Admins delete payment proofs"
  on storage.objects for delete to authenticated
  using (bucket_id = 'payment-proofs' and public.is_admin());

-- Admin-only maintenance for feature configuration tables.
drop policy if exists "Admins manage coupons" on public.coupons;
create policy "Admins manage coupons"
  on public.coupons for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins manage spin settings" on public.spin_settings;
create policy "Admins manage spin settings"
  on public.spin_settings for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins manage delivery zones" on public.delivery_zones;
create policy "Admins manage delivery zones"
  on public.delivery_zones for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Atomic receipt submission: validates order ownership and writes the receipt
-- record. The path must be a private payment-proofs object under the caller.
create or replace function public.submit_payment_receipt(
  p_order_id uuid,
  p_storage_path text,
  p_review_note text default null
) returns uuid
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_user uuid := auth.uid();
  v_receipt_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_storage_path is null or length(p_storage_path) > 500
     or split_part(p_storage_path, '/', 1) <> v_user::text then
    raise exception 'Invalid payment proof path';
  end if;

  if not exists (
    select 1 from storage.objects so
    where so.bucket_id = 'payment-proofs' and so.name = p_storage_path
  ) then
    raise exception 'Payment proof file not found';
  end if;

  if not exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.customer_id = v_user
      and o.status not in ('cancelled', 'deleted', 'delivered')
  ) then
    raise exception 'Order not eligible for payment receipt';
  end if;

  insert into public.payment_receipts(order_id, user_id, storage_path, status, review_note)
  values (p_order_id, v_user, p_storage_path, 'pending', nullif(left(coalesce(p_review_note,''),500),''))
  returning id into v_receipt_id;

  update public.orders
    set payment_proof_url = p_storage_path, updated_at = now()
    where id = p_order_id and customer_id = v_user;

  return v_receipt_id;
end;
$$;

revoke all on function public.submit_payment_receipt(uuid,text,text) from public, anon;
grant execute on function public.submit_payment_receipt(uuid,text,text) to authenticated;

-- Admin-only receipt decision. It deliberately does not alter order totals.
create or replace function public.review_payment_receipt(
  p_receipt_id uuid,
  p_status text,
  p_review_note text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_status not in ('accepted','rejected') then raise exception 'Invalid receipt status'; end if;

  update public.payment_receipts
    set status = p_status,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_note = nullif(left(coalesce(p_review_note,''),500),'')
    where id = p_receipt_id;

  if not found then raise exception 'Receipt not found'; end if;
  return true;
end;
$$;

revoke all on function public.review_payment_receipt(uuid,text,text) from public, anon;
grant execute on function public.review_payment_receipt(uuid,text,text) to authenticated;

commit;
