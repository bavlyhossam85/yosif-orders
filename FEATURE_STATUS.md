# Yosif Orders — Feature and verification status

## Changes added on the audit branch (not deployed)
- Fixed the Vercel OneSignal API authorization path so a signed-in customer can request only an `order_created` push for their own order. Key management, test, broadcast, and order-updated actions remain admin-only.
- Customer order creation now calls the server-side `create_customer_order` RPC instead of directly inserting into `orders`. The RPC validates inputs, calculates catalog and active flash-sale prices on the database, writes order line items with per-item notes, validates optional schedule/GPS values, and records the initial order event in one transaction.
- Added a local-persisted cart with quantity controls, per-item notes, product option selection, cross-sell suggestions, WhatsApp sharing, and a floating cart shortcut. Product selections now become real `order_items` through the RPC.
- Connected category filters and admin category creation to the actual `categories` table.
- Added customer wishlist synchronization through the `wishlists` table and customer-side flash-sale countdowns. Admin product cards can configure sale price and schedule. Sale price is rechecked by the order RPC.
- Added scheduled delivery datetime and GPS coordinate persistence, plus map links in customer/admin order cards.
- Customer payment proof upload now targets the private `payment-proofs` bucket and calls `submit_payment_receipt`; it no longer attempts a customer-side UPDATE of the sensitive `orders` row.
- Admin receipt review controls call the `review_payment_receipt` RPC. Receipt previews use short-lived signed URLs from the private bucket.
- Added two manual Supabase migrations:
  - `supabase/migrations/202611090001_rls_and_payment_receipts.sql`
  - `supabase/migrations/202611090002_atomic_customer_orders.sql`
- Removed the customer-side INSERT attempt into `notifications`, which is intentionally denied by the current RLS model.
- All of the above changes are isolated on `audit/fix-security-and-push-2026-11-09`; no Production deployment or live database mutation has been performed.

## Existing client-side features (present before this branch)
- Responsive layout refinements, persistent dark-mode preference, PWA manifest/service workers/install prompt.
- Arabic-normalized fuzzy product search and category tabs when product rows expose a category value.
- Per-browser local favorites.
- Backdrop click for the existing order, payment, and notifications modals.
- Basic order form, voice recording, image upload, GPS link capture, admin product/order/settings screens, thermal-style browser printing, CSV export, and OneSignal broadcast UI.

## Still incomplete or not verified
- A real interactive cart with line items, options, per-item notes, animated add-to-cart, cross-sell, wishlist sync, reviews, and flash-sale countdown/enforcement.
- Multi-polygon delivery-zone editor and authoritative server-side point-in-polygon checks; precise customer/admin map pin workflows.
- Wallet customer checkout debit/refund, coupon and wheel reward issuance/redemption, daily spin enforcement, and customer-facing balance UI. Existing admin wallet adjustment RPC requires independent verification and should not be bypassed.
- Full installment/tab eligibility, schedule generation, payment ledger, and settlement workflows.
- Persistent customer/admin chat, attachment/voice messages, unread counters, and OneSignal chat notifications.
- Server-scheduled abandoned-cart reminders.
- Complete financial dashboard/charting, purchase aggregation by category, customer account management, and audited safe admin impersonation.
- Realtime coverage for every required table/event and real-device Push delivery.
- Admin category management and complete product options/flash-sale editing.

## Required manual setup and verification
1. Review both SQL migrations against the live schema, then apply them manually in Supabase SQL Editor. The migrations are not auto-applied.
2. Confirm the `payment-proofs` bucket exists and is private. The migration adds object policies but does not move existing objects or change bucket visibility.
3. Confirm the Vercel environment has the required Supabase server secret and OneSignal encryption configuration before testing the protected API. Never add server secrets to `config.js`.
4. Run `npm ci` and `npm run build`; then exercise customer order creation, receipt upload, admin receipt review, OneSignal order-created push, order-updated push, and broadcast on a non-production test account.
5. Do not merge or deploy until migration and runtime tests pass.

## Safety notes
- Wallet balances, totals, discounts, installment balances, and reward redemption must be server-authoritative and transactional.
- Do not grant broad customer UPDATE access to `orders`, wallet tables, receipts, or notifications.
- Do not use public URLs for payment proof images.
- No production database, customer data, order data, wallet balance, or Production deployment was changed by this branch.
