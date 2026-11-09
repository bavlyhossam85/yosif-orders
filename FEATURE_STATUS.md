# Feature implementation status

## Included in this archive
- Supabase settings now load from `config.js` (optional Vite env overrides remain supported).
- OneSignal REST key removed from client-side JavaScript; authenticated Supabase Edge Function added for order-created, order-updated, and admin broadcast pushes.
- PWA manifest, PNG icons, app-shell service worker, and OneSignal worker.
- Responsive refinements for mobile/tablet/desktop and persistent dark-mode preference (existing feature retained).
- Arabic-normalized fuzzy product search; optional category tabs when product rows contain a `category` field.
- Local per-browser product favorites.
- Backdrop click closes order details, payment, and notifications modals.

## Requires database/schema work not present in the uploaded archive
- Real cart/order line items, per-item notes, cross-sell, product options, and reviews.
- Flash-sale schedules and server-enforced expiry.
- Wallet ledger and atomic wallet debit/refund, coupons, wheel prizes, and redemption limits.
- Geofence polygons and server-side point-in-polygon validation.
- Chat persistence/unread counters, scheduled abandoned-cart reminders, and full delivery tracking.
- Install-safe admin impersonation, tab/instalment ledger, receipt review states, and financial reports.

Do not enable financial features based only on client-side calculations. Wallet, tab, coupons, and reward redemption must be enforced transactionally on the server with appropriate Row Level Security.
