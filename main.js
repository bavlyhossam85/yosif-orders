import { createClient } from '@supabase/supabase-js'
import { YOSIF_SUPABASE_URL, YOSIF_SUPABASE_ANON_KEY } from './config.js'
import './style.css'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || YOSIF_SUPABASE_URL)?.trim()
const SUPABASE_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || YOSIF_SUPABASE_ANON_KEY)?.trim()

const app = document.querySelector('#app')
let supabase
let session = null
let profile = null
let products = []
let categories = []
let productReviews = []
let settings = {}
let orders = []
let orderItems = []
let notifications = []
let currentOrder = null
let authMode = 'login'
let adminView = 'dashboard'
let customerView = 'home'
let realtimeChannels = []
let activeCategory = 'الكل'
let productSearch = ''
let saleCountdownTimer = null
let selectedLocation = null
let deliveryZoneCheck = null
let adminDeliveryZones = []
let deliveryZoneMap = null
let deliveryZoneLayers = null
let favorites = new Set(JSON.parse(localStorage.getItem('yosif_favorites') || '[]'))
let cart = JSON.parse(localStorage.getItem('yosif_cart') || '[]')
let walletBalance = 0
let walletTransactions = []
let customerRewards = []
let spinSettings = null
let activeCoupons = []
let adminProfiles = []
let adminWallets = []

// Register the app shell service worker without disturbing OneSignal's worker.
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(err => console.warn('PWA worker:', err)))

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const installBtn = document.querySelector('#installBtn');
  if (installBtn) installBtn.style.display = 'inline-block';
});

let mediaRec, audioChunks = [];
window.voiceBlob = null;

// Push notifications are sent through the protected Vercel API.
// The OneSignal REST API key is never returned to or stored in browser code.
const ONESIGNAL_APP_ID = '97987044-7348-4399-bb86-eb5c8d9fa799';
async function callOneSignalApi(payload) {
  const { data: authData, error: authError } = await supabase.auth.getSession();
  if (authError) throw authError;
  const accessToken = authData.session?.access_token;
  if (!accessToken) throw new Error('انتهت جلسة الدخول؛ سجّل الدخول مرة أخرى.');
  const response = await fetch('/api/onesignal', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken }, body: JSON.stringify({ ...payload, app_id: ONESIGNAL_APP_ID }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'فشل تنفيذ طلب OneSignal');
  return result;
}
async function sendPushNotification(eventType, orderId, title='', message='') {
  try { return await callOneSignalApi({ action: 'send', event_type: eventType, order_id: orderId, title, message }); }
  catch (error) { console.error('OneSignal push failed:', error); toast(error.message || 'تعذر إرسال إشعار Push حالياً؛ تم حفظ الطلب/التحديث.', 'error'); return null; }
}

function renderNotes(notes) {
  if (!notes) return 'بدون تفاصيل';
  let audioHtml = '';
  let cleanNotes = notes;
  const urlRegex = /🎤 تسجيل صوتي: (https?:\/\/[^\s]+)/;
  const match = cleanNotes.match(urlRegex);
  
  if (match) {
    audioHtml = `<div style="margin-top:10px;"><audio controls style="height:40px; max-width:100%; background:#f3f4f6; border-radius:30px;" src="${esc(match[1])}"></audio></div>`;
    cleanNotes = cleanNotes.replace(match[0], ''); 
  }
  return esc(cleanNotes).replace(/\n/g, '<br>') + audioHtml;
}

window.printYosifOrder = function(id) {
  const o = orders.find(x => x.id === id);
  if(!o) return;
  const printWin = window.open('', '', 'width=800,height=600');
  printWin.document.write(`
    <html dir="rtl"><head><title>فاتورة يوسف أوردرز - #${o.order_no}</title>
    <style>
      body { font-family: Tahoma, Arial, sans-serif; padding: 30px; color: #111827; }
      .header { text-align: center; border-bottom: 3px solid #111827; padding-bottom: 15px; margin-bottom: 25px; }
      .logo { font-size: 32px; font-weight: 900; margin-bottom: 5px; }
      .sub { color: #6b7280; font-size: 16px; }
      .box { border: 1px solid #e5e7eb; padding: 15px; border-radius: 12px; margin-bottom: 20px; line-height: 1.8; }
      .total-box { background: #f3f4f6; padding: 15px; border-radius: 12px; font-size: 22px; font-weight: bold; text-align: center; }
      .footer { text-align: center; margin-top: 40px; color: #6b7280; font-size: 14px; }
    </style>
    </head><body>
      <div class="header">
        <div class="logo">🛍️ Yosif Orders</div>
        <div class="sub">طلبات العيلة في مكان واحد</div>
      </div>
      <div class="box">
        <b>رقم الطلب:</b> #${o.order_no} <br>
        <b>تاريخ الطلب:</b> ${fmtDate(o.created_at)} <br>
        <b>رقم موبايل العميل:</b> ${o.phone || 'غير مسجل'} <br>
        <b>طريقة الدفع المحددة:</b> ${paymentLabel(o.payment_method)}
      </div>
      <div class="box">
        <b>المنتجات المطلوبة:</b> ${esc(o.custom_request)}<br>
        <b>تفاصيل وعنوان التوصيل:</b><br>
        ${renderNotes(o.customer_notes)}
      </div>
      <div class="total-box">
        الإجمالي المطلوب تحصيله: ${money(o.total)}
      </div>
      <div class="footer">شكراً لاختيارك يوسف أوردرز ❤️</div>
      <script>window.print(); setTimeout(()=>window.close(), 1000);<\/script>
    </body></html>
  `);
  printWin.document.close();
}

function esc(v='') { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])) }
function money(v) { return `${Number(v || 0).toFixed(2)} ج.م` }
function toast(msg, type='info') {
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 3200)
}

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine' 
    o.frequency.setValueAtTime(523.25, ctx.currentTime) 
    o.frequency.setValueAtTime(659.25, ctx.currentTime + 0.15) 
    g.gain.setValueAtTime(0, ctx.currentTime)
    g.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.05)
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5)
    o.connect(g); g.connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 1.5)
  } catch {}
}

function adminBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    for(let i=0; i<8; i++) {
      osc.frequency.setValueAtTime(600, ctx.currentTime + (i*0.5))
      osc.frequency.setValueAtTime(800, ctx.currentTime + (i*0.5) + 0.25)
    }
    gain.gain.setValueAtTime(0, ctx.currentTime)
    gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.1)
    gain.gain.setValueAtTime(0.3, ctx.currentTime + 3.8)
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 4)
    osc.connect(gain); gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 4)
  } catch {}
}

async function compressImage(file, maxWidth = 1000, quality = 0.7) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > maxWidth) {
          h = Math.round((maxWidth / w) * h);
          w = maxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          resolve(new File([blob], file.name.replace(/\.[^/.]+$/, "") + ".jpg", { type: 'image/jpeg' }));
        }, 'image/jpeg', quality);
      };
    };
  });
}

function toLocalDateTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return ''
  return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,16)
}
function fmtDate(d) { return new Date(d).toLocaleString('ar-EG', {dateStyle:'short', timeStyle:'short'}) }
function statusLabel(s, pMethod='') {
  return ({
    pending_review: 'قيد المراجعة', 
    priced: pMethod === 'cash' ? 'تم التسعير' : 'تم التسعير (بانتظار الدفع)', 
    preparing: 'قيد التجهيز', 
    courier_near: 'المندوب يقترب', 
    out_for_delivery: 'في الطريق', 
    delivered: 'تم التسليم', 
    cancelled: 'ملغي'
  })[s] || s
}
function statusClass(s) { return `status-${s}` }
function paymentLabel(p) { return ({cash:'كاش',instapay:'InstaPay',wallet:'محفظة'})[p] || p }
function getSetting(key, fallback='') {
  const v = settings[key]?.value
  if (v === undefined || v === null) return fallback
  return typeof v === 'string' ? v : String(v)
}
function isAdmin() { return profile?.role === 'admin' }

async function init() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    app.innerHTML = `<div class="fatal"><h2>إعدادات Supabase ناقصة</h2></div>`
    return
  }
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  })
  supabase.auth.onAuthStateChange(async (_event, s) => {
    session = s
    if (s?.user) await loadProfile()
    else profile = null
    await render()
  })
  const { data, error } = await supabase.auth.getSession()
  if (error) { app.innerHTML = `<div class="fatal"><h2>تعذر الاتصال</h2><p>${esc(error.message)}</p></div>`; return }
  session = data.session
  if (session) await loadProfile()
  await render()

}

async function loadProfile() {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle()
  if (error) throw error
  profile = data
  
  // ربط المستخدم بـ OneSignal عشان نقدر نبعتله إشعار بالاسم
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(async function(OneSignal) {
    try { await OneSignal.login(session.user.id); } catch(e){}
  });
}

async function loadCommon() {
  let pQuery = supabase.from('products').select('*').order('created_at', {ascending:false});
  if (!isAdmin()) pQuery = pQuery.eq('active', true);

  const [p, c, s, n, r] = await Promise.all([
    pQuery,
    supabase.from('categories').select('*').order('sort_order', { ascending: true }),
    supabase.from('settings').select('*'),
    supabase.from('notifications').select('*').eq('user_id', session.user.id).order('created_at', {ascending:false}).limit(50),
    supabase.from('product_reviews').select('*').order('created_at',{ascending:false}).limit(300)
  ])
  if (p.error) throw p.error
  if (c.error) throw c.error
  categories = c.data || []
  productReviews = r.error ? [] : (r.data || [])
  if (s.data) settings = Object.fromEntries(s.data.filter(x => x.key !== 'onesignal_rest_api_key_encrypted').map(x => [x.key, x]))
  if (n.error) throw n.error
  products = p.data || []
  notifications = n.data || []
  const { data: savedWishlist, error: wishlistError } = await supabase.from('wishlists').select('product_id').eq('user_id', session.user.id)
  if (!wishlistError && savedWishlist) favorites = new Set(savedWishlist.map(row => row.product_id))

  const [walletResult, ledgerResult, rewardsResult, spinResult, couponsResult] = await Promise.all([
    supabase.from('wallets').select('balance').eq('user_id', session.user.id).maybeSingle(),
    supabase.from('wallet_transactions').select('*').eq('user_id', session.user.id).order('created_at', { ascending: false }).limit(20),
    supabase.from('customer_rewards').select('*').eq('user_id', session.user.id).is('used_at', null).order('created_at', { ascending: false }),
    supabase.from('spin_settings').select('*').eq('id', 1).maybeSingle(),
    supabase.from('coupons').select('*').eq('active', true).order('created_at', { ascending: false })
  ])
  walletBalance = Number(walletResult.data?.balance || 0)
  walletTransactions = ledgerResult.error ? [] : (ledgerResult.data || [])
  customerRewards = rewardsResult.error ? [] : (rewardsResult.data || [])
  spinSettings = spinResult.error ? null : spinResult.data
  activeCoupons = couponsResult.error ? [] : (couponsResult.data || []).filter(c => (!c.starts_at || new Date(c.starts_at) <= new Date()) && (!c.ends_at || new Date(c.ends_at) >= new Date()) && (c.usage_limit == null || Number(c.used_count || 0) < Number(c.usage_limit)))

  if (isAdmin()) {
    const [profilesResult, walletsResult, zonesResult] = await Promise.all([
      supabase.from('profiles').select('id,email,role').order('email', { ascending: true }),
      supabase.from('wallets').select('user_id,balance').order('updated_at', { ascending: false }),
      supabase.from('delivery_zones').select('*').order('created_at', { ascending: true })
    ])
    adminProfiles = profilesResult.error ? [] : (profilesResult.data || []).filter(x => x.role !== 'admin')
    adminWallets = walletsResult.error ? [] : (walletsResult.data || [])
    adminDeliveryZones = zonesResult.error ? [] : (zonesResult.data || [])
    if (zonesResult.error) console.warn('Delivery zones are unavailable:', zonesResult.error.message)
    const o = await supabase.from('orders').select('*').order('created_at',{ascending:false})
    if (o.error) throw o.error
    orders = (o.data || []).filter(x => x.status !== 'deleted')
  } else {
    const o = await supabase.from('orders').select('*').eq('customer_id',session.user.id).order('created_at',{ascending:false})
    if (o.error) throw o.error
    orders = (o.data || []).filter(x => x.status !== 'deleted')
  }
  if (orders.length) {
    const itemsResult = await supabase.from('order_items').select('*').in('order_id', orders.map(o=>o.id))
    if (itemsResult.error) console.warn('Order item details are unavailable until the order_items RLS migration is applied.', itemsResult.error)
    orderItems = itemsResult.data || []
  } else orderItems = []
}

async function render() {
  if (!session) return renderAuth()
  try {
    await loadCommon()
    subscribeRealtime()
    if (isAdmin()) renderAdmin()
    else renderCustomer()
  } catch (e) {
    console.error(e)
    app.innerHTML = `<div class="fatal"><h2>حصل خطأ في تحميل البيانات</h2><button onclick="location.reload()">إعادة المحاولة</button></div>`
  }
}

function renderAuth() {
  app.innerHTML = `
  <div class="auth-shell">
    <div class="auth-card">
      <div class="logo">🛍</div>
      <h1>Yosif Orders</h1>
      <p class="muted">طلبات العيلة في مكان واحد</p>
      <div class="tabs">
        <button class="${authMode==='login'?'active':''}" id="loginTab">تسجيل الدخول</button>
        <button class="${authMode==='signup'?'active':''}" id="signupTab">إنشاء حساب</button>
      </div>
      <form id="authForm">
        <label>الإيميل</label>
        <input id="email" type="email" required placeholder="name@example.com">
        <label>كلمة المرور</label>
        <input id="password" type="password" required minlength="6" placeholder="••••••••">
        <button class="primary" type="submit">${authMode==='login'?'دخول':'إنشاء الحساب'}</button>
      </form>
      <button class="linkbtn" id="forgot">نسيت كلمة المرور؟</button>
      <div id="authMsg" class="auth-msg"></div>
    </div>
  </div>`
  document.querySelector('#loginTab').onclick=()=>{authMode='login';renderAuth()}
  document.querySelector('#signupTab').onclick=()=>{authMode='signup';renderAuth()}
  document.querySelector('#forgot').onclick=forgotPassword
  document.querySelector('#authForm').onsubmit=handleAuth
}

async function handleAuth(e) {
  e.preventDefault()
  const email = document.querySelector('#email').value.trim()
  const password = document.querySelector('#password').value
  const msg = document.querySelector('#authMsg')
  msg.textContent='جاري التنفيذ...'
  const result = authMode==='login'
    ? await supabase.auth.signInWithPassword({email,password})
    : await supabase.auth.signUp({email,password})
  if (result.error) { msg.textContent = result.error.message; return }
  if (authMode==='signup' && !result.data.session) {
    msg.textContent = 'تم إنشاء الحساب بنجاح.'
    return
  }
  toast('تم بنجاح','success')
}

async function forgotPassword() {
  const email = prompt('اكتب الإيميل لاستلام رابط إعادة كلمة المرور:')
  if (!email) return
  const {error} = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: location.origin })
  if (error) toast(error.message,'error')
  else toast('تم إرسال رابط إعادة كلمة المرور','success')
}

async function logout() { 
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(async function(OneSignal) {
    try { await OneSignal.logout(); } catch(e){}
  });
  await supabase.auth.signOut(); 
  location.reload(); 
}

function shell(title, nav, content) {
  const unread = notifications.filter(n=>!n.read_at).length
  app.innerHTML = `
  <header class="topbar">
    <div class="brand">🛍️ Yosif Orders</div>
    <div class="top-actions">
      <button id="installBtn" class="primary small" style="display:${deferredPrompt ? 'inline-block' : 'none'}; background:#10b981; color:white; border-radius:10px; margin-left:5px;">⬇️ تثبيت التطبيق</button>
      <button id="notifBtn" class="iconbtn">🔔 <span class="badge">${unread||''}</span></button>
      <button id="themeBtn" class="iconbtn">🌓</button>
      <button id="logoutBtn" class="iconbtn">خروج</button>
    </div>
  </header>
  <div class="layout">
    <aside class="sidebar">
      <div class="userbox"><b>${esc(profile?.email||'')}</b><small>${isAdmin()?'👑 أدمن':'👤 عميل'}</small></div>
      ${nav}
    </aside>
    <main class="content"><div class="page-title"><h1>${title}</h1></div>${content}</main>
  </div>
  ${!isAdmin() ? `<button type="button" id="cartQuickBtn" class="floating-cart" aria-label="فتح السلة">🛒 <span>${cart.reduce((n,x)=>n+Number(x.quantity||0),0)}</span></button>` : ''}`
  
  document.querySelector('#logoutBtn').onclick=logout
  document.querySelector('#notifBtn').onclick=showNotifications
  document.querySelector('#themeBtn').onclick=toggleTheme
  document.querySelector('#cartQuickBtn')?.addEventListener('click',()=>{customerView='new';renderCustomer()})
  
  const installBtn = document.querySelector('#installBtn');
  if (installBtn) {
    installBtn.onclick = async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') installBtn.style.display = 'none';
      deferredPrompt = null;
    };
  }
}

function navBtn(id,label,active) { return `<button class="navbtn ${active?'active':''}" data-nav="${id}">${label}</button>` }
function wireNav() {
  document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{
    const id=b.dataset.nav
    if (isAdmin()) {adminView=id;renderAdmin()} else {customerView=id;renderCustomer()}
  })
}

function renderCustomer() {
  let content=''
  if (customerView==='home') content=customerHome()
  if (customerView==='products') content=customerProducts()
  if (customerView==='orders') content=customerOrders()
  if (customerView==='new') content=newOrderView()
  if (customerView==='rewards') content=customerRewardsView()
  shell('Yosif Orders', [
    navBtn('home','🏠 الرئيسية',customerView==='home'),
    navBtn('products','🛍 المنتجات',customerView==='products'),
    navBtn('new','➕ طلب جديد',customerView==='new'),
    navBtn('orders','📦 طلباتي',customerView==='orders'),
    navBtn('rewards','🎁 محفظتي ومكافآتي',customerView==='rewards')
  ].join(''), content)
  wireNav()
  wireCustomerEvents()
}

function customerHome() {
  const isClosed = getSetting('store_status', 'open') === 'closed';
  const actionBtn = isClosed 
    ? `<button class="secondary" disabled style="opacity:0.7;">الطلبات مغلقة حالياً</button>` 
    : `<button class="primary" data-nav="new">ابدأ طلب جديد</button>`;
  const latest=orders.slice(0,3).map(orderCard).join('') || `<div class="empty">لسه مفيش طلبات.</div>`
  return `<section class="hero"><div><span class="eyebrow">أهلاً بيك 👋</span><h2>اطلب اللي محتاجه بسهولة</h2><p>اختار منتج أو اكتب طلبك وسجله بصوتك، وإحنا نكمّل الباقي.</p>${actionBtn}</div></section>
  <div class="stats"><div><b>${orders.length}</b><span>إجمالي الطلبات</span></div><div><b>${notifications.filter(n=>!n.read_at).length}</b><span>إشعارات جديدة</span></div><div><b>${products.length}</b><span>منتجات متاحة</span></div></div>
  <div class="section-head"><h3>آخر الطلبات</h3></div>${latest}`
}

function categoryName(id) { return categories.find(x => x.id === id)?.name || '' }

function normalizeArabic(value='') {
  return String(value).toLowerCase().normalize('NFD')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[ؤئ]/g, 'ء').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}
function fuzzyMatch(text, query) {
  const a = normalizeArabic(text), q = normalizeArabic(query)
  if (!q || a.includes(q)) return true
  const tokens = q.split(' ').filter(Boolean)
  return tokens.every(token => a.split(' ').some(word => word.includes(token) || levenshtein(word, token) <= (token.length > 5 ? 2 : 1)))
}
function levenshtein(a,b) {
  const row = Array.from({length:b.length+1}, (_,i)=>i)
  for(let i=1;i<=a.length;i++) { let prev=row[0]; row[0]=i; for(let j=1;j<=b.length;j++){ const old=row[j]; row[j]=Math.min(row[j]+1,row[j-1]+1,prev+(a[i-1]===b[j-1]?0:1)); prev=old } }
  return row[b.length]
}
async function toggleFavorite(id) {
  const wasSaved = favorites.has(id)
  const result = wasSaved
    ? await supabase.from('wishlists').delete().eq('user_id', session.user.id).eq('product_id', id)
    : await supabase.from('wishlists').insert({ user_id: session.user.id, product_id: id })
  if (result.error) {
    toast('تعذر مزامنة المفضلة. تأكد من تطبيق ترحيل صلاحيات قاعدة البيانات.', 'error')
    return
  }
  wasSaved ? favorites.delete(id) : favorites.add(id)
  localStorage.setItem('yosif_favorites', JSON.stringify([...favorites]))
  renderCustomer()
}
function addToCart(productId, selectedOptions = {}) {
  const p = products.find(x => x.id === productId)
  if (!p || !p.active) return toast('المنتج غير متاح حالياً', 'error')
  const optionKey=JSON.stringify(selectedOptions||{})
  const item = cart.find(x => x.product_id === productId && JSON.stringify(x.selected_options||{})===optionKey)
  if (item) item.quantity = Math.min(100, Number(item.quantity || 1) + 1)
  else cart.push({ product_id: productId, quantity: 1, selected_options: selectedOptions||{}, item_note: '' })
  localStorage.setItem('yosif_cart', JSON.stringify(cart))
  toast(`تمت إضافة ${p.name} للسلة`, 'success')
  renderCustomer()
}
async function openProductReview(productId) {
  const product=products.find(p=>p.id===productId);if(!product)return
  const html=`<div class="modal-backdrop" id="reviewModal"><div class="modal"><button type="button" class="close" id="closeReview">×</button><h2>تقييم ${esc(product.name)}</h2><form id="reviewForm"><label>التقييم</label><select id="reviewRating" required><option value="">اختر عدد النجوم</option><option value="5">★★★★★ ممتاز</option><option value="4">★★★★ جيد جداً</option><option value="3">★★★ جيد</option><option value="2">★★ مقبول</option><option value="1">★ ضعيف</option></select><label>تعليقك (اختياري)</label><textarea id="reviewComment" maxlength="1000" rows="3"></textarea><button class="primary" type="submit">إرسال التقييم للمراجعة</button></form></div></div>`
  document.body.insertAdjacentHTML('beforeend',html)
  const close=()=>document.querySelector('#reviewModal')?.remove()
  document.querySelector('#closeReview').onclick=close
  document.querySelector('#reviewModal').addEventListener('click',e=>{if(e.target.id==='reviewModal')close()})
  document.querySelector('#reviewForm').onsubmit=async e=>{e.preventDefault();const rating=Number(document.querySelector('#reviewRating').value);const comment=document.querySelector('#reviewComment').value.trim();const {data,error}=await supabase.from('product_reviews').insert({product_id:productId,user_id:session.user.id,rating,comment,is_visible:false}).select().single();if(error)return toast(error.message,'error');productReviews.unshift(data);toast('تم إرسال تقييمك للمراجعة','success');close();renderCustomer()}
}

function getProductOptionGroups(product) {
  if(!Array.isArray(product.options))return []
  return product.options.map((opt,index)=>{
    if(typeof opt==='string')return {key:opt,label:opt,choices:[]}
    if(!opt||typeof opt!=='object')return null
    const label=opt.name||opt.label||opt.title||`اختيار ${index+1}`
    const choices=opt.values||opt.options||opt.choices||[]
    return {key:String(opt.id||opt.name||opt.label||index),label:String(label),choices:Array.isArray(choices)?choices:[]}
  }).filter(Boolean)
}
function openProductOptions(product) {
  const groups=getProductOptionGroups(product).filter(g=>g.choices.length)
  if(!groups.length)return addToCart(product.id)
  const html=`<div class="modal-backdrop" id="optionsModal"><div class="modal"><button type="button" class="close" id="closeOptions">×</button><h2>${esc(product.name)}</h2><form id="productOptionsForm">${groups.map((g,i)=>`<label>${esc(g.label)}<select data-product-option="${i}" required><option value="">اختر</option>${g.choices.map(choice=>{const value=typeof choice==='object'?(choice.value??choice.name??choice.label??''):choice;const label=typeof choice==='object'?(choice.label??choice.name??choice.value??''):choice;return `<option value="${esc(value)}">${esc(label)}</option>`}).join('')}</select></label>`).join('')}<button class="primary" type="submit">إضافة للسلة</button></form></div></div>`
  document.body.insertAdjacentHTML('beforeend',html)
  const close=()=>document.querySelector('#optionsModal')?.remove()
  document.querySelector('#closeOptions').onclick=close
  document.querySelector('#optionsModal').addEventListener('click',e=>{if(e.target.id==='optionsModal')close()})
  document.querySelector('#productOptionsForm').onsubmit=e=>{e.preventDefault();const selected={};groups.forEach((g,i)=>{selected[g.label]=document.querySelector(`[data-product-option="${i}"]`).value});close();addToCart(product.id,selected)}
}

function cartMarkup() {
  if (!cart.length) return '<div class="empty">السلة فارغة حالياً. اختار منتجات من صفحة المنتجات.</div>'
  return `<div class="cart-lines">${cart.map((item,index)=>{const p=products.find(x=>x.id===item.product_id);if(!p)return '';const sale=p.is_flash_sale&&p.sale_price!=null&&(!p.sale_starts_at||new Date(p.sale_starts_at)<=new Date())&&(!p.sale_ends_at||new Date(p.sale_ends_at)>new Date());const price=sale?Number(p.sale_price):Number(p.unit_price);return `<div class="cart-line"><div class="row"><b>${esc(p.name)}</b><span>${money(price*item.quantity)}</span></div>${Object.keys(item.selected_options||{}).length?`<small class="muted">${esc(Object.entries(item.selected_options).map(([k,v])=>k+': '+v).join(' • '))}</small>`:''}<div class="row"><button type="button" class="secondary small" data-cart-qty="${index}" data-delta="-1">−</button><b>${item.quantity}</b><button type="button" class="secondary small" data-cart-qty="${index}" data-delta="1">+</button><button type="button" class="danger small" data-cart-remove="${index}">حذف</button></div><label>ملاحظة للمنتج</label><input data-cart-note="${index}" value="${esc(item.item_note||'')}" maxlength="500" placeholder="مثلاً: بدون سكر"></div>`}).join('')}</div>
  <div class="row"><b>إجمالي المنتجات المبدئي</b><b>${money(cart.reduce((sum,item)=>{const p=products.find(x=>x.id===item.product_id);if(!p)return sum;const sale=p.is_flash_sale&&p.sale_price!=null&&(!p.sale_starts_at||new Date(p.sale_starts_at)<=new Date())&&(!p.sale_ends_at||new Date(p.sale_ends_at)>new Date());return sum+(Number(sale?p.sale_price:p.unit_price)*item.quantity)},0))}</b></div>
  <div class="cross-sell"><b>منتجات ممكن تحتاجها كمان</b><div class="cross-sell-items">${products.filter(p=>p.active&&!cart.some(x=>x.product_id===p.id)).sort(()=>Math.random()-.5).slice(0,3).map(p=>`<button type="button" class="secondary small" data-cross-sell="${p.id}">${esc(p.name)} · ${money(p.unit_price)} +</button>`).join('')||'<small class="muted">لا توجد اقتراحات إضافية حالياً</small>'}</div></div>
  <button type="button" class="secondary small" id="shareCartWhatsApp">مشاركة السلة عبر واتساب</button>`
}
function shareCartWhatsApp() {
  const lines=cart.map(item=>{const p=products.find(x=>x.id===item.product_id);return p?`• ${p.name} × ${item.quantity}${item.item_note?' — '+item.item_note:''}`:''}).filter(Boolean)
  if(!lines.length)return toast('السلة فارغة','error')
  const text=encodeURIComponent('قائمة مشترياتي من Yosif Orders:\n'+lines.join('\n'))
  window.open('https://wa.me/?text='+text,'_blank','noopener')
}

function customerProducts() {
  const isClosed = getSetting('store_status', 'open') === 'closed';
  const categoryTabs = [{id:'الكل',name:'الكل',icon:'🛍️'}, ...categories.filter(c=>c.active || isAdmin()).map(c=>({id:c.id,name:c.name,icon:c.icon||'📦'}))]
  const visible = products.filter(p => (activeCategory==='الكل' || p.category_id===activeCategory) && fuzzyMatch(`${p.name} ${p.unit||''} ${categoryName(p.category_id)}`, productSearch))
  return `<div class="section-head"><h3>المنتجات</h3><span class="muted">${visible.length} منتج</span></div>
  <div class="product-tools"><input id="productSearch" type="search" value="${esc(productSearch)}" placeholder="ابحث عن منتج... مثال: لبن، جبنه، سكر"><div class="category-tabs">${categoryTabs.map(c=>`<button class="category-tab ${activeCategory===c.id?'active':''}" data-category="${esc(c.id)}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}</div></div>
  <div class="product-grid">${visible.map(p=>{const now=Date.now(),starts=p.sale_starts_at?new Date(p.sale_starts_at).getTime():0,ends=p.sale_ends_at?new Date(p.sale_ends_at).getTime():Infinity;const sale=!!p.is_flash_sale&&p.sale_price!==null&&p.sale_price!==undefined&&now>=starts&&now<ends;return `<div class="product-card">
    ${p.image_url?`<img src="${esc(p.image_url)}" alt="">`:`<div class="product-placeholder">🛍️</div>`}
    <div class="pbody"><button class="favorite-btn ${favorites.has(p.id)?'is-favorite':''}" data-favorite="${p.id}" aria-label="إضافة للمفضلة">${favorites.has(p.id)?'♥':'♡'}</button><h3>${esc(p.name)}</h3><div class="muted">${sale?`<span style="text-decoration:line-through;opacity:.65">${money(p.unit_price)}</span> <b style="color:#dc2626">${money(p.sale_price)}</b>`:`${money(p.unit_price)}`} /${esc(p.unit)}</div><div class="muted">${(()=>{const rs=productReviews.filter(r=>r.product_id===p.id&&r.is_visible);return rs.length?`⭐ ${(rs.reduce((a,r)=>a+Number(r.rating),0)/rs.length).toFixed(1)} (${rs.length})`:'لا توجد تقييمات بعد'})()}</div><button type="button" class="linkbtn small" data-open-review="${p.id}">قيّم المنتج</button>
    ${sale?`<small class="flash-countdown" data-sale-end="${esc(p.sale_ends_at||'')}">⏳ عرض لفترة محدودة</small>`:''}
    <button class="${isClosed ? 'secondary' : 'primary'} small" data-product="${p.id}" ${isClosed ? 'disabled' : ''}>${isClosed ? 'مغلق' : 'أضف للسلة'}</button></div>
  </div>`}).join('') || '<div class="empty">مفيش منتجات مطابقة للبحث.</div>'}</div>`
}

function newOrderView(prefill={}) {
  if (getSetting('store_status', 'open') === 'closed') {
    return `<div class="card empty" style="padding:50px 20px;">
      <div style="font-size:50px; margin-bottom:15px;">🛵 🚫</div>
      <h2 style="color:var(--primary); margin-bottom:10px;">عذراً، المتجر مغلق حالياً</h2>
      <p class="muted">نعتذر لك، يرجى المحاولة في وقت لاحق.</p>
    </div>`;
  }

  return `<form id="orderForm" class="card">
    <div class="section-head"><h3>🛒 سلة المشتريات (${cart.reduce((n,x)=>n+Number(x.quantity||0),0)})</h3></div>
    ${cartMarkup()}
    <div class="grid2">
      <div><label>اسم صاحب الطلب</label><input id="oName" required value="${esc(prefill.name||'')}"></div>
      <div><label>رقم الواتساب</label><input id="oPhone" type="tel" required placeholder="01xxxxxxxxx"></div>
    </div>
    
    <label>العنوان بالتفصيل</label>
    <div style="display:flex; gap:8px;">
      <input id="oAddress" required placeholder="المنطقة، الشارع، الشقة..." style="flex:1;">
      <button type="button" id="getLocBtn" class="secondary" title="سحب موقعي تلقائياً" style="padding: 12px; border-radius: 12px; background: #e0e7ff; color: #3730a3;">📍</button>
    </div>
    <p id="deliveryZoneCustomerStatus" class="muted" aria-live="polite">حدد موقعك للتحقق من توفر التوصيل لمنطقتك (اختياري).</p>
    <label>موعد الاستلام أو التوصيل (اختياري)</label><input id="oScheduled" type="datetime-local">

    <label>طلب إضافي أو طلب خارجي (اختياري)</label><input id="oTitle" value="${esc(prefill.title||'')}" placeholder="اكتب أي شيء غير موجود في المتجر">
    
    <label>التفاصيل أو الكميات</label>
    <textarea id="oDetails" placeholder="اكتب المنتجات والكميات والتفاصيل...">${esc(prefill.details||'')}</textarea>
    
    <label>سجل طلباتك الخارجية بصوتك 🎤 (اختياري)</label>
    <div style="display:flex; gap:10px; align-items:center; margin-bottom:15px; background:var(--surface-1); padding:10px; border-radius:12px;">
      <button type="button" id="startVoice" style="background:#ef4444; color:white; border-radius:50%; width:42px; height:42px; border:none; display:flex; justify-content:center; align-items:center;">🎙️</button>
      <audio id="audioPreview" controls style="display:none; height:35px; max-width:180px;"></audio>
      <span id="voiceStatus" class="muted" style="flex:1; font-size:12px;">اضغط للتسجيل...</span>
      <button type="button" id="clearVoice" class="danger small hidden" style="border-radius:50%; width:32px; height:32px; padding:0;">❌</button>
    </div>

    <label>إرفاق صور للمنتجات (اختياري)</label>
    <input id="oImages" type="file" accept="image/*" multiple style="margin-bottom: 12px; font-size:13px;">
    
    <div><label>البقشيش (للمندوب - اختياري)</label><select id="oTip"><option value="0">بدون</option><option value="5">5 جنيه</option><option value="10">10 جنيه</option><option value="15">15 جنيه</option></select></div>

    <div class="grid2">
      <label>كود الخصم (اختياري)<select id="oCoupon"><option value="">بدون كوبون</option>${activeCoupons.map(c=>`<option value="${esc(c.code)}">${esc(c.title||c.code)} · ${esc(c.code)}</option>`).join('')}</select></label>
      <label>مكافأة تستخدمها (اختياري)<select id="oReward"><option value="">بدون مكافأة</option>${customerRewards.filter(r=>r.reward_type!=='wallet_credit'&&(!r.expires_at||new Date(r.expires_at)>new Date())).map(r=>`<option value="${r.id}">${esc(r.reward_type==='percentage_discount'?`خصم ${r.reward_value}%`:r.reward_type==='fixed_discount'?`خصم ${money(r.reward_value)}`:r.reward_type==='free_delivery'?'توصيل مجاني':r.reward_type==='wallet_credit'?`رصيد ${money(r.reward_value)}`:r.reward_type)}</option>`).join('')}</select></label>
    </div>
    
    <label>طريقة الدفع</label>
    <div class="pay-options">
      <label><input type="radio" name="pay" value="cash" checked> كاش (بدون رسوم)</label>
      <label><input type="radio" name="pay" value="instapay"> InstaPay (+2 ج.م)</label>
      <label><input type="radio" name="pay" value="wallet"> محفظة (+1%)</label>
    </div>
    <div class="notice" style="margin: 15px 0; background: var(--surface-2); padding: 12px; border-radius: 8px;">
      <b>ملاحظة:</b> سيتم إرسال الطلب للأدمن لتحديد السعر النهائي ومصاريف التوصيل.
    </div>
    <button class="primary" type="submit" style="width:100%;">إرسال الطلب 🚀</button>
  </form>`
}

function customerOrders() {
  return `<div class="searchrow"><input id="orderSearch" placeholder="بحث برقم الطلب..."></div>
  <div id="ordersList">${orders.map(orderCard).join('')||'<div class="empty">مفيش طلبات لسه.</div>'}</div>`
}

function orderFulfillmentMeta(order) {
  const scheduled=order.scheduled_for?`<div class="muted">🕒 الموعد: ${fmtDate(order.scheduled_for)}</div>`:''
  const hasCoords=Number.isFinite(Number(order.latitude))&&Number.isFinite(Number(order.longitude))&&order.latitude!==null&&order.longitude!==null
  const location=hasCoords?`<a class="small secondary" href="https://maps.google.com/?q=${encodeURIComponent(order.latitude+','+order.longitude)}" target="_blank" rel="noopener">📍 عرض موقع العميل</a>`:''
  return scheduled||location?`<div class="order-fulfillment-meta">${scheduled}${location}</div>`:''
}

function orderItemsHtml(orderId) {
  const rows=orderItems.filter(item=>item.order_id===orderId)
  if(!rows.length)return ''
  return `<div class="order-line-items">${rows.map(item=>`<div class="row"><span>${esc(item.product_name)} × ${Number(item.quantity)}</span><b>${money(item.line_total)}</b></div>${item.selected_options&&Object.keys(item.selected_options).length?`<small class="muted">${esc(Object.entries(item.selected_options).map(([k,v])=>k+': '+v).join(' • '))}</small>`:''}${item.item_note?`<small class="muted">ملاحظة: ${esc(item.item_note)}</small>`:''}`).join('')}</div>`
}

function orderCard(o) {
  const needsPayment = (o.status !== 'pending_review') && o.payment_method === 'instapay' && !o.payment_proof_url;
  let priceDisplay = '';
  if (o.status === 'pending_review') {
    priceDisplay = '<div class="muted" style="font-size:0.9em; margin-top:5px;">في انتظار تحديد التكلفة والتوصيل</div>';
  } else {
    priceDisplay = `
      <div style="font-size:0.9em; margin-top:8px; line-height:1.6; background:var(--surface-1); padding:8px; border-radius:6px;">
        <div>الطلبات: <b>${money(o.subtotal)}</b></div>
        <div>التوصيل: <b>${money(o.shipping_fee)}</b></div>
        ${Number(o.discount_amount)>0 ? `<div>الخصم: <b>−${money(o.discount_amount)}</b></div>` : ''}
        ${Number(o.wallet_used)>0 ? `<div>المدفوع من المحفظة: <b>${money(o.wallet_used)}</b></div>` : ''}
        ${o.tip > 0 ? `<div>إضافات: <b>${money(o.tip)}</b></div>` : ''}
        ${o.payment_fee > 0 ? `<div>رسوم الدفع: <b>${money(o.payment_fee)}</b></div>` : ''}
        <div style="margin-top:4px; font-size:1.1em; color:var(--primary);">الإجمالي: <b>${money(o.total)}</b></div>
      </div>`;
  }

  const imagesHtml = o.attached_images && o.attached_images.length > 0
    ? `<div style="display:flex; gap:8px; overflow-x:auto; margin-top:10px; padding-bottom:5px;">
        ${o.attached_images.map(img => `<a href="${esc(img)}" target="_blank"><img src="${esc(img)}" style="height:65px; width:65px; object-fit:cover; border-radius:8px; border:1px solid #d7dce5;"></a>`).join('')}
       </div>`
    : '';

  const pStatus = (o.payment_method === 'cash' || o.payment_method === 'wallet') ? '' : (o.payment_proof_url ? 'تم الرفع ✔️' : 'في انتظار التحويل');
  
  return `<article class="order-card" data-order-card="${o.order_no}">
    <div class="row"><div><b>طلب #${esc(o.order_no)}</b><div class="muted">${fmtDate(o.created_at)}</div></div><span class="status ${statusClass(o.status)}">${statusLabel(o.status, o.payment_method)}</span></div>
    <h3>${esc(o.custom_request)}</h3>${orderFulfillmentMeta(o)}${orderItemsHtml(o.id)}<p>${renderNotes(o.customer_notes)}</p>
    ${imagesHtml}
    <div class="order-meta" style="flex-direction:column; align-items:flex-start;">
      <span>طريقة الدفع: ${paymentLabel(o.payment_method)}</span>
      ${priceDisplay}
    </div>
    ${pStatus ? `<div class="muted" style="margin-top:8px;">حالة التحويل: ${pStatus}</div>` : ''}
    <div class="actions" style="margin-top: 12px; display: flex; gap: 8px;">
      <button class="secondary small" data-open-order="${o.id}">تتبع الطلب</button>
      ${needsPayment ? `<button class="primary small" style="background:var(--primary); color:white;" data-pay-order="${o.id}">إتمام الدفع وإرفاق الإيصال</button>` : ''}
    </div>
  </article>`
}

function startSaleCountdowns() {
  if (saleCountdownTimer) clearInterval(saleCountdownTimer)
  const update = () => {
    let expired = false
    document.querySelectorAll('[data-sale-end]').forEach(el => {
      const left = new Date(el.dataset.saleEnd).getTime() - Date.now()
      if (!Number.isFinite(left) || left <= 0) { el.textContent = 'انتهى العرض'; expired = true; return }
      const hours = Math.floor(left / 3600000), minutes = Math.floor((left % 3600000) / 60000), seconds = Math.floor((left % 60000) / 1000)
      el.textContent = `⏳ متبقي ${hours}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`
    })
    if (expired) { clearInterval(saleCountdownTimer); saleCountdownTimer = null; setTimeout(() => renderCustomer(), 250) }
  }
  update()
  saleCountdownTimer = setInterval(update, 1000)
}

function wireCustomerEvents() {
  startSaleCountdowns()
  const isClosed = getSetting('store_status', 'open') === 'closed';
  
  document.querySelectorAll('[data-nav="new"]').forEach(b=>b.onclick=()=>{
    if(!isClosed){ customerView='new'; renderCustomer() }
  })
  
  document.querySelector('#productSearch')?.addEventListener('input', e => { productSearch=e.target.value; const pos=e.target.selectionStart; renderCustomer(); const el=document.querySelector('#productSearch'); el?.focus(); el?.setSelectionRange(pos,pos) })
  document.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>{activeCategory=b.dataset.category; renderCustomer()})
  document.querySelectorAll('[data-favorite]').forEach(b=>b.onclick=()=>toggleFavorite(b.dataset.favorite))
  document.querySelectorAll('[data-open-review]').forEach(b=>b.onclick=()=>openProductReview(b.dataset.openReview))
  document.querySelectorAll('[data-product]').forEach(b=>b.onclick=()=>{ if(!isClosed){const p=products.find(x=>x.id===b.dataset.product);if(p&&getProductOptionGroups(p).length)openProductOptions(p);else addToCart(b.dataset.product)} })
  document.querySelectorAll('[data-cart-qty]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.cartQty);if(!cart[i])return;cart[i].quantity=Math.max(1,Math.min(100,cart[i].quantity+Number(b.dataset.delta)));localStorage.setItem('yosif_cart',JSON.stringify(cart));renderCustomer()})
  document.querySelectorAll('[data-cart-remove]').forEach(b=>b.onclick=()=>{cart.splice(Number(b.dataset.cartRemove),1);localStorage.setItem('yosif_cart',JSON.stringify(cart));renderCustomer()})
  document.querySelectorAll('[data-cart-note]').forEach(el=>el.onchange=()=>{const i=Number(el.dataset.cartNote);if(cart[i]){cart[i].item_note=el.value;localStorage.setItem('yosif_cart',JSON.stringify(cart))}})
  document.querySelector('#shareCartWhatsApp')?.addEventListener('click',shareCartWhatsApp)
  document.querySelectorAll('[data-cross-sell]').forEach(b=>b.onclick=()=>addToCart(b.dataset.crossSell))
  document.querySelector('#orderForm')?.addEventListener('submit',submitOrder)
  document.querySelectorAll('[data-open-order]').forEach(b=>b.onclick=()=>openOrder(b.dataset.openOrder))
  document.querySelectorAll('[data-pay-order]').forEach(b=>b.onclick=()=>openPayModal(b.dataset.payOrder))
  
  document.querySelector('#orderSearch')?.addEventListener('input',e=>{
    const q=e.target.value.trim()
    document.querySelectorAll('[data-order-card]').forEach(x=>x.style.display=!q||x.dataset.orderCard.includes(q)?'':'none')
  })

  document.querySelector('#getLocBtn')?.addEventListener('click', () => {
    if (!navigator.geolocation) return toast('المتصفح لا يدعم تحديد الموقع', 'error')
    toast('جاري تحديد موقعك...', 'info');
    navigator.geolocation.getCurrentPosition(async pos => {
      selectedLocation = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      deliveryZoneCheck = null;
      const address = document.querySelector('#oAddress');
      const mapLink = `📍 https://maps.google.com/?q=${pos.coords.latitude},${pos.coords.longitude}`;
      address.value = address.value.split(' | 📍 https://maps.google.com/?q=')[0].trim();
      address.value += (address.value ? ' | ' : '') + mapLink;
      const status = document.querySelector('#deliveryZoneCustomerStatus');
      if (status) status.textContent = 'جاري التحقق من منطقة التوصيل...';
      const { data, error } = await supabase.rpc('get_delivery_zone_for_point', { p_latitude: selectedLocation.latitude, p_longitude: selectedLocation.longitude });
      if (error) {
        if (status) status.textContent = 'تعذر التحقق من منطقة التوصيل. أعد المحاولة أو تواصل مع المتجر.';
        toast('تم تحديد الموقع، لكن فشل التحقق من منطقة التوصيل: ' + error.message, 'error');
        return;
      }
      deliveryZoneCheck = data || { inside: false };
      if (deliveryZoneCheck.inside) {
        if (status) status.textContent = `✅ داخل منطقة ${deliveryZoneCheck.name} · التوصيل ${money(deliveryZoneCheck.delivery_fee)} · الحد الأدنى ${money(deliveryZoneCheck.min_order)}`;
        toast('موقعك داخل نطاق التوصيل: ' + deliveryZoneCheck.name, 'success');
      } else {
        if (status) status.textContent = '⚠️ الموقع خارج مناطق التوصيل المتاحة حالياً.';
        toast('الموقع خارج مناطق التوصيل؛ لن نتمكن من قبول الطلب بهذا الموقع.', 'error');
      }
    }, () => toast('فشل تحديد الموقع، يرجى تفعيل GPS والسماح للموقع', 'error'), { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });

  document.querySelector('#startVoice')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (mediaRec && mediaRec.state === 'recording') {
        mediaRec.stop();
        document.querySelector('#voiceStatus').textContent = 'تم التسجيل ✅';
        btn.style.background = '#10b981';
    } else {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRec = new MediaRecorder(stream);
            mediaRec.ondataavailable = ev => audioChunks.push(ev.data);
            mediaRec.onstop = () => {
                window.voiceBlob = new Blob(audioChunks, { type: 'audio/webm' });
                document.querySelector('#audioPreview').src = URL.createObjectURL(window.voiceBlob);
                document.querySelector('#audioPreview').style.display = 'block';
                document.querySelector('#clearVoice').classList.remove('hidden');
                audioChunks = [];
            };
            mediaRec.start();
            document.querySelector('#voiceStatus').textContent = 'جاري التسجيل... (اضغط للإيقاف)';
            btn.style.background = '#991b1b';
        } catch(err) { toast('يرجى السماح باستخدام المايكروفون', 'error'); }
    }
  });

  document.querySelector('#clearVoice')?.addEventListener('click', () => {
    window.voiceBlob = null;
    document.querySelector('#audioPreview').style.display = 'none';
    document.querySelector('#clearVoice').classList.add('hidden');
    document.querySelector('#voiceStatus').textContent = 'اضغط للتسجيل...';
    document.querySelector('#startVoice').style.background = '#ef4444';
  });
}

async function submitOrder(e) {
  e.preventDefault()
  const pay = document.querySelector('input[name="pay"]:checked').value
  const tip = Number(document.querySelector('#oTip').value||0)
  const nameInput = document.querySelector('#oName').value.trim()
  const phoneInput = document.querySelector('#oPhone').value.trim()
  const addressInput = document.querySelector('#oAddress').value.trim()
  const titleInput = document.querySelector('#oTitle').value.trim()
  const detailsInput = document.querySelector('#oDetails').value.trim()
  const cartItems = cart.map(item=>({product_id:item.product_id,quantity:Number(item.quantity),selected_options:item.selected_options||{},item_note:item.item_note||''}))
  const cartTitle = cart.map(item=>{const p=products.find(x=>x.id===item.product_id);return p?`${p.name} × ${item.quantity}`:''}).filter(Boolean).join('، ')
  const finalTitle = [cartTitle,titleInput].filter(Boolean).join(' | ')
  if (!finalTitle) return toast('أضف منتجات للسلة أو اكتب طلبك الخارجي','error')
  if (selectedLocation && deliveryZoneCheck?.inside !== true) return toast('الموقع المحدد خارج مناطق التوصيل أو لم يكتمل التحقق منها. حدّث الموقع أو احذف إحداثياته.', 'error')
  
  const imageFiles = document.querySelector('#oImages').files;
  const btn = e.target.querySelector('button[type="submit"]')
  const originalText = btn.textContent
  btn.disabled = true
  
  let uploadedImages = [];
  if (imageFiles && imageFiles.length > 0) {
    btn.textContent = 'جاري ضغط ورفع الصور... ⏳';
    for (let i = 0; i < imageFiles.length; i++) {
      try {
        const compressedFile = await compressImage(imageFiles[i]);
        const path = `${session.user.id}/${crypto.randomUUID()}-img.jpg`;
        const { error: upErr } = await supabase.storage.from('order-images').upload(path, compressedFile);
        if (!upErr) uploadedImages.push(supabase.storage.from('order-images').getPublicUrl(path).data.publicUrl);
      } catch (err) { console.error(err); }
    }
  }

  let voiceUrl = null;
  if (window.voiceBlob) {
    btn.textContent = 'جاري رفع التسجيل الصوتي... 🎤';
    const vPath = `${session.user.id}/${crypto.randomUUID()}-voice.webm`;
    const { error: vErr } = await supabase.storage.from('order-images').upload(vPath, window.voiceBlob);
    if (!vErr) voiceUrl = supabase.storage.from('order-images').getPublicUrl(vPath).data.publicUrl;
  }

  btn.textContent = 'جاري إرسال الطلب...';
  
  let finalNotes = `الاسم: ${nameInput} | العنوان: ${addressInput} | التفاصيل: ${detailsInput}`;
  if (voiceUrl) finalNotes += `\n🎤 تسجيل صوتي: ${voiceUrl}`;

  const { data, error } = await supabase.rpc('create_customer_order', {
    p_phone: phoneInput,
    p_custom_request: finalTitle,
    p_customer_notes: finalNotes,
    p_attached_images: uploadedImages,
    p_payment_method: pay,
    p_tip: tip,
    p_items: cartItems,
    p_scheduled_for: document.querySelector('#oScheduled')?.value ? new Date(document.querySelector('#oScheduled').value).toISOString() : null,
    p_latitude: selectedLocation?.latitude ?? null,
    p_longitude: selectedLocation?.longitude ?? null
  })
  
  if (error) { toast(error.message, 'error'); btn.textContent = originalText; btn.disabled = false; return; }

  const couponCode = document.querySelector('#oCoupon')?.value || null;
  const rewardId = document.querySelector('#oReward')?.value || null;
  if (couponCode || rewardId) {
    const { error: promoError } = await supabase.rpc('set_order_promotions', {
      p_order_id: data.id, p_coupon_code: couponCode, p_reward_id: rewardId
    });
    if (promoError) toast('تم إنشاء الطلب، لكن تعذر ربط الخصم: ' + promoError.message, 'error');
  }
  
  // Notifications are written by trusted server-side workflows; customer-side
  // INSERT is intentionally not allowed by the database RLS policy.
  
  // Notify administrators through the authenticated server-side API.
  await sendPushNotification('order_created', data.id);
  
  toast(`تم إرسال الطلب بنجاح`,'success'); beep(); 
  cart = []; localStorage.removeItem('yosif_cart');
  selectedLocation = null;
  deliveryZoneCheck = null;
  window.voiceBlob = null; 
  customerView = 'orders'; await render(); 
  
  let adminPhone = getSetting('whatsapp_number', '01204110224');
  let cleanAdminPhone = adminPhone.replace(/\D/g, '');
  if (cleanAdminPhone.startsWith('0')) cleanAdminPhone = '2' + cleanAdminPhone;
  else if (!cleanAdminPhone.startsWith('20')) cleanAdminPhone = '20' + cleanAdminPhone;
  
  const adminMsg = encodeURIComponent(`🚨 *طلب جديد - Yosif Orders* 🚨\n\nرقم الطلب: #${data.order_no}\nالاسم: ${nameInput}\nموبايل: ${phoneInput}\nالعنوان: ${addressInput}\nالطلب: ${titleInput}\nالدفع: ${paymentLabel(pay)}\nالبقشيش: ${tip} ج.م\n\nبرجاء مراجعة الطلب من لوحة التحكم.`);
  window.location.href = `https://wa.me/${cleanAdminPhone}?text=${adminMsg}`;
}

async function openOrder(id) {
  const o=orders.find(x=>x.id===id)
  if (!o) return
  currentOrder=o
  const {data:events}=await supabase.from('order_events').select('*').eq('order_id',id).order('created_at',{ascending:false})
  const html=`<div class="modal-backdrop" id="modal"><div class="modal"><button class="close" id="close">×</button>
    <h2>طلب #${o.order_no}</h2><span class="status ${statusClass(o.status)}">${statusLabel(o.status, o.payment_method)}</span>
    <p><b>${esc(o.custom_request)}</b></p><p>${renderNotes(o.customer_notes)}</p>
    <div class="timeline">${(events||[]).map(e=>`<div>${esc(statusLabel(e.status, o.payment_method))} - ${esc(e.note)}<small>${fmtDate(e.created_at)}</small></div>`).join('')}</div>
  </div></div>`
  document.body.insertAdjacentHTML('beforeend',html)
  document.querySelector('#close').onclick=()=>document.querySelector('#modal').remove()
  document.querySelector('#modal').addEventListener('click', e => { if(e.target.id==='modal') e.currentTarget.remove() })
}

async function openPayModal(id) {
  const o = orders.find(x => x.id === id)
  if (!o) return
  const isInsta = o.payment_method === 'instapay'
  const url = getSetting(isInsta ? 'instapay_qr_url' : 'wallet_qr_url')
  let wa = getSetting('whatsapp_number', '01204110224');
  
  const html = `<div class="modal-backdrop" id="payModal">
    <div class="modal">
      <button class="close" id="closePay">×</button>
      <h2>دفع طلب #${o.order_no}</h2>
      <p style="margin-bottom:15px; font-size:1.1em;">المبلغ المطلوب للإجمالي: <b style="color:var(--primary);">${money(o.total)}</b></p>
      ${wa ? `<div style="margin-bottom:15px; text-align:center; background:var(--surface-1); padding:10px; border-radius:8px;"><p style="margin:0;">رقم التحويل:</p><b style="font-size:1.3em; color:var(--primary);">${esc(wa)}</b></div>` : ''}
      ${url ? `<div style="text-align:center; margin-bottom:15px"><img src="${esc(url)}" class="setting-img" style="max-width:200px; border-radius:8px; margin:auto;"></div>` : ''}
      <label>صورة إثبات التحويل</label>
      <input id="lateReceipt" type="file" accept="image/*">
      <button class="primary" id="submitLatePay" style="margin-top:15px; width:100%">تأكيد الرفع</button>
    </div>
  </div>`
  document.body.insertAdjacentHTML('beforeend', html)
  document.querySelector('#closePay').onclick = () => document.querySelector('#payModal').remove()
  document.querySelector('#payModal').addEventListener('click', e => { if(e.target.id==='payModal') e.currentTarget.remove() })
  document.querySelector('#submitLatePay').onclick = async () => {
    const receipt = document.querySelector('#lateReceipt').files?.[0]
    if (!receipt) { toast('يرجى اختيار صورة التحويل', 'error'); return }
    const btn = document.querySelector('#submitLatePay')
    btn.textContent = 'جاري الرفع...'; btn.disabled = true
    const safeName = receipt.name.replace(/[^\w.\-]+/g,'_').slice(-100) || 'receipt.jpg'
    const path = `${session.user.id}/${id}/${crypto.randomUUID()}-${safeName}`
    const up = await supabase.storage.from('payment-proofs').upload(path, receipt, { upsert: false, contentType: receipt.type || 'image/jpeg' })
    if (up.error) { toast(up.error.message, 'error'); btn.textContent = 'تأكيد الرفع'; btn.disabled = false; return }
    const { data: receiptId, error: submitError } = await supabase.rpc('submit_payment_receipt', {
      p_order_id: id,
      p_storage_path: path,
      p_review_note: null
    })
    if (submitError) {
      await supabase.storage.from('payment-proofs').remove([path])
      toast(submitError.message, 'error'); btn.textContent = 'تأكيد الرفع'; btn.disabled = false; return
    }
    toast('تم استلام إثبات الدفع وإرساله للمراجعة', 'success')
    document.querySelector('#payModal').remove()
    await render()
  }
}

function renderAdmin() {
  let content=''
  if (adminView==='dashboard') content=adminDashboard()
  if (adminView==='products') content=adminProducts()
  if (adminView==='orders') content=adminOrders()
  if (adminView==='settings') content=adminSettings()
  if (adminView==='reviews') content=adminReviews()
  if (adminView==='loyalty') content=adminLoyalty()
  shell('لوحة الأدمن', [
    navBtn('dashboard','📊 الرئيسية',adminView==='dashboard'),
    navBtn('orders','📦 الطلبات',adminView==='orders'),
    navBtn('products','🛍️ المنتجات',adminView==='products'),
    navBtn('reviews','⭐ التقييمات',adminView==='reviews'),
    navBtn('loyalty','🎁 المحفظة والمكافآت',adminView==='loyalty'),
    navBtn('settings','⚙️ الإعدادات',adminView==='settings')
  ].join(''), content)
  wireNav(); wireAdminEvents()
}

function customerRewardsView() {
  const rewardLabel = r => r.reward_type === 'percentage_discount' ? `خصم ${Number(r.reward_value)}%` : r.reward_type === 'fixed_discount' ? `خصم ${money(r.reward_value)}` : r.reward_type === 'free_delivery' ? 'توصيل مجاني' : r.reward_type === 'wallet_credit' ? `${money(r.reward_value)} رصيد` : r.reward_type;
  const transactions = walletTransactions.map(t => `<div class="wallet-ledger-row"><div><b>${esc(t.description || t.transaction_type || 'حركة رصيد')}</b><small>${fmtDate(t.created_at)}</small></div><strong>${['admin_debit','order_debit'].includes(t.transaction_type) ? '−' : '+'}${money(t.amount)}</strong></div>`).join('') || '<div class="empty">لا توجد حركات على المحفظة حتى الآن.</div>';
  const rewards = customerRewards.map(r => `<div class="reward-row"><b>${esc(rewardLabel(r))}</b><small>صالحة حتى ${r.expires_at ? fmtDate(r.expires_at) : 'بدون تاريخ انتهاء'}</small></div>`).join('') || '<div class="empty">لا توجد مكافآت متاحة حالياً.</div>';
  const coupons = activeCoupons.map(c => `<div class="reward-row"><div><b>${esc(c.title || c.code)}</b><small>${esc(c.code)} · ${c.discount_type === 'percentage' || c.discount_type === 'percent' ? `${c.discount_value}%` : money(c.discount_value)}</small></div></div>`).join('') || '<div class="empty">لا توجد كوبونات متاحة حالياً.</div>';
  const wheelEnabled = spinSettings?.enabled === true;
  return `<div class="wallet-summary card"><div><span class="muted">رصيد محفظتك</span><strong>${money(walletBalance)}</strong></div><span class="wallet-icon">💳</span></div>
    <div class="card"><div class="section-head"><h3>🎡 عجلة الحظ</h3><span class="muted">${wheelEnabled ? `حتى ${Number(spinSettings.daily_limit || 1)} محاولة يومياً` : 'غير متاحة حالياً'}</span></div><p class="muted">لف العجلة لتحصل على مكافأة من المتجر. سيتم تسجيل النتيجة على حسابك مباشرة.</p><button class="primary" id="spinNow" ${wheelEnabled ? '' : 'disabled'}>🎡 جرّب حظك</button></div>
    <div class="card"><h3>🎁 مكافآتي</h3>${rewards}</div>
    <div class="card"><h3>🏷️ الكوبونات المتاحة</h3>${coupons}<p class="muted">عرض الكوبونات فقط حالياً؛ تطبيق الخصم عند الدفع يحتاج ربط خطوة checkout الآمنة.</p></div>
    <div class="card"><h3>📒 سجل المحفظة</h3>${transactions}</div>`;
}

async function spinTheWheel() {
  const btn = document.querySelector('#spinNow');
  if (!btn || btn.disabled) return;
  btn.disabled = true; btn.textContent = '🎡 العجلة بتلف...';
  const { data, error } = await supabase.rpc('spin_customer_wheel');
  if (error) { toast(error.message, 'error'); btn.disabled = false; btn.textContent = '🎡 جرّب حظك'; return; }
  const r = data?.reward || {};
  const label = r.label || (r.type === 'wallet' ? `${money(r.value)} رصيد` : r.type === 'discount' ? `خصم ${r.value}%` : r.type === 'free_delivery' ? 'توصيل مجاني' : 'مكافأة');
  toast(`مبروك! كسبت: ${label} 🎉`, 'success');
  await render();
}

function adminLoyalty() {
  const customers = adminProfiles.map(p => `<option value="${p.id}">${esc(p.email || p.id)} · ${p.id.slice(0,8)}</option>`).join('');
  const balances = adminProfiles.map(p => { const w=adminWallets.find(x=>x.user_id===p.id); return `<div class="wallet-ledger-row"><div><b>${esc(p.email || p.id)}</b><small>${p.id}</small></div><strong>${money(w?.balance || 0)}</strong></div>`; }).join('') || '<div class="empty">لا يوجد عملاء ظاهرون.</div>';
  return `<div class="card"><h3>🎡 إعدادات عجلة الحظ</h3><div class="grid2"><label class="inline-check"><input id="spinEnabled" type="checkbox" ${spinSettings?.enabled ? 'checked' : ''}> تفعيل العجلة</label><label>عدد المحاولات اليومية<input id="spinDailyLimit" type="number" min="1" max="50" value="${Number(spinSettings?.daily_limit || 1)}"></label></div><label>المكافآت (JSON)</label><textarea id="spinRewardsJson" rows="8">${esc(JSON.stringify(spinSettings?.rewards || [{type:'wallet',value:10,label:'10 جنيه رصيد'},{type:'discount',value:10,label:'خصم 10%',expires_in_days:7},{type:'free_delivery',value:0,label:'توصيل مجاني',expires_in_days:7}],null,2))}</textarea><p class="muted">الأنواع المدعومة: wallet / discount / free_delivery. اكتب قيمة موجبة للمحفظة ونسبة من 1 إلى 100 للخصم.</p><button class="primary" id="saveSpinSettings">حفظ إعدادات العجلة</button></div>
    <div class="card"><h3>💳 تعديل رصيد عميل</h3><form id="walletAdminForm"><label>العميل<select id="walletCustomer" required><option value="">اختر العميل</option>${customers}</select></label><div class="grid2"><label>نوع العملية<select id="walletAction"><option value="credit">إضافة رصيد</option><option value="debit">خصم رصيد</option><option value="set">تعيين الرصيد مباشرة</option></select></label><label>المبلغ بالجنيه<input id="walletAmount" type="number" min="0" max="1000000" step="0.01" required></label></div><label>السبب<input id="walletDescription" maxlength="500" value="تعديل رصيد من الإدارة"></label><button class="primary" type="submit">تنفيذ العملية</button></form></div>
    <div class="card"><h3>👥 أرصدة العملاء</h3>${balances}</div>`;
}

async function saveSpinSettings() {
  let rewards;
  try { rewards = JSON.parse(document.querySelector('#spinRewardsJson').value); if (!Array.isArray(rewards) || !rewards.length) throw new Error('أدخل مصفوفة مكافآت غير فارغة'); }
  catch (e) { return toast('JSON غير صحيح: ' + e.message, 'error'); }
  const enabled = document.querySelector('#spinEnabled').checked;
  const daily_limit = Number(document.querySelector('#spinDailyLimit').value);
  if (!Number.isInteger(daily_limit) || daily_limit < 1 || daily_limit > 50) return toast('عدد المحاولات يجب أن يكون من 1 إلى 50', 'error');
  const { error } = await supabase.from('spin_settings').upsert({ id: 1, enabled, daily_limit, rewards, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) return toast(error.message, 'error');
  toast('تم حفظ إعدادات العجلة', 'success'); await render();
}

async function adjustCustomerWallet(e) {
  e.preventDefault();
  const userId = document.querySelector('#walletCustomer').value;
  const amount = Number(document.querySelector('#walletAmount').value);
  const action = document.querySelector('#walletAction').value;
  const description = document.querySelector('#walletDescription').value.trim() || 'تعديل رصيد من الإدارة';
  if (!userId || !Number.isFinite(amount) || amount < 0 || amount > 1000000) return toast('راجع العميل والمبلغ', 'error');
  const rpc = action === 'set' ? 'set_customer_wallet_balance' : 'adjust_customer_wallet';
  const params = action === 'set' ? { p_user_id: userId, p_new_balance: amount, p_description: description } : { p_user_id: userId, p_amount: action === 'debit' ? -amount : amount, p_description: description };
  const { error } = await supabase.rpc(rpc, params);
  if (error) return toast(error.message, 'error');
  toast('تم تحديث رصيد العميل وتسجيل العملية', 'success'); await render();
}

function adminReviews() {
  return `<div class="card"><h3>مراجعة تقييمات المنتجات</h3>${productReviews.map(r=>{const p=products.find(x=>x.id===r.product_id);return `<div class="review-row"><div><b>${esc(p?.name||'منتج محذوف')}</b><div> ${'★'.repeat(Number(r.rating))}${'☆'.repeat(5-Number(r.rating))}</div><p>${esc(r.comment||'بدون تعليق')}</p><small class="muted">العميل: ${esc(r.user_id)} · ${fmtDate(r.created_at)}</small></div><button class="${r.is_visible?'danger':'primary'} small" data-review-visibility="${r.id}" data-visible="${r.is_visible?'true':'false'}">${r.is_visible?'إخفاء':'نشر'}</button></div>`}).join('')||'<div class="empty">لا توجد تقييمات.</div>'}</div>`
}

function adminDashboard() {
  const newCount=orders.filter(o=>o.status==='pending_review').length;
  const isOpen = getSetting('store_status', 'open') === 'open';
  return `
  <div class="card" style="margin-bottom:15px; display:flex; justify-content:space-between; align-items:center;">
    <div><b>حالة المتجر:</b> <span class="status ${isOpen ? 'status-delivered' : 'status-cancelled'}">${isOpen ? 'مفتوح' : 'مغلق'}</span></div>
    <button class="${isOpen ? 'danger' : 'primary'} small" id="quickToggleStore">${isOpen ? 'إغلاق المتجر' : 'فتح المتجر'}</button>
  </div>
  <div class="stats"><div><b>${orders.length}</b><span>كل الطلبات</span></div><div><b>${newCount}</b><span>طلبات جديدة</span></div><div><b>${products.length}</b><span>المنتجات</span></div></div>
  <div class="section-head"><h3>آخر الطلبات</h3><button class="secondary small" data-nav="orders">كل الطلبات</button></div>
  ${orders.slice(0,8).map(adminOrderCard).join('')||'<div class="empty">مفيش طلبات.</div>'}`
}

function adminOrders() {
  return `<div class="toolbar"><input id="adminSearch" placeholder="ابحث برقم الطلب أو الاسم"><select id="statusFilter"><option value="">كل الحالات</option><option value="pending_review">قيد المراجعة</option><option value="priced">تم التسعير</option><option value="preparing">قيد التجهيز</option><option value="courier_near">المندوب يقترب</option><option value="out_for_delivery">في الطريق</option><option value="delivered">تم التسليم</option><option value="cancelled">ملغي</option></select></div>
  <div id="adminOrdersList">${orders.map(adminOrderCard).join('')||'<div class="empty">مفيش طلبات.</div>'}</div>`
}

function adminOrderCard(o) {
  const canDelete = o.status === 'cancelled' || o.status === 'delivered';
  const imagesHtml = o.attached_images && o.attached_images.length > 0
    ? `<div style="display:flex; gap:8px; overflow-x:auto; margin-top:10px; padding-bottom:5px;">
        ${o.attached_images.map(img => `<a href="${esc(img)}" target="_blank"><img src="${esc(img)}" style="height:65px; width:65px; object-fit:cover; border-radius:8px;"></a>`).join('')}
       </div>`
    : '';

  return `<article class="order-card admin-order" data-search="${esc(`${o.order_no}${o.customer_notes}${o.customer_id}${o.phone||''}`.toLowerCase())}">
    <div class="row"><div><b>#${o.order_no}</b><div class="muted">${fmtDate(o.created_at)}</div></div><span class="status ${statusClass(o.status)}">${statusLabel(o.status, o.payment_method)}</span></div>
    <h3>${esc(o.custom_request)}</h3>${orderFulfillmentMeta(o)}${orderItemsHtml(o.id)}<p>${renderNotes(o.customer_notes)}</p>
    ${o.phone ? `<div class="muted">📱 ${esc(o.phone)}</div>` : ''}
    ${imagesHtml}
    
    <div class="grid2" style="margin-top: 10px;">
      <label>سعر الطلبات<input type="number" class="priceEdit" data-id="${o.id}" value="${o.subtotal||0}" ${o.status==='pending_review'?'':'disabled'}></label>
      <label>${o.latitude!=null && o.longitude!=null?'رسوم التوصيل (تلقائي حسب المنطقة)':'رسوم التوصيل (يدوي)'}<input type="number" class="shippingEdit" data-id="${o.id}" value="${o.shipping_fee||0}" ${o.status==='pending_review' && !(o.latitude!=null && o.longitude!=null)?'':'disabled'}></label>
    </div>
    <div class="grid2" style="margin-top: 8px;">
      <label>البقشيش<input type="number" class="tipEdit" data-id="${o.id}" value="${o.tip||0}" ${o.status==='pending_review'?'':'disabled'}></label>
    </div>

    <div class="row" style="margin-top: 10px;"><span>الإجمالي: <b style="color:var(--primary);">${money(o.total)}</b></span></div>
    ${Number(o.discount_amount)>0?`<div class="muted">الخصم المطبق: −${money(o.discount_amount)}</div>`:''}
    ${Number(o.wallet_used)>0?`<div class="muted">تم الخصم من محفظة العميل: ${money(o.wallet_used)}</div>`:''}
    
    ${o.payment_proof_url?`<div class="actions" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;"><button class="secondary small" data-receipt="${o.id}">عرض إثبات التحويل المرفق</button><button class="primary small" data-review-receipt="${o.id}" data-review-status="accepted">قبول الإيصال</button><button class="danger small" data-review-receipt="${o.id}" data-review-status="rejected">رفض الإيصال</button></div>`:''}
    
    <div class="actions" style="margin-top: 15px;">
      <select class="statusEdit" data-id="${o.id}">
        ${['pending_review','priced','preparing','courier_near','out_for_delivery','delivered','cancelled'].map(s=>`<option value="${s}" ${o.status===s?'selected':''}>${statusLabel(s, o.payment_method)}</option>`).join('')}
      </select>
      <button class="primary small" data-save-order="${o.id}">حفظ</button>
      <button class="secondary small" style="background:#e0e7ff; color:#3730a3;" onclick="printYosifOrder('${o.id}')">🖨️ طباعة</button>
      ${canDelete ? `<button class="danger small" style="margin-right:8px;" data-delete-order="${o.id}">🗑️ حذف</button>` : ''}
    </div>
  </article>`
}

function adminProducts() {
  return `<div class="card"><h3>🗂️ إدارة الأقسام</h3><form id="categoryForm" class="grid2"><label>اسم القسم<input id="categoryName" required maxlength="80"></label><label>الأيقونة (Emoji)<input id="categoryIcon" maxlength="8" placeholder="🥛"></label><button class="primary" type="submit">إضافة القسم</button></form><div class="muted">${categories.map(c=>`${esc(c.icon||'📦')} ${esc(c.name)} ${c.active?'':'(مخفي)' }`).join(' • ')}</div></div><div class="card"><h3>➕ إضافة منتج جديد</h3><form id="productForm" class="grid2">
    <label>اسم المنتج<input id="pName" required></label>
    <label>السعر<input id="pPrice" type="number" min="0" step="0.01" required></label>
    <label>الوحدة<input id="pUnit" value="وحدة"></label>
    <label>القسم<select id="pCategory"><option value="">بدون قسم</option>${categories.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
    <label>خيارات المنتج (JSON اختياري)<textarea id="pOptions" rows="2" placeholder='[{"name":"الحجم","values":["صغير","كبير"]}]'></textarea></label>
    <label>الصورة<input id="pImage" type="file" accept="image/*"></label>
    <button class="primary" type="submit">إضافة المنتج</button>
  </form></div>
  <div class="product-grid admin-products">${products.map(p=>`<div class="product-card" style="${p.active?'':'opacity:0.6;'}">
    ${p.image_url?`<img src="${esc(p.image_url)}" alt="">`:`<div class="product-placeholder">🛍️</div>`}
    <div class="pbody">
      <input class="editName" data-id="${p.id}" value="${esc(p.name)}">
      <div class="grid2" style="gap:6px;">
        <input class="editPrice" data-id="${p.id}" type="number" step="0.01" value="${p.unit_price}">
        <input class="editUnit" data-id="${p.id}" value="${esc(p.unit)}">
      </div>
      <label style="display:flex;align-items:center;gap:8px;"><input class="editFlash" data-id="${p.id}" type="checkbox" ${p.is_flash_sale?'checked':''} style="width:auto;"> عرض مؤقت</label>
      <div class="grid2" style="gap:6px;"><input class="editSalePrice" data-id="${p.id}" type="number" min="0" step="0.01" value="${p.sale_price??''}" placeholder="سعر العرض"><input class="editSaleStart" data-id="${p.id}" type="datetime-local" value="${toLocalDateTime(p.sale_starts_at)}"></div>
      <label>نهاية العرض<input class="editSaleEnd" data-id="${p.id}" type="datetime-local" value="${toLocalDateTime(p.sale_ends_at)}"></label>
      <label>خيارات المنتج (JSON)<textarea class="editOptions" data-id="${p.id}" rows="2">${esc(JSON.stringify(p.options||[]))}</textarea></label>
      <input class="editImage" data-id="${p.id}" type="file" accept="image/*" style="font-size:11px; padding:4px; margin-top:5px;">
      <div class="actions" style="margin-top:10px; display:flex; gap:6px;">
        <button class="primary small" data-update-product="${p.id}">💾 حفظ</button>
        <button class="secondary small" data-toggle-product="${p.id}">${p.active?'إخفاء':'إظهار'}</button>
        <button class="danger small" data-delete-product="${p.id}">🗑 حذف</button>
      </div>
    </div>
  </div>`).join('') || '<div class="empty">مفيش منتجات.</div>'}</div>`
}

function adminSettings() {
  const i=getSetting('instapay_qr_url'), w=getSetting('wallet_qr_url'), wa=getSetting('whatsapp_number')
  return `<div class="card"><h3>💳 الدفع وواتساب</h3>
  <div class="grid2"><div><label>QR InstaPay</label><input id="instaQrFile" type="file" accept="image/*">${i?`<img class="setting-img" src="${esc(i)}">`:''}</div>
  <div><label>QR المحفظة</label><input id="walletQrFile" type="file" accept="image/*">${w?`<img class="setting-img" src="${esc(w)}">`:''}</div></div>
  <label>رقم WhatsApp والمحفظة</label><input id="waNumber" value="${esc(wa)}" placeholder="2010xxxxxxxx">
  <button class="primary" id="saveSettings">حفظ الإعدادات</button></div>
  <div class="card"><div class="section-head"><h3>🗺️ مناطق التوصيل</h3><span class="muted">ارسم أكثر من منطقة على الخريطة</span></div>
  <p class="muted">ارسم مضلعاً يغطي حدود المنطقة، ثم احفظ الاسم ورسوم التوصيل والحد الأدنى. يمكن تعديل حدود المناطق أو حذفها من أدوات الخريطة.</p>
  <div class="grid2"><label>اسم المنطقة<input id="deliveryZoneName" maxlength="100" placeholder="مثلاً: شبرا البلد"></label><label>رسوم التوصيل (جنيه)<input id="deliveryZoneFee" type="number" min="0" max="10000" step="0.01" value="10"></label></div>
  <label>الحد الأدنى للطلب (جنيه)<input id="deliveryZoneMin" type="number" min="0" max="100000" step="0.01" value="0"></label>
  <div id="deliveryZoneMap" class="delivery-zone-map" role="application" aria-label="خريطة رسم مناطق التوصيل"></div>
  <p id="deliveryZoneStatus" class="muted" aria-live="polite">جاري تجهيز الخريطة...</p>
  <div id="deliveryZoneList" class="delivery-zone-list"></div></div>
    <div class="card"><h3>🔐 إعدادات OneSignal</h3><label>OneSignal App ID</label><input value="97987044-7348-4399-bb86-eb5c8d9fa799" readonly><label>REST API Key</label><input id="oneSignalRestKey" type="password" autocomplete="new-password" placeholder="الصق المفتاح هنا — لن يتم عرضه مرة أخرى"><div class="actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="primary" id="saveOneSignalKey">حفظ المفتاح</button><button class="secondary" id="testOneSignalKey">اختبار الاتصال</button></div><p class="muted">المفتاح يُشفّر على الخادم ولا يُرسل إلى المتصفح عند قراءته. اترك الحقل فارغًا إذا كنت لا تريد تغيير المفتاح المحفوظ.</p><p id="oneSignalKeyStatus" class="muted" aria-live="polite"></p></div>
  <div class="card"><h3>📣 إشعار جماعي للعملاء</h3><label>عنوان الإشعار</label><input id="broadcastTitle" maxlength="80" placeholder="عرض جديد من يوسف أوردرز"><label>نص الإشعار</label><textarea id="broadcastMessage" rows="3" maxlength="240" placeholder="اكتب رسالتك للعملاء..."></textarea><button class="primary" id="sendBroadcast">إرسال Push لكل العملاء</button><p class="muted">يتم الإرسال من خادم آمن، ولا يتم كشف مفتاح OneSignal داخل المتصفح.</p></div>`
}



// Leaflet + Leaflet.draw are loaded only on the admin delivery-zone screen.
async function loadDeliveryMapLibraries() {
  const addCss = href => { if (!document.querySelector(`link[href="${href}"]`)) { const link=document.createElement('link'); link.rel='stylesheet'; link.href=href; document.head.appendChild(link); } };
  const addScript = (src, test) => new Promise((resolve,reject) => {
    if (test()) return resolve();
    const existing=[...document.scripts].find(x=>x.src===src);
    if(existing){existing.addEventListener('load',resolve,{once:true});existing.addEventListener('error',reject,{once:true});return;}
    const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>reject(new Error('تعذر تحميل مكتبة الخريطة'));document.head.appendChild(script);
  });
  addCss('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
  addCss('https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css');
  await addScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',()=>!!window.L);
  await addScript('https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js',()=>!!window.L?.Control?.Draw);
}

async function initDeliveryZoneEditor() {
  const mapEl=document.querySelector('#deliveryZoneMap');
  if(!mapEl || mapEl.dataset.ready==='true')return;
  const statusEl=document.querySelector('#deliveryZoneStatus');
  try {
    await loadDeliveryMapLibraries();
    if(!document.body.contains(mapEl))return;
    deliveryZoneMap=window.L.map(mapEl).setView([30.12,31.24],12);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(deliveryZoneMap);
    deliveryZoneLayers=new window.L.FeatureGroup().addTo(deliveryZoneMap);
    const drawControl=new window.L.Control.Draw({draw:{polyline:false,rectangle:false,circle:false,circlemarker:false,marker:false,polygon:{allowIntersection:false,showArea:true}},edit:{featureGroup:deliveryZoneLayers,edit:true,remove:true}});
    deliveryZoneMap.addControl(drawControl);
    adminDeliveryZones.forEach(zone=>{
      const geometry=zone.polygon?.type==='Feature'?zone.polygon.geometry:zone.polygon;
      if(!geometry)return;
      let layer;
      if(geometry.type==='Polygon' && Array.isArray(geometry.coordinates)) {
        const latlngs=geometry.coordinates[0].map(pair=>[Number(pair[1]),Number(pair[0])]);
        if(latlngs.length<4)return;
        layer=window.L.polygon(latlngs,{color:zone.active===false?'#9ca3af':'#0e7490'});
      } else if(String(geometry.type||'').toLowerCase()==='circle') {
        const center=geometry.center||{};
        const lat=Number(Array.isArray(center)?center[0]:(center.latitude??center.lat));
        const lng=Number(Array.isArray(center)?center[1]:(center.longitude??center.lng));
        const radius=Number(geometry.radius_m??geometry.radius);
        if(!Number.isFinite(lat)||!Number.isFinite(lng)||!Number.isFinite(radius)||radius<=0)return;
        layer=window.L.circle([lat,lng],{radius,color:zone.active===false?'#9ca3af':'#0e7490'});
      } else return;
      layer.feature={type:'Feature',properties:{zoneId:zone.id}};
      layer.bindPopup(`<b>${esc(zone.name||'منطقة توصيل')}</b><br>${money(zone.delivery_fee)} · الحد الأدنى ${money(zone.min_order)}`);
      deliveryZoneLayers.addLayer(layer);
    });
    deliveryZoneMap.on(window.L.Draw.Event.CREATED,async event=>{
      const layer=event.layer;
      const name=document.querySelector('#deliveryZoneName')?.value.trim();
      const delivery_fee=Number(document.querySelector('#deliveryZoneFee')?.value||0);
      const min_order=Number(document.querySelector('#deliveryZoneMin')?.value||0);
      if(!name || !Number.isFinite(delivery_fee)||delivery_fee<0||!Number.isFinite(min_order)||min_order<0){toast('اكتب اسم المنطقة ورسوم وحد أدنى صحيحين قبل الحفظ','error');return;}
      const polygon=layer.toGeoJSON().geometry;
      const {data,error}=await supabase.from('delivery_zones').insert({name,delivery_fee,min_order,polygon,active:true}).select().single();
      if(error){toast('تعذر حفظ المنطقة: '+error.message,'error');return;}
      layer.feature={type:'Feature',properties:{zoneId:data.id}};layer.bindPopup(`<b>${esc(name)}</b><br>${money(delivery_fee)}`);deliveryZoneLayers.addLayer(layer);
      adminDeliveryZones.push(data);renderDeliveryZoneList();toast('تم حفظ منطقة التوصيل','success');
    });
    deliveryZoneMap.on(window.L.Draw.Event.EDITED,async event=>{
      const updates=[];
      event.layers.eachLayer(layer=>{const id=layer.feature?.properties?.zoneId;if(id)updates.push(supabase.from('delivery_zones').update({polygon:layer.toGeoJSON().geometry}).eq('id',id));});
      const results=await Promise.all(updates);const failed=results.find(x=>x.error);
      if(failed)toast('تعذر حفظ تعديل أحد حدود المناطق: '+failed.error.message,'error');else toast('تم حفظ تعديلات حدود المناطق','success');
    });
    deliveryZoneMap.on(window.L.Draw.Event.DELETED,async event=>{
      const ids=[];event.layers.eachLayer(layer=>{const id=layer.feature?.properties?.zoneId;if(id)ids.push(id);});
      if(!ids.length)return;
      const {error}=await supabase.from('delivery_zones').delete().in('id',ids);
      if(error){toast('تعذر حذف المناطق: '+error.message,'error');await render();return;}
      adminDeliveryZones=adminDeliveryZones.filter(z=>!ids.includes(z.id));renderDeliveryZoneList();toast('تم حذف المناطق المحددة','success');
    });
    mapEl.dataset.ready='true';
    renderDeliveryZoneList();
    setTimeout(()=>deliveryZoneMap?.invalidateSize(),150);
    if(statusEl)statusEl.textContent='ارسم مضلعاً من أداة المضلع أعلى الخريطة. استخدم أدوات التعديل والحذف لحفظ التغييرات.';
  } catch(error) { if(statusEl)statusEl.textContent='تعذر تشغيل الخريطة: '+error.message; console.error(error); }
}

function renderDeliveryZoneList() {
  const el=document.querySelector('#deliveryZoneList');if(!el)return;
  el.innerHTML=adminDeliveryZones.map(z=>`<div class="delivery-zone-row"><div><b>${esc(z.name||'منطقة بدون اسم')}</b><small>${money(z.delivery_fee)} توصيل · حد أدنى ${money(z.min_order)} · ${z.active?'مفعّلة':'موقوفة'}</small></div><button type="button" class="secondary small" data-zone-toggle="${z.id}">${z.active?'إيقاف':'تفعيل'}</button></div>`).join('')||'<p class="muted">لا توجد مناطق محفوظة حتى الآن.</p>';
  el.querySelectorAll('[data-zone-toggle]').forEach(btn=>btn.onclick=async()=>{const zone=adminDeliveryZones.find(z=>z.id===btn.dataset.zoneToggle);if(!zone)return;const {error}=await supabase.from('delivery_zones').update({active:!zone.active}).eq('id',zone.id);if(error)return toast(error.message,'error');zone.active=!zone.active;toast(zone.active?'تم تفعيل المنطقة':'تم إيقاف المنطقة','success');await render();});
}

function wireAdminEvents() {
  document.querySelectorAll('[data-review-visibility]').forEach(b=>b.onclick=async()=>{const next=b.dataset.visible!=='true';const {error}=await supabase.from('product_reviews').update({is_visible:next}).eq('id',b.dataset.reviewVisibility);if(error)return toast(error.message,'error');toast(next?'تم نشر التقييم':'تم إخفاء التقييم','success');await render()})
    document.querySelector('#productForm')?.addEventListener('submit',addProduct)
  document.querySelector('#saveSpinSettings')?.addEventListener('click', saveSpinSettings)
  document.querySelector('#walletAdminForm')?.addEventListener('submit', adjustCustomerWallet)
  document.querySelector('#spinNow')?.addEventListener('click', spinTheWheel)
  document.querySelector('#categoryForm')?.addEventListener('submit',addCategory)
  document.querySelectorAll('[data-update-product]').forEach(b=>b.onclick=()=>updateProduct(b.dataset.updateProduct))
  document.querySelectorAll('[data-toggle-product]').forEach(b=>b.onclick=()=>toggleProduct(b.dataset.toggleProduct))
  document.querySelectorAll('[data-delete-product]').forEach(b=>b.onclick=()=>deleteProduct(b.dataset.deleteProduct))
  document.querySelectorAll('[data-save-order]').forEach(b=>b.onclick=()=>saveOrder(b.dataset.saveOrder))
  document.querySelectorAll('[data-delete-order]').forEach(b=>b.onclick=()=>deleteOrder(b.dataset.deleteOrder))
  document.querySelector('#adminSearch')?.addEventListener('input',filterAdminOrders)
  document.querySelector('#statusFilter')?.addEventListener('change',filterAdminOrders)
  document.querySelector('#saveSettings')?.addEventListener('click',saveSettings)
  document.querySelector('#sendBroadcast')?.addEventListener('click',sendBroadcast)
  document.querySelector('#saveOneSignalKey')?.addEventListener('click',saveOneSignalKey)
  document.querySelector('#testOneSignalKey')?.addEventListener('click',testOneSignalKey)
  if (document.querySelector('#deliveryZoneMap')) initDeliveryZoneEditor()
  document.querySelectorAll('[data-receipt]').forEach(b=>b.onclick=()=>viewReceipt(b.dataset.receipt))
  document.querySelectorAll('[data-review-receipt]').forEach(b=>b.onclick=()=>reviewReceipt(b.dataset.reviewReceipt,b.dataset.reviewStatus))
  
  document.querySelector('#quickToggleStore')?.addEventListener('click', async () => {
    const current = getSetting('store_status', 'open');
    const nextStatus = current === 'open' ? 'closed' : 'open';
    await supabase.from('settings').upsert({key: 'store_status', value: nextStatus});
    toast(nextStatus === 'open' ? 'تم فتح المتجر' : 'تم إغلاق المتجر', 'success');
    await loadCommon(); render();
  });
}

async function deleteOrder(id) {
  if(!confirm('متأكد من الحذف؟')) return;
  await supabase.from('orders').update({ status: 'deleted', updated_at: new Date().toISOString() }).eq('id', id);
  toast('تم الحذف', 'success'); await render();
}

function filterAdminOrders() {
  const q=document.querySelector('#adminSearch')?.value.toLowerCase()||'', st=document.querySelector('#statusFilter')?.value||''
  document.querySelectorAll('.admin-order').forEach(x=>{
    const o=orders.find(z=>z.id===x.querySelector('[data-save-order]')?.dataset.saveOrder)
    const okQ=!q||x.dataset.search.includes(q), okS=!st||o?.status===st
    x.style.display=okQ&&okS?'':'none'
  })
}

async function addCategory(e) {
  e.preventDefault()
  const name=document.querySelector('#categoryName').value.trim()
  const icon=document.querySelector('#categoryIcon').value.trim() || '📦'
  if(!name) return
  const {error}=await supabase.from('categories').insert({name,icon,active:true,sort_order:categories.length+1})
  if(error) return toast(error.message,'error')
  toast('تمت إضافة القسم','success'); await render()
}

async function addProduct(e) {
  e.preventDefault()
  const name=document.querySelector('#pName').value.trim(), unit_price=Number(document.querySelector('#pPrice').value||0), unit=document.querySelector('#pUnit').value.trim(), category_id=document.querySelector('#pCategory')?.value||null
  let options=[];try{const raw=document.querySelector('#pOptions')?.value.trim();options=raw?JSON.parse(raw):[];if(!Array.isArray(options))throw new Error('يجب أن تكون الخيارات مصفوفة JSON')}catch(err){return toast('صيغة خيارات المنتج غير صحيحة: '+err.message,'error')}
  let image_url=null; const file=document.querySelector('#pImage').files?.[0]
  if (file) {
    const path=`${crypto.randomUUID()}-${file.name.replace(/[^\w.\-]+/g,'_')}`
    const up=await supabase.storage.from('products').upload(path,file);
    if (up.error) return toast('فشل رفع صورة المنتج: '+up.error.message,'error')
    image_url=supabase.storage.from('products').getPublicUrl(path).data.publicUrl
  }
  const {error:insertError}=await supabase.from('products').insert({name,unit_price,unit,category_id,options,image_url,active:true})
  if(insertError) return toast(insertError.message,'error')
  toast('تمت الإضافة','success'); await render()
}

async function updateProduct(id) {
  const name=document.querySelector(`.editName[data-id="${id}"]`).value.trim(), unit_price=Number(document.querySelector(`.editPrice[data-id="${id}"]`).value||0), unit=document.querySelector(`.editUnit[data-id="${id}"]`).value.trim(), file=document.querySelector(`.editImage[data-id="${id}"]`)?.files?.[0]
  const flash=document.querySelector(`.editFlash[data-id="${id}"]`)?.checked||false
  const salePriceRaw=document.querySelector(`.editSalePrice[data-id="${id}"]`)?.value
  const saleStartRaw=document.querySelector(`.editSaleStart[data-id="${id}"]`)?.value
  const saleEndRaw=document.querySelector(`.editSaleEnd[data-id="${id}"]`)?.value
  const sale_price=salePriceRaw===''?null:Number(salePriceRaw)
  const sale_starts_at=saleStartRaw?new Date(saleStartRaw).toISOString():null
  const sale_ends_at=saleEndRaw?new Date(saleEndRaw).toISOString():null
  if(flash && (!Number.isFinite(sale_price)||sale_price<=0||sale_price>=unit_price||!sale_ends_at||(sale_starts_at&&new Date(sale_ends_at)<=new Date(sale_starts_at)))) return toast('راجع سعر وموعد بداية ونهاية العرض','error')
  let options=[];try{options=JSON.parse(document.querySelector(`.editOptions[data-id="${id}"]`)?.value||'[]');if(!Array.isArray(options))throw new Error('يجب أن تكون مصفوفة JSON')}catch(err){return toast('صيغة خيارات المنتج غير صحيحة: '+err.message,'error')}
  const updateData = { name, unit_price, unit, options, is_flash_sale:flash, sale_price, sale_starts_at, sale_ends_at }
  if (file) {
    const path=`${crypto.randomUUID()}-${file.name.replace(/[^\w.\-]+/g,'_')}`
    const up=await supabase.storage.from('products').upload(path,file);
    if (up.error) return toast('فشل رفع صورة المنتج: '+up.error.message,'error')
    updateData.image_url = supabase.storage.from('products').getPublicUrl(path).data.publicUrl
  }
  await supabase.from('products').update(updateData).eq('id',id)
  toast('تم التعديل','success'); await render()
}

async function toggleProduct(id) {
  const p = products.find(x => x.id === id);
  await supabase.from('products').update({active:!p.active}).eq('id',id)
  toast('تم التحديث','success'); await render()
}

async function deleteProduct(id) {
  if(!confirm('متأكد من الحذف؟')) return;
  await supabase.from('products').delete().eq('id',id)
  toast('تم الحذف','success'); await render()
}

async function saveOrder(id) {
  const price=Number(document.querySelector(`.priceEdit[data-id="${id}"]`).value||0);
  const shipping=Number(document.querySelector(`.shippingEdit[data-id="${id}"]`).value||0);
  const tip=Number(document.querySelector(`.tipEdit[data-id="${id}"]`).value||0);
  const status=document.querySelector(`.statusEdit[data-id="${id}"]`).value;
  const o=orders.find(x=>x.id===id);
  if (!o) return;
  let result;
  if (status === 'cancelled') {
    if (!confirm(`تأكيد إلغاء الطلب #${o.order_no}؟ سيتم رد أي مبلغ مدفوع من المحفظة تلقائياً.`)) return;
    result = await supabase.rpc('admin_cancel_order', { p_order_id: id, p_note: 'تم إلغاء الطلب من الإدارة' });
  } else {
    result = await supabase.rpc('admin_save_order_pricing', {
      p_order_id: id, p_subtotal: price, p_shipping_fee: shipping, p_tip: tip, p_status: status
    });
  }
  if (result.error) return toast(result.error.message, 'error');
  await sendPushNotification('order_updated', o.id);
  toast(status === 'cancelled' ? 'تم إلغاء الطلب وتسوية المحفظة إن وُجدت' : 'تم حفظ التسعير أو تحديث حالة الطلب', 'success');
  beep();
  await render();
}
async function viewReceipt(id) {
  const o=orders.find(x=>x.id===id)
  if(!o?.payment_proof_url)return
  let {data,error}=await supabase.storage.from('payment-proofs').createSignedUrl(o.payment_proof_url,600)
  // Legacy compatibility for receipts uploaded before the private bucket migration.
  if(error) {
    const legacy=await supabase.storage.from('receipts').createSignedUrl(o.payment_proof_url,600)
    data=legacy.data; error=legacy.error
  }
  if(error) return toast(error.message,'error')
  if(data?.signedUrl) window.open(data.signedUrl,'_blank')
}

async function reviewReceipt(orderId, status) {
  if (!isAdmin() || !['accepted','rejected'].includes(status)) return
  const o = orders.find(x => x.id === orderId)
  if (!o) return
  const label = status === 'accepted' ? 'قبول' : 'رفض'
  if (!confirm(`تأكيد ${label} إيصال الطلب #${o.order_no}؟`)) return
  const { data: receipt, error: findError } = await supabase.from('payment_receipts')
    .select('id').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (findError) return toast(findError.message, 'error')
  if (!receipt?.id) return toast('لا يوجد سجل إيصال مرتبط بالطلب. قد يكون الإيصال مرفوعاً بالنظام القديم.', 'error')
  const note = status === 'accepted' ? 'تم قبول إثبات الدفع من الإدارة' : 'تم رفض إثبات الدفع من الإدارة'
  const { error } = await supabase.rpc('review_payment_receipt', {
    p_receipt_id: receipt.id, p_status: status, p_review_note: note
  })
  if (error) return toast(error.message, 'error')
  toast(`تم ${label} الإيصال`, 'success')
  await render()
}

async function saveSettings() {
  let insta=getSetting('instapay_qr_url'), wallet=getSetting('wallet_qr_url')
  const uploadSetting=async(id,file,current)=>{
    if(!file)return current
    const path=`${id}/${crypto.randomUUID()}-${file.name.replace(/[^\w.\-]+/g,'_')}`
    const up=await supabase.storage.from('payment-assets').upload(path,file);
    if(up.error) throw up.error
    return supabase.storage.from('payment-assets').getPublicUrl(path).data.publicUrl
  }
  try {
    insta=await uploadSetting('instapay',document.querySelector('#instaQrFile').files?.[0],insta)
    wallet=await uploadSetting('wallet',document.querySelector('#walletQrFile').files?.[0],wallet)
    const wa=document.querySelector('#waNumber').value.trim()
    for (const [key,value] of [['instapay_qr_url',insta],['wallet_qr_url',wallet],['whatsapp_number',wa]]) { await supabase.from('settings').upsert({key,value: value || ''}) }
    toast('تم حفظ الإعدادات','success'); await render()
  } catch(e){toast(e.message,'error')}
}

async function saveOneSignalKey() {
  const input = document.querySelector('#oneSignalRestKey');
  const status = document.querySelector('#oneSignalKeyStatus');
  const key = input?.value.trim();
  if (!key) return toast('الصق REST API Key الجديد أولاً', 'error');
  const button = document.querySelector('#saveOneSignalKey');
  button.disabled = true; button.textContent = 'جاري الحفظ...';
  try { await callOneSignalApi({ action: 'save_key', rest_api_key: key }); input.value = ''; status.textContent = 'تم حفظ المفتاح بأمان. لن يظهر المفتاح المحفوظ في الموقع.'; toast('تم حفظ مفتاح OneSignal بأمان', 'success'); }
  catch (e) { status.textContent = e.message; toast(e.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'حفظ المفتاح'; }
}
async function testOneSignalKey() {
  const status = document.querySelector('#oneSignalKeyStatus');
  const button = document.querySelector('#testOneSignalKey');
  button.disabled = true; button.textContent = 'جاري الاختبار...';
  try { await callOneSignalApi({ action: 'test' }); status.textContent = 'الاتصال ناجح — مفتاح OneSignal صالح.'; toast('اتصال OneSignal ناجح', 'success'); }
  catch (e) { status.textContent = e.message; toast(e.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'اختبار الاتصال'; }
}
async function sendBroadcast() {
  const title = document.querySelector('#broadcastTitle')?.value.trim()
  const message = document.querySelector('#broadcastMessage')?.value.trim()
  if (!title || !message) return toast('اكتب عنوان الإشعار ونص الرسالة', 'error')
  const btn = document.querySelector('#sendBroadcast')
  btn.disabled = true; btn.textContent = 'جاري الإرسال...'
  const result = await sendPushNotification('broadcast', null, title, message)
  btn.disabled = false; btn.textContent = 'إرسال Push لكل العملاء'
  if (result?.success) { toast('تم إرسال الإشعار الجماعي', 'success'); document.querySelector('#broadcastMessage').value = '' }
}

async function showNotifications() {
  const html=`<div class="modal-backdrop" id="nmodal"><div class="modal"><button class="close" id="nclose">×</button><h2>🔔 الإشعارات</h2>${notifications.map(n=>`<div class="notice ${n.read_at?'read':''}"><b>${esc(n.title)}</b><p style="margin:4px 0; font-size:14px;">${esc(n.body)}</p><small>${fmtDate(n.created_at)}</small></div>`).join('')||'<div class="empty">لا توجد إشعارات.</div>'}</div></div>`
  document.body.insertAdjacentHTML('beforeend',html)
  document.querySelector('#nmodal').addEventListener('click', e => { if(e.target.id==='nmodal') document.querySelector('#nmodal')?.remove() })
  document.querySelector('#nclose').onclick=async()=>{
    document.querySelector('#nmodal').remove();
    const { error } = await supabase.rpc('mark_my_notifications_read')
    if (error) return toast(error.message,'error')
    notifications=notifications.map(n=>({...n, read_at: n.read_at || new Date().toISOString()}));
    document.querySelector('.badge').textContent=''
  }
}

function toggleTheme() {
  document.documentElement.classList.toggle('dark')
  localStorage.setItem('yosif_theme',document.documentElement.classList.contains('dark')?'dark':'light')
}
if(localStorage.getItem('yosif_theme')==='dark') document.documentElement.classList.add('dark')

function subscribeRealtime() {
  if (!supabase || realtimeChannels.length) return
  const channel=supabase.channel('yosif-live')
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'orders'},async()=>{ if (isAdmin()) adminBeep(); await render() })
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'orders'},async()=>{ await render() })
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'notifications',filter:`user_id=eq.${session.user.id}`},async()=>{ if (!isAdmin()) beep(); await render() })
    .subscribe()
  realtimeChannels=[channel]
}

init()