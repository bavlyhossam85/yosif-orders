import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const cronSecret = Deno.env.get('CRON_SECRET')
  if (!cronSecret || req.headers.get('Authorization') !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const appId = Deno.env.get('ONESIGNAL_APP_ID')
  const restKey = Deno.env.get('ONESIGNAL_REST_API_KEY')
  if (!url || !serviceKey || !appId || !restKey) {
    return Response.json({ error: 'Missing required Edge Function secrets' }, { status: 500 })
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const cutoff = new Date(Date.now() - 45 * 60 * 1000).toISOString()
  const { data: carts, error } = await admin.from('yosif_abandoned_carts')
    .select('user_id,cart_snapshot,last_activity_at')
    .is('reminder_sent_at', null)
    .is('dismissed_at', null)
    .lt('last_activity_at', cutoff)
    .limit(500)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  if (!carts?.length) return Response.json({ success: true, sent: 0 })

  const eligible = []
  for (const cart of carts) {
    if (!Array.isArray(cart.cart_snapshot) || cart.cart_snapshot.length === 0) {
      await admin.from('yosif_abandoned_carts').delete().eq('user_id', cart.user_id)
      continue
    }
    const { data: recentOrders, error: orderError } = await admin.from('orders')
      .select('id').eq('customer_id', cart.user_id).gt('created_at', cart.last_activity_at).limit(1)
    if (orderError) return Response.json({ error: orderError.message }, { status: 500 })
    if (recentOrders?.length) {
      await admin.from('yosif_abandoned_carts').delete().eq('user_id', cart.user_id)
      continue
    }
    eligible.push(cart.user_id)
  }
  if (!eligible.length) return Response.json({ success: true, sent: 0 })

  const push = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${restKey}` },
    body: JSON.stringify({
      app_id: appId,
      include_aliases: { external_id: eligible },
      target_channel: 'push',
      headings: { ar: 'سلتك مستنياك 🛒', en: 'Your cart is waiting 🛒' },
      contents: { ar: 'لسه عندك منتجات في سلتك. كمّل طلبك وقت ما تحب.', en: 'You still have items in your cart. Complete your order whenever you are ready.' }
    })
  })
  const result = await push.json().catch(() => ({}))
  if (!push.ok) return Response.json({ error: 'OneSignal send failed', details: result }, { status: 502 })
  const sentAt = new Date().toISOString()
  const { error: updateError } = await admin.from('yosif_abandoned_carts')
    .update({ reminder_sent_at: sentAt })
    .in('user_id', eligible)
  if (updateError) return Response.json({ error: updateError.message, push_result: result }, { status: 500 })
  return Response.json({ success: true, sent: eligible.length, oneSignal: result })
})
