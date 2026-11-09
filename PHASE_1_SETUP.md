# Phase 1 — Support chat, Push notifications, and abandoned carts

This work is committed to `audit/fix-security-and-push-2026-11-09`. It is not merged or deployed to Production.

## Implemented in code

- Customer support inbox with one private conversation per customer.
- Admin inbox with a conversation list, message history, and unread counters.
- Floating draggable customer support button.
- Realtime updates for support messages.
- Read receipts through a permission-checked database RPC.
- Authenticated OneSignal routing for chat messages, order-created, order-updated, and admin broadcasts.
- OneSignal Web SDK, browser client, and Vercel API now consistently target App ID `6b3d2509-bbcb-4b13-8647-7f4999103f59`.
- Cart activity is recorded in a server-side queue. A Supabase Edge Function sends one push reminder after 45 minutes of inactivity, only if the customer has not placed an order since the cart became idle.

## Required setup before runtime testing

### 1. Apply the database migration

Open Supabase SQL Editor and run the complete file:

`supabase/migrations/202611090008_support_and_cart_reminders.sql`

It creates the support tables, RLS policies, read-state RPC, Realtime publication entries, and abandoned-cart queue. It is additive and does not modify orders, wallets, or payment records.

### 2. Deploy the abandoned-cart Edge Function

From the repository root, with Supabase CLI linked to project `xsyhrxivvtqdernqxvyw`:

```bash
supabase functions deploy send-abandoned-cart-reminders --no-verify-jwt
supabase secrets set ONESIGNAL_APP_ID=6b3d2509-bbcb-4b13-8647-7f4999103f59 ONESIGNAL_REST_API_KEY=<ONESIGNAL_REST_API_KEY> CRON_SECRET=<LONG_RANDOM_SECRET>
```

The function uses Supabase's `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` runtime secrets. Do not put the REST API key or CRON secret in browser code or Git.

### 3. Schedule the reminder worker

In Supabase Dashboard, enable the `pg_cron` and `pg_net` extensions. Store these two values in Vault (use the same long random value for the Edge Function's `CRON_SECRET`):

```sql
select vault.create_secret('https://xsyhrxivvtqdernqxvyw.supabase.co', 'project_url');
select vault.create_secret('<same CRON_SECRET>', 'cart_reminder_cron_secret');
```

Then schedule the worker every 15 minutes:

```sql
select cron.schedule(
  'yosif-abandoned-cart-reminders',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='project_url')
      || '/functions/v1/send-abandoned-cart-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cart_reminder_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

### 4. Reconfigure the protected Vercel Push API

- Confirm Vercel has a server-only `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` environment variable. Never put this value in `config.js`.
- In the admin panel, open Settings → OneSignal, paste the REST API Key belonging to App ID `6b3d2509-bbcb-4b13-8647-7f4999103f59`, save it, then run the connection test.
- The REST API key previously saved for a different App ID will not work with the newly aligned App ID; save the correct app's key again.

## Runtime acceptance checklist

1. Customer A opens support and sends a message; customer B must not see that conversation.
2. Admin sees the message and unread count, replies, and the customer sees the reply and read state.
3. Customer and admin receive chat Push on devices with Push permission enabled.
4. New-order Push reaches admins; order-update Push reaches only the order owner.
5. Admin broadcast reaches eligible customer subscriptions.
6. A cart idle for 45 minutes receives one reminder; a cart updated or checked out before the deadline receives none.
7. A second idle period after changing the cart can generate a new reminder.

## Verification boundary

GitHub Actions `npm run build` passed for the implementation branch. Database migration execution, Edge Function deployment, cron scheduling, Vercel environment configuration, and real-device OneSignal delivery still require the setup above and runtime testing. No Production deployment or merge was performed.
