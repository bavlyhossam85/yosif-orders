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
- Cart activity is recorded in a server-side queue. The existing Vercel `/api/onesignal` endpoint sends one reminder after 45 minutes of inactivity, using the encrypted REST API Key saved from Admin → OneSignal. No Supabase Edge Function sends Push.

## Required setup before runtime testing

### 1. Apply the database migration

Open Supabase SQL Editor and run the complete file:

`supabase/migrations/202611090008_support_and_cart_reminders.sql`

It creates the support tables, RLS policies, read-state RPC, Realtime publication entries, and abandoned-cart queue. It is additive and does not modify orders, wallets, or payment records.

### 2. Configure the existing Vercel Push API scheduler

- In Vercel Project → Settings → Environment Variables, add `CRON_SECRET` as a long random value for Production (and Preview if you intend to test there). This is only a scheduler-authentication secret; it is **not** the OneSignal REST API Key.
- Add the exact same `CRON_SECRET` to Supabase Vault. Keep the OneSignal REST API Key exclusively in Admin → Settings → OneSignal; the Vercel API decrypts it from the `settings` table when it sends a reminder.
- In Supabase Dashboard, enable `pg_cron` and `pg_net`, then store the application URL and scheduler secret in Vault:

```sql
select vault.create_secret('https://yosif-orders-pied.vercel.app', 'app_url');
select vault.create_secret('<same CRON_SECRET configured in Vercel>', 'cart_reminder_cron_secret');
```

Schedule the existing Vercel API endpoint every 15 minutes:

```sql
select cron.schedule(
  'yosif-abandoned-cart-reminders',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='app_url') || '/api/onesignal',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='cart_reminder_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

The API endpoint reads the encrypted OneSignal key saved by the admin, selects carts idle for 45 minutes, skips customers who ordered afterward, sends Push, and marks successful reminders. No OneSignal key is placed in Supabase Edge Function secrets, SQL, or browser code.

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

GitHub Actions `npm run build` passed for the implementation branch. Database migration execution, Vercel CRON_SECRET configuration, pg_cron scheduling, and real-device OneSignal delivery still require the setup above and runtime testing. No Production deployment or merge was performed.
