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

## OneSignal Push (required server setup)

The OneSignal REST key must never be stored in `main.js`, `index.html`, `config.js`, or any `VITE_` variable. The client calls the included authenticated Supabase Edge Function instead.

Deploy the function to the Supabase project referenced by `config.js` and set these server secrets:

- `ONESIGNAL_APP_ID` = the Yosif OneSignal App ID already configured in `index.html`
- `ONESIGNAL_REST_API_KEY` = a newly generated OneSignal REST API key

Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to deployed Edge Functions. Deploy with:

```bash
supabase functions deploy send-onesignal-push
supabase secrets set ONESIGNAL_APP_ID=YOUR_APP_ID ONESIGNAL_REST_API_KEY=YOUR_NEW_REST_API_KEY
```

**Security action:** the uploaded source contained a OneSignal REST API key in browser JavaScript. Treat that key as compromised and rotate/revoke it in OneSignal before enabling production push. The exposed value has been removed from this project.

The function authorizes `order_created` only for the order owner, and `order_updated` / `broadcast` only for an admin profile. OneSignal identifies subscribers using the Supabase user ID via `OneSignal.login(user.id)`.

## PWA

The project includes a web manifest, 192/512 PNG icons, an app-shell service worker, and the OneSignal worker. Android/desktop browsers can expose the install prompt when their installability criteria are met. On iPhone/iPad, installation is performed from Safari's Share menu using **Add to Home Screen**; browsers do not expose the same automatic install prompt there.

## Current implementation boundaries

This archive did not include the original Supabase SQL schema, migrations, Storage policies, or any existing chat tables/functions. Existing database tables assumed by the app are `profiles`, `products`, `settings`, `orders`, `notifications`, and `order_events`; existing Storage buckets include `products`, `order-images`, `receipts`, and `payment-assets`.

This update fixes the Supabase config import, removes the browser-exposed OneSignal secret, adds the secure Edge Function path, PWA assets, responsive refinements, Arabic-normalized/fuzzy product search, category filtering when `products.category` exists, local favorites, and backdrop-to-close behavior for the existing modals. Features requiring new database structures and business rules (cart line items, product options/reviews, wallet ledger, loyalty wheel, delivery polygons, scheduled reminders, customer impersonation, etc.) are not represented as complete merely by adding frontend controls; they need coordinated schema/RLS/storage and transaction work against the actual Supabase database.
