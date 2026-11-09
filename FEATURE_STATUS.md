# Yosif Orders — Feature and verification status

## Changes added on the audit branch (not deployed)
- Fixed the Vercel OneSignal API authorization path so a signed-in customer can request only an `order_created` push for their own order. Key management, test, broadcast, and order-updated actions remain admin-only.
- Centralized order-created, order-updated, and broadcast in-app notification persistence in the protected Vercel API before the OneSignal send; removed the duplicate browser-side notification insert for order updates. This code path still requires staging runtime verification with real test accounts.
- Customer order creation now calls the server-side `create_customer_order` RPC instead of directly inserting into `orders`. The RPC validates inputs, calculates catalog and active flash-sale prices on the database, writes order line items with per-item notes, validates optional schedule/GPS values, and records the initial order event in one transaction.
- Added a local-persisted cart with quantity controls, per-item notes, product option selection, cross-sell suggestions, WhatsApp sharing, and a floating cart shortcut. Product selections now become real `order_items` through the RPC.
- Connected category filters and admin category creation to the actual `categories` table.
- Added customer wishlist synchronization through the `wishlists` table and customer-side flash-sale countdowns. Admin product cards can configure sale price and schedule. Sale price is rechecked by the order RPC.
- Added customer product review submission and an admin review moderation screen. Customers can submit a review only for delivered products once the RLS migration is applied; new reviews are hidden pending admin approval.
- Admin can configure product option groups in JSON; customers can select available choices before adding the product to cart. Option-specific price adjustments are not yet supported.
- Added scheduled delivery datetime and GPS coordinate persistence, plus map links in customer/admin order cards.
- Customer payment proof upload now targets the private `payment-proofs` bucket and calls `submit_payment_receipt`; it no longer attempts a customer-side UPDATE of the sensitive `orders` row.
- Admin receipt review controls call the `review_payment_receipt` RPC. Receipt previews use short-lived signed URLs from the private bucket.
- Added `supabase/migrations/202611090003_wallet_wheel_hardening.sql`: server-side wallet delta adjustment and explicit set-balance RPCs (including zeroing), positive-magnitude ledger entries with direction in `transaction_type`, row locking, balance bounds, and a serialized daily wheel spin RPC that credits wallet rewards or issues expiring discount/free-delivery rewards. The user has confirmed applying this migration; live runtime behavior still needs testing.
- Added manual Supabase migrations:
  - `supabase/migrations/202611090001_rls_and_payment_receipts.sql`
  - `supabase/migrations/202611090002_atomic_customer_orders.sql`
  - `supabase/migrations/202611090004_transactional_checkout_promotions.sql` (user confirmed applied)
- Removed the customer-side INSERT attempt into `notifications`, which is intentionally denied by the current RLS model.
- All of the above changes are isolated on `audit/fix-security-and-push-2026-11-09`; no Production deployment or live database mutation has been performed.

## Existing client-side features (present before this branch)
- Responsive layout refinements, persistent dark-mode preference, PWA manifest/service workers/install prompt.
- Arabic-normalized fuzzy product search and category tabs when product rows expose a category value.
- Per-browser local favorites.
- Backdrop click for the existing order, payment, and notifications modals.
- Basic order form, voice recording, image upload, GPS link capture, admin product/order/settings screens, thermal-style browser printing, CSV export, and OneSignal broadcast UI.

## Still incomplete or not verified
- Animated add-to-cart/cart interactions and option-specific price adjustments.
- Multi-polygon delivery-zone editor, authoritative server-side coverage checks, customer GPS validation, and admin polygon/circle rendering plus zone CRUD have been added on this branch. Requires migration 005 and browser verification.
- Wallet/rewards UI and checkout coupon/reward selection are wired to migrations 003 and 004. Live Supabase transaction behavior still requires testing.
- Full installment/tab eligibility, schedule generation, payment ledger, and settlement workflows.
- Persistent customer/admin chat, attachment/voice messages, unread counters, and OneSignal chat notifications.
- Server-scheduled abandoned-cart reminders.
- Complete financial dashboard/charting, purchase aggregation by category, customer account management, and audited safe admin impersonation.
- Realtime coverage for every required table/event and real-device Push delivery.
- Full category editing/deletion and advanced product option/flash-sale management.

## Required manual setup and verification
1. The user reports applying migrations `202611090003_wallet_wheel_hardening.sql` and `202611090004_transactional_checkout_promotions.sql`. Confirm migrations `202611090001` and `202611090002` are also applied before relying on their RLS, receipt, and atomic-order functions. Apply migration `202611090005_delivery_zone_polygons.sql` before testing the new delivery-zone features.
2. Confirm the `payment-proofs` bucket exists and is private. The migration adds object policies but does not move existing objects or change bucket visibility.
3. Confirm the Vercel environment has the required Supabase server secret and OneSignal encryption configuration before testing the protected API. Never add server secrets to `config.js`.
4. Run `npm ci` and `npm run build`; then exercise wallet credit/debit/set-to-zero, wheel daily limit and reward issuance, coupon/reward selection, pricing with sufficient and insufficient wallet balances, cancellation refund idempotency, customer ledger visibility, customer order creation, receipt upload/review, and OneSignal flows on non-production test accounts.
5. Do not merge or deploy until migration and runtime tests pass.

## Safety notes
- Wallet balances, totals, discounts, installment balances, and reward redemption must be server-authoritative and transactional.
- Do not grant broad customer UPDATE access to `orders`, wallet tables, receipts, or notifications.
- Do not use public URLs for payment proof images.
- No production database, customer data, order data, wallet balance, or Production deployment was changed by this branch.


## Latest UI integration (audit branch, not deployed)
- Customer navigation now includes a wallet/rewards screen with current balance, recent ledger entries, unredeemed rewards, active coupon visibility, and a daily-spin action calling `spin_customer_wheel`.
- Admin navigation now includes loyalty controls: enable/disable the wheel, set the daily limit, edit reward JSON, and adjust/replace a selected customer's wallet balance through the protected RPCs. It also lists customer wallet balances.
- Customer checkout now allows selecting an active coupon and an unused reward; selections are attached through `set_order_promotions`. Admin first-pricing calls `admin_save_order_pricing`, which recalculates coupon/reward discounts and payment fees server-side and debits wallet payments transactionally. Admin cancellation calls `admin_cancel_order`, which refunds wallet debits once and restores redeemed coupon/reward usage. These RPCs are in migration `202611090004_transactional_checkout_promotions.sql`, which the user confirmed applying.
- No production deployment or live database changes were made by these UI commits.


## Transactional checkout update (audit branch, not deployed)
- Added `set_order_promotions` to validate and attach one active coupon and one unexpired unused reward to the authenticated customer's pending order.
- Added `admin_save_order_pricing` to lock the order, validate promotion availability, calculate discounts and payment fees server-side, consume the coupon/reward, and debit wallet payments in the same transaction.
- Added `admin_cancel_order` to lock and cancel the order, refund wallet debits once using `wallet_refunded_at`, and restore coupon usage/reward availability where applicable.
- Updated the customer checkout UI with coupon and reward selectors, and changed admin order saving to use the protected pricing/cancellation RPCs instead of direct order-total updates.
- Updated `spin_customer_wheel` in migration 004 so percentage rewards use the existing `customer_rewards.reward_type='percentage_discount'` CHECK value rather than the unsupported literal `discount`.
- Migration 004 was reported applied by the user; its live runtime behavior has not yet been verified. No production deployment was made.
