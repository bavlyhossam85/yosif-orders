import { createClient } from '@supabase/supabase-js';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const json = (res, status, body) => res.status(status).setHeader('Content-Type', 'application/json').json(body);
function encryptionKey() {
  const master = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!master) throw new Error('يلزم إضافة SUPABASE_SECRET_KEY في إعدادات Vercel بعد تدوير المفتاح المكشوف.');
  return Buffer.from(hkdfSync('sha256', Buffer.from(master), Buffer.from('yosif-orders-onesignal'), Buffer.from('rest-api-key-encryption-v1'), 32));
}
function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
function decryptSecret(value) {
  const [version, iv, tag, data] = String(value || '').split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('مفتاح OneSignal المحفوظ غير صالح؛ احفظ المفتاح مرة أخرى.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  try {
    const url = process.env.SUPABASE_URL || 'https://xsyhrxivvtqdernqxvyw.supabase.co';
    const publishable = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_h1Ng0OcpSIGtNVTcVVKgRQ_U2_Fr18_';
    const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!secret) return json(res, 503, { error: 'يلزم إضافة SUPABASE_SECRET_KEY في إعدادات Vercel بعد تدوير المفتاح المكشوف.' });
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return json(res, 401, { error: 'Unauthorized' });
    const userClient = createClient(url, publishable, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) return json(res, 401, { error: 'جلسة الدخول غير صالحة؛ سجّل الدخول مرة أخرى.' });
    const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: profile, error: profileError } = await admin.from('profiles').select('role').eq('id', authData.user.id).maybeSingle();
    if (profileError) throw profileError;
    const { action, app_id, rest_api_key, event_type, order_id, message_id, title, message } = req.body || {};
    const isAdmin = profile?.role === 'admin';
    // Customers may request only the order-created event for an order they own.
    // All key-management, test, broadcast, and order-updated actions remain admin-only.
    if (!isAdmin && !(action === 'send' && ['order_created', 'chat_message'].includes(event_type))) {
      return json(res, 403, { error: 'هذه العملية متاحة للأدمن فقط.' });
    }
    if (app_id !== '6b3d2509-bbcb-4b13-8647-7f4999103f59') return json(res, 400, { error: 'OneSignal App ID غير مطابق لإعدادات المشروع.' });

    if (action === 'save_key') {
      const key = String(rest_api_key || '').trim();
      if (key.length < 20 || key.length > 500) return json(res, 400, { error: 'REST API Key غير صالح؛ راجع القيمة.' });
      const encrypted = encryptSecret(key);
      const existing = await admin.from('settings').select('key').eq('key', 'onesignal_rest_api_key_encrypted').maybeSingle();
      if (existing.error) throw existing.error;
      const write = existing.data
        ? await admin.from('settings').update({ value: encrypted }).eq('key', 'onesignal_rest_api_key_encrypted')
        : await admin.from('settings').insert({ key: 'onesignal_rest_api_key_encrypted', value: encrypted });
      if (write.error) throw write.error;
      return json(res, 200, { success: true });
    }

    const { data: setting, error: settingError } = await admin.from('settings').select('value').eq('key', 'onesignal_rest_api_key_encrypted').maybeSingle();
    if (settingError) throw settingError;
    if (!setting?.value) return json(res, 400, { error: 'أضف REST API Key واحفظه أولاً.' });
    const restKey = decryptSecret(setting.value);

    if (action === 'test') {
      const test = await fetch('https://api.onesignal.com/apps/' + encodeURIComponent(app_id), { headers: { Authorization: 'Key ' + restKey } });
      const result = await test.json().catch(() => ({}));
      if (!test.ok) return json(res, 502, { error: 'فشل اختبار OneSignal؛ راجع المفتاح وصلاحياته.', details: result });
      return json(res, 200, { success: true });
    }
    if (action !== 'send') return json(res, 400, { error: 'Unsupported action' });

    let recipients = [];
    let notificationTitle = String(title || '').trim();
    let notificationBody = String(message || '').trim();
    if (event_type === 'order_created') {
      const { data: order, error } = await admin.from('orders').select('id,customer_id,order_no').eq('id', order_id).maybeSingle();
      if (error) throw error;
      if (!order || order.customer_id !== authData.user.id) return json(res, 403, { error: 'Forbidden' });
      const { data: admins, error: adminsError } = await admin.from('profiles').select('id').eq('role', 'admin');
      if (adminsError) throw adminsError;
      recipients = (admins || []).map(row => row.id);
      notificationTitle = 'طلب جديد 🛍️';
      notificationBody = 'تم استلام طلب جديد رقم #' + order.order_no;
    } else if (event_type === 'order_updated') {
      const { data: order, error } = await admin.from('orders').select('id,customer_id,order_no').eq('id', order_id).maybeSingle();
      if (error) throw error;
      if (!order) return json(res, 404, { error: 'Order not found' });
      recipients = [order.customer_id];
      notificationTitle = 'تحديث الطلب 🛍️';
      notificationBody = 'تم تحديث حالة طلبك #' + order.order_no;
    } else if (event_type === 'chat_message') {
      const { data: chatMessage, error: messageError } = await admin.from('yosif_support_messages')
        .select('id,conversation_id,sender_id,body').eq('id', message_id).maybeSingle();
      if (messageError) throw messageError;
      if (!chatMessage || chatMessage.sender_id !== authData.user.id) return json(res, 403, { error: 'Forbidden' });
      const { data: conversation, error: conversationError } = await admin.from('yosif_support_conversations')
        .select('id,customer_id').eq('id', chatMessage.conversation_id).maybeSingle();
      if (conversationError) throw conversationError;
      if (!conversation) return json(res, 404, { error: 'Conversation not found' });
      if (isAdmin) {
        recipients = [conversation.customer_id];
      } else {
        if (conversation.customer_id !== authData.user.id) return json(res, 403, { error: 'Forbidden' });
        const { data: admins, error: adminsError } = await admin.from('profiles').select('id').eq('role', 'admin');
        if (adminsError) throw adminsError;
        recipients = (admins || []).map(row => row.id);
      }
      notificationTitle = isAdmin ? 'رد جديد من الدعم 💬' : 'رسالة جديدة من عميل 💬';
      notificationBody = String(chatMessage.body || '').trim().slice(0, 140) || 'لديك رسالة جديدة في محادثة الدعم.';
    } else if (event_type === 'broadcast') {
      if (!notificationTitle || !notificationBody) return json(res, 400, { error: 'اكتب عنوان الإشعار ونص الرسالة.' });
      const { data: customers, error } = await admin.from('profiles').select('id').neq('role', 'admin');
      if (error) throw error;
      recipients = (customers || []).map(row => row.id);
    } else {
      return json(res, 400, { error: 'Unsupported event type' });
    }
    if (!recipients.length) return json(res, 200, { success: true, recipients: 0 });

    // Persist in-app notifications through the service-role client so the
    // recipient sees the same event even when browser push permission is off.
    const notificationRows = recipients.map(user_id => ({
      user_id,
      order_id: event_type === 'broadcast' ? null : order_id,
      type: event_type,
      title: notificationTitle,
      body: notificationBody
    }));
    for (let offset = 0; offset < notificationRows.length; offset += 500) {
      const batch = notificationRows.slice(offset, offset + 500);
      const saved = await admin.from('notifications').insert(batch);
      if (saved.error) throw saved.error;
    }

    const push = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Key ' + restKey },
      body: JSON.stringify({ app_id, include_aliases: { external_id: recipients }, target_channel: 'push', headings: { en: notificationTitle, ar: notificationTitle }, contents: { en: notificationBody, ar: notificationBody } })
    });
    const result = await push.json().catch(() => ({}));
    if (!push.ok) return json(res, 502, { error: 'فشل إرسال Push من OneSignal.', details: result });
    return json(res, 200, { success: true, recipients: recipients.length, result });
  } catch (error) {
    console.error('Yosif OneSignal API error:', error);
    return json(res, 500, { error: error?.message || 'Internal server error' });
  }
}