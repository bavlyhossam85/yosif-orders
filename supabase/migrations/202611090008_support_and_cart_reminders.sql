-- Yosif Orders: secure support inbox and abandoned-cart reminder queue.
-- Apply manually in Supabase SQL Editor. This migration is additive and does not alter orders/wallets.

begin;

create table if not exists public.yosif_support_conversations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table if not exists public.yosif_support_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.yosif_support_conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists yosif_support_messages_conversation_created_idx
  on public.yosif_support_messages(conversation_id, created_at);
create index if not exists yosif_support_messages_unread_idx
  on public.yosif_support_messages(conversation_id, read_at)
  where read_at is null;

alter table public.yosif_support_conversations enable row level security;
alter table public.yosif_support_messages enable row level security;

drop policy if exists "Yosif support conversation participants read" on public.yosif_support_conversations;
create policy "Yosif support conversation participants read"
  on public.yosif_support_conversations for select to authenticated
  using (customer_id = auth.uid() or public.is_admin());

drop policy if exists "Yosif customers open own support conversation" on public.yosif_support_conversations;
create policy "Yosif customers open own support conversation"
  on public.yosif_support_conversations for insert to authenticated
  with check (customer_id = auth.uid());

drop policy if exists "Yosif support message participants read" on public.yosif_support_messages;
create policy "Yosif support message participants read"
  on public.yosif_support_messages for select to authenticated
  using (
    exists (
      select 1 from public.yosif_support_conversations c
      where c.id = yosif_support_messages.conversation_id
        and (c.customer_id = auth.uid() or public.is_admin())
    )
  );

drop policy if exists "Yosif support participants send messages" on public.yosif_support_messages;
create policy "Yosif support participants send messages"
  on public.yosif_support_messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.yosif_support_conversations c
      where c.id = yosif_support_messages.conversation_id
        and (c.customer_id = auth.uid() or public.is_admin())
    )
  );

create or replace function public.yosif_touch_support_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.yosif_support_conversations
    set last_message_at = new.created_at, updated_at = now()
    where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists yosif_support_message_touch on public.yosif_support_messages;
create trigger yosif_support_message_touch
  after insert on public.yosif_support_messages
  for each row execute function public.yosif_touch_support_conversation();

create or replace function public.mark_yosif_support_read(p_conversation_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1 from public.yosif_support_conversations c
    where c.id = p_conversation_id
      and (c.customer_id = auth.uid() or public.is_admin())
  ) then raise exception 'Conversation not found or access denied'; end if;
  update public.yosif_support_messages
    set read_at = now()
    where conversation_id = p_conversation_id
      and sender_id <> auth.uid()
      and read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.mark_yosif_support_read(uuid) from public, anon;
grant execute on function public.mark_yosif_support_read(uuid) to authenticated;

create table if not exists public.yosif_abandoned_carts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  cart_snapshot jsonb not null default '[]'::jsonb,
  last_activity_at timestamptz not null default now(),
  reminder_sent_at timestamptz,
  dismissed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint yosif_abandoned_cart_snapshot_array check (jsonb_typeof(cart_snapshot) = 'array')
);

grant select, insert on public.yosif_support_conversations to authenticated;
grant select, insert on public.yosif_support_messages to authenticated;
grant all on public.yosif_support_conversations, public.yosif_support_messages to service_role;

alter table public.yosif_abandoned_carts enable row level security;
grant select, insert, update, delete on public.yosif_abandoned_carts to authenticated;
grant all on public.yosif_abandoned_carts to service_role;

drop policy if exists "Yosif customers manage own abandoned cart" on public.yosif_abandoned_carts;
create policy "Yosif customers manage own abandoned cart"
  on public.yosif_abandoned_carts for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Realtime support messages/conversations. If Realtime publication is unavailable,
-- the app still works through normal refreshes.
do $$
begin
  alter publication supabase_realtime add table public.yosif_support_messages;
exception when duplicate_object then null;
when undefined_object then raise notice 'supabase_realtime publication not found; enable Realtime for support tables manually.';
end $$;
do $$
begin
  alter publication supabase_realtime add table public.yosif_support_conversations;
exception when duplicate_object then null;
when undefined_object then raise notice 'supabase_realtime publication not found; enable Realtime for support tables manually.';
end $$;

commit;

-- Abandoned-cart reminders are sent by the existing Vercel /api/onesignal endpoint.
-- No Supabase Edge Function is used for OneSignal Push.
-- Scheduler setup is documented in PHASE_1_SETUP.md.
