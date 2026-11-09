import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const appId = Deno.env.get('ONESIGNAL_APP_ID')!
    const restKey = Deno.env.get('ONESIGNAL_REST_API_KEY')!
    if (!url || !anon || !service || !appId || !restKey) throw new Error('Missing server environment variables')

    const authHeader = req.headers.get('Authorization') || ''
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } })

    const admin = createClient(url, service)
    const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle()
    const { event_type, order_id, title, message } = await req.json()
    let recipients: string[] = []
    let notificationTitle = title || ''
    let notificationBody = message || ''

    if (event_type === 'order_created') {
      const { data: order } = await admin.from('orders').select('id,customer_id,order_no,customer_notes').eq('id', order_id).maybeSingle()
      if (!order || order.customer_id !== user.id) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
      const { data: admins } = await admin.from('profiles').select('id').eq('role', 'admin')
      recipients = (admins || []).map((row: {id:string}) => row.id)
      notificationTitle = 'طلب جديد 🛍️'
      notificationBody = `تم استلام طلب جديد رقم #${order.order_no}`
    } else if (event_type === 'order_updated') {
      if (profile?.role !== 'admin') return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
      const { data: order } = await admin.from('orders').select('id,customer_id,order_no,status').eq('id', order_id).maybeSingle()
      if (!order) return new Response(JSON.stringify({ error: 'Order not found' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } })
      recipients = [order.customer_id]
      notificationTitle = 'تحديث الطلب 🛍️'
      notificationBody = `تم تحديث حالة طلبك #${order.order_no}`
    } else if (event_type === 'broadcast') {
      if (profile?.role !== 'admin') return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
      if (!notificationTitle || !notificationBody) return new Response(JSON.stringify({ error: 'Title and message are required' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
      const { data: customers } = await admin.from('profiles').select('id').neq('role', 'admin')
      recipients = (customers || []).map((row: {id:string}) => row.id)
    } else {
      return new Response(JSON.stringify({ error: 'Unsupported event type' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    if (!recipients.length) return new Response(JSON.stringify({ success: true, recipients: 0 }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    const push = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Key ${restKey}` },
      body: JSON.stringify({ app_id: appId, include_aliases: { external_id: recipients }, target_channel: 'push', headings: { en: notificationTitle, ar: notificationTitle }, contents: { en: notificationBody, ar: notificationBody } }),
    })
    const result = await push.json()
    if (!push.ok) return new Response(JSON.stringify({ error: 'OneSignal request failed', details: result }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
    return new Response(JSON.stringify({ success: true, recipients: recipients.length, result }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unexpected error' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
