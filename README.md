# Yosif Orders

Vite + vanilla JavaScript + Supabase web app. The project is configured for Vercel deployment.

## Local development

```bash
npm install
npm run dev
```

## Vercel deployment

1. Import this project/repository into Vercel.
2. Keep the Framework Preset as **Vite** (the included `vercel.json` also declares it).
3. Build command: `npm run build`; output directory: `dist`.
4. The browser-safe Supabase URL and publishable key are in `config.js`. They can be overridden with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` environment variables.
5. Deploy.

## OneSignal Push (Vercel server setup)

The current browser client sends push requests to the authenticated Vercel serverless endpoint at `/api/onesignal`. The OneSignal REST API key must never be stored in `main.js`, `index.html`, `config.js`, or any `VITE_` variable.

Configure these server-side environment variables in Vercel (Production and Preview/Staging as appropriate):

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_ANON_KEY`
- `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`

The server validates the Supabase bearer token, checks the caller's profile role and order ownership, and encrypts the admin-supplied OneSignal REST API key with AES-256-GCM before storing it in the `settings` table. The encryption key is derived from the server-only Supabase secret. Never prefix server secrets with `VITE_` or expose their values in client code or logs. If the Supabase server secret used for encryption is rotated, save the OneSignal REST API key again from the admin settings.

The Supabase Edge Function under `supabase/functions/send-onesignal-push` is retained in the repository as a legacy implementation; the current `main.js` client calls the Vercel API route.

**Security action:** an earlier uploaded source contained a OneSignal REST API key in browser JavaScript. Treat that old key as compromised and rotate/revoke it in OneSignal before enabling production push. The exposed value has been removed from this project.

The Vercel API authorizes `order_created` only for the order owner, and `order_updated` / `broadcast` only for an admin profile. OneSignal subscribers are identified by the Supabase user ID via `OneSignal.login(user.id)`.

## PWA

The project includes a web manifest, 192/512 PNG icons, an app-shell service worker, and the OneSignal worker. Android/desktop browsers can expose the install prompt when their installability criteria are met. On iPhone/iPad, installation is performed from Safari's Share menu using **Add to Home Screen**; browsers do not expose the same automatic install prompt there.

## Current implementation boundaries

This archive did not include the original Supabase SQL schema, migrations, Storage policies, or any existing chat tables/functions. Existing database tables assumed by the app are `profiles`, `products`, `settings`, `orders`, `notifications`, and `order_events`; existing Storage buckets include `products`, `order-images`, `receipts`, and `payment-assets`.

This update fixes the Supabase config import, removes the browser-exposed OneSignal secret, adds the secure Edge Function path, PWA assets, responsive refinements, Arabic-normalized/fuzzy product search, category filtering when `products.category` exists, local favorites, and backdrop-to-close behavior for the existing modals. Features requiring new database structures and business rules (cart line items, product options/reviews, wallet ledger, loyalty wheel, delivery polygons, scheduled reminders, customer impersonation, etc.) are not represented as complete merely by adding frontend controls; they need coordinated schema/RLS/storage and transaction work against the actual Supabase database.
