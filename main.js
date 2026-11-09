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
let settings = {}
let orders = []
let notifications = []
let currentOrder = null
let authMode = 'login'
let adminView = 'dashboard'
let customerView = 'home'
let realtimeChannels = []
let activeCategory = 'الكل'
let productSearch = ''
let saleCountdownTimer = null
let favorites = new Set(JSON.parse(localStorage.getItem('yosif_favorites') || '[]'))

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

  const [p, c, s, n] = await Promise.all([
    pQuery,
    supabase.from('categories').select('*').order('sort_order', { ascending: true }),
    supabase.from('settings').select('*'),
    supabase.from('notifications').select('*').eq('user_id', session.user.id).order('created_at', {ascending:false}).limit(50)
  ])
  if (p.error) throw p.error
  if (c.error) throw c.error
  categories = c.data || []
  if (s.data) settings = Object.fromEntries(s.data.filter(x => x.key !== 'onesignal_rest_api_key_encrypted').map(x => [x.key, x]))
  if (n.error) throw n.error
  products = p.data || []
  notifications = n.data || []
  
  if (isAdmin()) {
    const o = await supabase.from('orders').select('*').order('created_at',{ascending:false})
    if (o.error) throw o.error
    orders = (o.data || []).filter(x => x.status !== 'deleted')
  } else {
    const o = await supabase.from('orders').select('*').eq('customer_id',session.user.id).order('created_at',{ascending:false})
    if (o.error) throw o.error
    orders = (o.data || []).filter(x => x.status !== 'deleted')
  }
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
  </div>`
  
  document.querySelector('#logoutBtn').onclick=logout
  document.querySelector('#notifBtn').onclick=showNotifications
  document.querySelector('#themeBtn').onclick=toggleTheme
  
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
  shell('Yosif Orders', [
    navBtn('home','🏠 الرئيسية',customerView==='home'),
    navBtn('products','🛍 المنتجات',customerView==='products'),
    navBtn('new','➕ طلب جديد',customerView==='new'),
    navBtn('orders','📦 طلباتي',customerView==='orders')
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
function toggleFavorite(id) {
  favorites.has(id) ? favorites.delete(id) : favorites.add(id)
  localStorage.setItem('yosif_favorites', JSON.stringify([...favorites]))
  renderCustomer()
}
function customerProducts() {
  const isClosed = getSetting('store_status', 'open') === 'closed';
  const categoryTabs = [{id:'الكل',name:'الكل',icon:'🛍️'}, ...categories.filter(c=>c.active || isAdmin()).map(c=>({id:c.id,name:c.name,icon:c.icon||'📦'}))]
  const visible = products.filter(p => (activeCategory==='الكل' || p.category_id===activeCategory) && fuzzyMatch(`${p.name} ${p.unit||''} ${categoryName(p.category_id)}`, productSearch))
  return `<div class="section-head"><h3>المنتجات</h3><span class="muted">${visible.length} منتج</span></div>
  <div class="product-tools"><input id="productSearch" type="search" value="${esc(productSearch)}" placeholder="ابحث عن منتج... مثال: لبن، جبنه، سكر"><div class="category-tabs">${categoryTabs.map(c=>`<button class="category-tab ${activeCategory===c.id?'active':''}" data-category="${esc(c.id)}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}</div></div>
  <div class="product-grid">${visible.map(p=>{const now=Date.now(),starts=p.sale_starts_at?new Date(p.sale_starts_at).getTime():0,ends=p.sale_ends_at?new Date(p.sale_ends_at).getTime():Infinity;const sale=!!p.is_flash_sale&&p.sale_price!==null&&p.sale_price!==undefined&&now>=starts&&now<ends;return `<div class="product-card">
    ${p.image_url?`<img src="${esc(p.image_url)}" alt="">`:`<div class="product-placeholder">🛍️</div>`}
    <div class="pbody"><button class="favorite-btn ${favorites.has(p.id)?'is-favorite':''}" data-favorite="${p.id}" aria-label="إضافة للمفضلة">${favorites.has(p.id)?'♥':'♡'}</button><h3>${esc(p.name)}</h3><div class="muted">${sale?`<span style="text-decoration:line-through;opacity:.65">${money(p.unit_price)}</span> <b style="color:#dc2626">${money(p.sale_price)}</b>`:`${money(p.unit_price)}`} /${esc(p.unit)}</div>
    ${sale?`<small class="flash-countdown" data-sale-end="${esc(p.sale_ends_at||'')}">⏳ عرض لفترة محدودة</small>`:''}
    <button class="${isClosed ? 'secondary' : 'primary'} small" data-product="${p.id}" ${isClosed ? 'disabled' : ''}>${isClosed ? 'مغلق' : 'أضف للطلب'}</button></div>
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
    <div class="grid2">
      <div><label>اسم صاحب الطلب</label><input id="oName" required value="${esc(prefill.name||'')}"></div>
      <div><label>رقم الواتساب</label><input id="oPhone" type="tel" required placeholder="01xxxxxxxxx"></div>
    </div>
    
    <label>العنوان بالتفصيل</label>
    <div style="display:flex; gap:8px;">
      <input id="oAddress" required placeholder="المنطقة، الشارع، الشقة..." style="flex:1;">
      <button type="button" id="getLocBtn" class="secondary" title="سحب موقعي تلقائياً" style="padding: 12px; border-radius: 12px; background: #e0e7ff; color: #3730a3;">📍</button>
    </div>

    <label>اسم الطلب (أو المنتج)</label><input id="oTitle" required value="${esc(prefill.title||'')}">
    
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

function orderCard(o) {
  const needsPayment = (o.status !== 'pending_review') && (o.payment_method === 'instapay' || o.payment_method === 'wallet') && !o.payment_proof_url;
  let priceDisplay = '';
  if (o.status === 'pending_review') {
    priceDisplay = '<div class="muted" style="font-size:0.9em; margin-top:5px;">في انتظار تحديد التكلفة والتوصيل</div>';
  } else {
    priceDisplay = `
      <div style="font-size:0.9em; margin-top:8px; line-height:1.6; background:var(--surface-1); padding:8px; border-radius:6px;">
        <div>الطلبات: <b>${money(o.subtotal)}</b></div>
        <div>التوصيل: <b>${money(o.shipping_fee)}</b></div>
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

  const pStatus = o.payment_method === 'cash' ? '' : (o.payment_proof_url ? 'تم الرفع ✔️' : 'في انتظار التحويل');
  
  return `<article class="order-card" data-order-card="${o.order_no}">
    <div class="row"><div><b>طلب #${esc(o.order_no)}</b><div class="muted">${fmtDate(o.created_at)}</div></div><span class="status ${statusClass(o.status)}">${statusLabel(o.status, o.payment_method)}</span></div>
    <h3>${esc(o.custom_request)}</h3><p>${renderNotes(o.customer_notes)}</p>
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
  document.querySelectorAll('[data-product]').forEach(b=>b.onclick=()=>{
    if(!isClosed){
      const p=products.find(x=>x.id===b.dataset.product)
      customerView='new'; setTimeout(()=>{document.querySelector('#oTitle').value=p.name;document.querySelector('#oDetails').value=`${p.name} - ${p.unit}`;},0); renderCustomer()
    }
  })
  document.querySelector('#orderForm')?.addEventListener('submit',submitOrder)
  document.querySelectorAll('[data-open-order]').forEach(b=>b.onclick=()=>openOrder(b.dataset.openOrder))
  document.querySelectorAll('[data-pay-order]').forEach(b=>b.onclick=()=>openPayModal(b.dataset.payOrder))
  
  document.querySelector('#orderSearch')?.addEventListener('input',e=>{
    const q=e.target.value.trim()
    document.querySelectorAll('[data-order-card]').forEach(x=>x.style.display=!q||x.dataset.orderCard.includes(q)?'':'none')
  })

  document.querySelector('#getLocBtn')?.addEventListener('click', () => {
    toast('جاري تحديد موقعك...', 'info');
    navigator.geolocation.getCurrentPosition(pos => {
      document.querySelector('#oAddress').value += ` | 📍 https://maps.google.com/?q=${pos.coords.latitude},${pos.coords.longitude}`;
      toast('تم إضافة موقعك على الخريطة بنجاح', 'success');
    }, () => toast('فشل تحديد الموقع، يرجى تفعيل الـ GPS', 'error'));
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
    p_custom_request: titleInput,
    p_customer_notes: finalNotes,
    p_attached_images: uploadedImages,
    p_payment_method: pay,
    p_tip: tip,
    p_items: [],
    p_scheduled_for: null,
    p_latitude: null,
    p_longitude: null
  })
  
  if (error) { toast(error.message, 'error'); btn.textContent = originalText; btn.disabled = false; return; }
  
  // Notifications are written by trusted server-side workflows; customer-side
  // INSERT is intentionally not allowed by the database RLS policy.
  
  // Notify administrators through the authenticated server-side API.
  await sendPushNotification('order_created', data.id);
  
  toast(`تم إرسال الطلب بنجاح`,'success'); beep(); 
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
  shell('لوحة الأدمن', [
    navBtn('dashboard','📊 الرئيسية',adminView==='dashboard'),
    navBtn('orders','📦 الطلبات',adminView==='orders'),
    navBtn('products','🛍️ المنتجات',adminView==='products'),
    navBtn('settings','⚙️ الإعدادات',adminView==='settings')
  ].join(''), content)
  wireNav(); wireAdminEvents()
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
    <h3>${esc(o.custom_request)}</h3><p>${renderNotes(o.customer_notes)}</p>
    ${o.phone ? `<div class="muted">📱 ${esc(o.phone)}</div>` : ''}
    ${imagesHtml}
    
    <div class="grid2" style="margin-top: 10px;">
      <label>سعر الطلبات<input type="number" class="priceEdit" data-id="${o.id}" value="${o.subtotal||0}"></label>
      <label>رسوم التوصيل<input type="number" class="shippingEdit" data-id="${o.id}" value="${o.shipping_fee||0}"></label>
    </div>
    <div class="grid2" style="margin-top: 8px;">
      <label>البقشيش<input type="number" class="tipEdit" data-id="${o.id}" value="${o.tip||0}"></label>
    </div>

    <div class="row" style="margin-top: 10px;"><span>الإجمالي: <b style="color:var(--primary);">${money(o.total)}</b></span></div>
    
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
  <div class="card"><h3>🔐 إعدادات OneSignal</h3><label>OneSignal App ID</label><input value="97987044-7348-4399-bb86-eb5c8d9fa799" readonly><label>REST API Key</label><input id="oneSignalRestKey" type="password" autocomplete="new-password" placeholder="الصق المفتاح هنا — لن يتم عرضه مرة أخرى"><div class="actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="primary" id="saveOneSignalKey">حفظ المفتاح</button><button class="secondary" id="testOneSignalKey">اختبار الاتصال</button></div><p class="muted">المفتاح يُشفّر على الخادم ولا يُرسل إلى المتصفح عند قراءته. اترك الحقل فارغًا إذا كنت لا تريد تغيير المفتاح المحفوظ.</p><p id="oneSignalKeyStatus" class="muted" aria-live="polite"></p></div>
  <div class="card"><h3>📣 إشعار جماعي للعملاء</h3><label>عنوان الإشعار</label><input id="broadcastTitle" maxlength="80" placeholder="عرض جديد من يوسف أوردرز"><label>نص الإشعار</label><textarea id="broadcastMessage" rows="3" maxlength="240" placeholder="اكتب رسالتك للعملاء..."></textarea><button class="primary" id="sendBroadcast">إرسال Push لكل العملاء</button><p class="muted">يتم الإرسال من خادم آمن، ولا يتم كشف مفتاح OneSignal داخل المتصفح.</p></div>`
}

function wireAdminEvents() {
  document.querySelector('#productForm')?.addEventListener('submit',addProduct)
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
  let image_url=null; const file=document.querySelector('#pImage').files?.[0]
  if (file) {
    const path=`${crypto.randomUUID()}-${file.name.replace(/[^\w.\-]+/g,'_')}`
    const up=await supabase.storage.from('products').upload(path,file);
    if (!up.error) image_url=supabase.storage.from('products').getPublicUrl(path).data.publicUrl
  }
  const {error:insertError}=await supabase.from('products').insert({name,unit_price,unit,category_id,image_url,active:true})
  if(insertError) return toast(insertError.message,'error')
  toast('تمت الإضافة','success'); await render()
}

async function updateProduct(id) {
  const name=document.querySelector(`.editName[data-id="${id}"]`).value.trim(), unit_price=Number(document.querySelector(`.editPrice[data-id="${id}"]`).value||0), unit=document.querySelector(`.editUnit[data-id="${id}"]`).value.trim(), file=document.querySelector(`.editImage[data-id="${id}"]`)?.files?.[0]
  const updateData = { name, unit_price, unit }
  if (file) {
    const path=`${crypto.randomUUID()}-${file.name.replace(/[^\w.\-]+/g,'_')}`
    const up=await supabase.storage.from('products').upload(path,file);
    if (!up.error) updateData.image_url = supabase.storage.from('products').getPublicUrl(path).data.publicUrl
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
  const price=Number(document.querySelector(`.priceEdit[data-id="${id}"]`).value||0), shipping=Number(document.querySelector(`.shippingEdit[data-id="${id}"]`).value||0), tip=Number(document.querySelector(`.tipEdit[data-id="${id}"]`).value||0), status=document.querySelector(`.statusEdit[data-id="${id}"]`).value, o=orders.find(x=>x.id===id)
  let fee = 0; if (o.payment_method === 'instapay') fee = 2; else if (o.payment_method === 'wallet') fee = (price + shipping) * 0.01; 
  const totalWithFees = price + shipping + tip + fee
  await supabase.from('orders').update({ subtotal: price, shipping_fee: shipping, tip: tip, payment_fee: fee, total: totalWithFees, status: status, updated_at: new Date().toISOString() }).eq('id',id)
  
  await supabase.from('order_events').insert({ order_id: id, status: status, note: `تحديث الحالة: ${statusLabel(status, o.payment_method)}` })
  await supabase.from('notifications').insert({ user_id: o.customer_id, order_id: o.id, type: 'order_updated', title: 'تحديث الطلب', body: `🔔 تم تحديث حالة طلب #${o.order_no} إلى: ${statusLabel(status, o.payment_method)}` })
  
  // إرسال إشعار للموبايل الخاص بالعميل لما الأدمن يغير حالته
  await sendPushNotification('order_updated', o.id);

  toast('تم الحفظ','success'); beep();
  await render()
}

async function viewReceipt(id) {
  const o=orders.find(x=>x.id===id)
  if(!o?.payment_proof_url)return
  const {data,error}=await supabase.storage.from('payment-proofs').createSignedUrl(o.payment_proof_url,600)
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
    await supabase.from('notifications').update({read_at: new Date().toISOString()}).eq('user_id',session.user.id).is('read_at', null);
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