'use strict';
/*
 * أنير — مساعد واتساب لمتجر onepower.ma
 * خادم واحد بدون أي مكتبات خارجية (يحتاج Node 20 أو أحدث).
 *
 * التدفق: واتساب (Cloud API) -> /webhook -> Claude (مع أدوات: كتالوج ووكومرس، شحن، طلبات، تحويل لموظف) -> رد على واتساب
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;

// ───────────────────────── إعدادات البيئة (.env) ─────────────────────────
function loadEnvFile(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

const env = process.env;
const CFG = {
  port: Number(env.PORT) || 3000,
  verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
  waToken: env.WHATSAPP_TOKEN || '',
  phoneId: env.WHATSAPP_PHONE_NUMBER_ID || '',
  appSecret: env.META_APP_SECRET || '',
  graphUrl: (env.GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, ''),
  graphVersion: env.GRAPH_VERSION || 'v23.0',
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicUrl: (env.ANTHROPIC_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  model: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  wcUrl: (env.WC_URL || '').replace(/\/$/, ''),
  wcKey: env.WC_CONSUMER_KEY || '',
  wcSecret: env.WC_CONSUMER_SECRET || '',
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  telegramChat: env.TELEGRAM_CHAT_ID || '',
  dataDir: env.DATA_DIR || path.join(ROOT, 'data'),
  configPath: env.CONFIG_PATH || path.join(ROOT, 'config.json'),
  maxMsgsPerHour: Number(env.MAX_MSGS_PER_HOUR) || 40,
  debounceMs: env.DEBOUNCE_MS !== undefined && env.DEBOUNCE_MS !== '' ? Number(env.DEBOUNCE_MS) : 2500,
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fatal(msg) {
  console.error('\n❌ ' + msg + '\n');
  process.exit(1);
}

const missing = [
  ['WHATSAPP_VERIFY_TOKEN', CFG.verifyToken], ['WHATSAPP_TOKEN', CFG.waToken],
  ['WHATSAPP_PHONE_NUMBER_ID', CFG.phoneId], ['META_APP_SECRET', CFG.appSecret],
  ['ANTHROPIC_API_KEY', CFG.anthropicKey], ['WC_URL', CFG.wcUrl],
  ['WC_CONSUMER_KEY', CFG.wcKey], ['WC_CONSUMER_SECRET', CFG.wcSecret],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) fatal('متغيرات ناقصة في ملف .env أو في إعدادات الاستضافة: ' + missing.join(', '));

// ───────────────────────── إعدادات المتجر (config.json) ─────────────────────────
let STORE;
try { STORE = JSON.parse(fs.readFileSync(CFG.configPath, 'utf8')); }
catch (e) { fatal('تعذّرت قراءة config.json (غالباً فاصلة أو علامة اقتباس ناقصة): ' + e.message); }

const S = STORE.store || {};
if (!/^\d{9,15}$/.test(String(S.handoff_whatsapp || ''))) {
  fatal('في config.json: القيمة store.handoff_whatsapp يجب أن تكون رقم المحل بالصيغة الدولية بدون + وبدون مسافات، مثال: 212612345678');
}
if (!STORE.shipping || !STORE.shipping.configured) log('⚠️ أسعار التوصيل غير مفعّلة (shipping.configured=false): أنير سيحوّل أسئلة التوصيل لموظف.');
if (!Array.isArray(STORE.payments) || !STORE.payments.some((p) => p.enabled)) fatal('في config.json: فعّل طريقة دفع واحدة على الأقل في payments.');

const CURRENCY = S.currency || 'MAD';
const TZ = S.timezone || 'Africa/Casablanca';

function buildSystemPrompt() {
  const tpl = fs.readFileSync(path.join(ROOT, 'anir-prompt.md'), 'utf8');
  const pays = (STORE.payments || []).filter((p) => p.enabled).map((p) => `- ${p.label} (المعرّف: ${p.id})`).join('\n');
  const notes = (S.notes || '').trim() || 'لا توجد معلومات إضافية مسجّلة. أي سؤال عن الإرجاع أو الاستبدال أو ساعات العمل أو العروض أو أي سياسة أخرى: حوّله لموظف ولا تخمّن.';
  return tpl
    .replaceAll('{{STORE_NAME}}', S.name || 'المتجر')
    .replaceAll('{{WEBSITE}}', S.website || '')
    .replaceAll('{{CURRENCY}}', CURRENCY)
    .replaceAll('{{PAYMENTS}}', pays)
    .replaceAll('{{STORE_NOTES}}', notes);
}
const SYSTEM_PROMPT = buildSystemPrompt();

// ───────────────────────── أدوات نصية ─────────────────────────
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[̀-ًͯ-ٰٟـ]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660));
const tokens = (s) => norm(s).match(/[\p{L}\p{N}]+/gu) || [];

function normPhone(p) {
  let d = String(p || '').replace(/[^\d+]/g, '');
  if (!d) return '';
  d = d.replace(/^\+/, '').replace(/^00/, '');
  if (/^0[5-7]\d{8}$/.test(d)) d = '212' + d.slice(1);
  return d.length >= 9 ? '+' + d : '';
}

// ───────────────────────── WooCommerce ─────────────────────────
async function wc(pathAndQuery, opts = {}) {
  const url = `${CFG.wcUrl}/wp-json/wc/v3${pathAndQuery}`;
  const auth = Buffer.from(`${CFG.wcKey}:${CFG.wcSecret}`).toString('base64');
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) throw new Error(`WooCommerce ${res.status}: ${(data && data.message) || text.slice(0, 200)}`);
  return data;
}

function slimProduct(p) {
  const cats = (p.categories || []).map((c) => c.name);
  const tags = (p.tags || []).map((t) => t.name);
  const short = stripHtml(p.short_description).slice(0, 300);
  return {
    id: p.id, name: stripHtml(p.name), sku: p.sku || '', type: p.type,
    price: p.price, regular_price: p.regular_price, sale_price: p.sale_price, on_sale: !!p.on_sale,
    stock_status: p.stock_status, categories: cats, tags, short_description: short, url: p.permalink,
    _name: norm(p.name), _sku: norm(p.sku), _cats: norm(cats.concat(tags).join(' ')), _short: norm(short),
  };
}
const publicProduct = (it) => Object.fromEntries(Object.entries(it).filter(([k]) => !k.startsWith('_')));

let catalog = { items: [], loadedAt: 0 };
async function loadCatalog() {
  if (catalog.items.length && Date.now() - catalog.loadedAt < 10 * 60 * 1000) return catalog.items;
  try {
    const items = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await wc(`/products?per_page=100&page=${page}&status=publish`);
      if (!Array.isArray(batch) || !batch.length) break;
      for (const p of batch) items.push(slimProduct(p));
      if (batch.length < 100) break;
    }
    catalog = { items, loadedAt: Date.now() };
    log(`الكتالوج: ${items.length} منتج`);
  } catch (e) {
    log('تعذّر تحديث الكتالوج:', e.message);
    if (!catalog.items.length) throw e;
  }
  return catalog.items;
}

function searchCatalog(items, query, limit) {
  const toks = tokens(query);
  if (!toks.length) return [];
  const scored = [];
  for (const it of items) {
    let score = 0, matched = 0;
    for (const t of toks) {
      let ts = 0;
      if (it._name.includes(t) || it._sku.includes(t)) ts = 3;
      else if (it._cats.includes(t)) ts = 2;
      else if (it._short.includes(t)) ts = 1;
      if (ts) matched++;
      score += ts;
    }
    if (matched) scored.push([score + (matched === toks.length ? 5 : 0), it]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([, it]) => publicProduct(it));
}

async function toolSearchProducts({ query, limit }) {
  const items = await loadCatalog();
  const results = searchCatalog(items, query, Math.min(Math.max(Number(limit) || 6, 1), 10));
  return results.length ? { results } : { results: [], note: 'لا نتائج. جرّب كلمات أخرى (اسم العلامة أو نوع المنتج) أو بلغة أخرى (فرنسية/إنجليزية). إن لم يوجد المنتج فقل للعميل إنه غير متوفر في الكتالوج.' };
}

async function toolListCategories() {
  const items = await loadCatalog();
  const counts = {};
  for (const it of items) for (const c of it.categories) counts[c] = (counts[c] || 0) + 1;
  return { categories: Object.entries(counts).map(([name, count]) => ({ name, products: count })) };
}

async function toolGetProduct({ product_id }) {
  const id = Math.floor(Number(product_id));
  if (!id) return { error: 'product_id غير صالح' };
  const p = await wc(`/products/${id}`);
  if (p.status !== 'publish') return { error: 'المنتج غير موجود' };
  const out = {
    ...publicProduct(slimProduct(p)),
    description: stripHtml(p.description).slice(0, 3500),
    short_description: stripHtml(p.short_description).slice(0, 800),
    attributes: (p.attributes || []).map((a) => ({ name: a.name, options: a.options })),
    stock_quantity: p.manage_stock ? p.stock_quantity : null,
  };
  if (p.type === 'variable') {
    const vs = await wc(`/products/${id}/variations?per_page=50`);
    out.variations = vs.map((v) => ({
      variation_id: v.id, options: (v.attributes || []).map((a) => `${a.name}: ${a.option}`),
      price: v.price, stock_status: v.stock_status, sku: v.sku,
    }));
  }
  return out;
}

// ───────────────────────── قاعدة المعرفة المحلية (knowledge/*.md) ─────────────────────────
function loadKnowledge() {
  const dir = path.join(ROOT, 'knowledge');
  const chunks = [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return chunks; }
  for (const f of files) {
    if (!f.endsWith('.md') || f.startsWith('_') || f.toLowerCase() === 'readme.md') continue;
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    const title = (txt.match(/^#\s+(.+)$/m) || [, f])[1].trim();
    const source = (txt.match(/^(?:المصدر|Source)\s*[:：]\s*(.+)$/im) || [, ''])[1].trim();
    for (const part of txt.split(/\n\s*\n/)) {
      const t = part.trim();
      if (t.length < 40 || /^#\s/.test(t) && t.split('\n').length === 1) continue;
      chunks.push({ title, source, text: t.slice(0, 1500), _n: norm(t) });
    }
  }
  return chunks;
}
const KNOWLEDGE = loadKnowledge();
log(`قاعدة المعرفة: ${KNOWLEDGE.length} فقرة`);

function toolSearchKnowledge({ query }) {
  const toks = tokens(query);
  const scored = [];
  for (const c of KNOWLEDGE) {
    let s = 0;
    for (const t of toks) if (c._n.includes(t)) s++;
    if (s) scored.push([s, c]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const top = scored.slice(0, 3).map(([, c]) => ({ title: c.title, source: c.source, text: c.text }));
  return top.length ? { results: top } : { results: [], note: 'لا توجد ملاحظات مرجعية موثّقة لهذا السؤال في قاعدة المتجر. لا تُدلِ بمعلومة علمية غير مؤكدة؛ قل ذلك بصراحة واعرض التحويل لموظف أو طبيب/صيدلي.' };
}

// ───────────────────────── الشحن ─────────────────────────
function computeShipping(city, subtotal) {
  const sh = STORE.shipping || {};
  if (!sh.configured) return { error: 'shipping_not_configured: أسعار التوصيل غير مسجّلة. حوّل العميل لموظف لمعرفة السعر.' };
  const c = norm(city).trim();
  if (!c) return { error: 'city_required: اسأل العميل عن مدينته.' };
  let zone = (sh.zones || []).find((z) => (z.cities || []).some((x) => { const n = norm(x).trim(); return n && (c.includes(n) || n.includes(c)); }));
  const isDefault = !zone;
  zone = zone || sh.default_zone;
  if (!zone) return { error: 'no_zone: لا توجد منطقة توصيل لهذه المدينة. حوّل العميل لموظف.' };
  const base = Number(zone.price) || 0;
  const free = zone.free_over != null && subtotal != null && subtotal >= Number(zone.free_over);
  return {
    price: free ? 0 : base, base_price: base, currency: CURRENCY,
    free_shipping_applied: free, free_over: zone.free_over ?? null,
    delivery_time: zone.delivery_time || null, is_default_zone: isDefault,
  };
}
const toolGetShipping = ({ city, order_subtotal }) => computeShipping(city, order_subtotal == null ? null : Number(order_subtotal));

// ───────────────────────── قنوات التنبيه للموظفين ─────────────────────────
async function notifyStaff(text) {
  let ok = false;
  const jobs = [];
  for (const n of S.staff_notify_numbers || []) {
    if (/^\d{9,15}$/.test(String(n))) jobs.push(waSend(String(n), text).then(() => { ok = true; }).catch((e) => log('تنبيه واتساب للموظف فشل:', n, e.message)));
  }
  if (CFG.telegramToken && CFG.telegramChat) {
    jobs.push(fetch(`https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CFG.telegramChat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    }).then(async (r) => { if (r.ok) ok = true; else log('تيليجرام فشل:', r.status); }).catch((e) => log('تيليجرام فشل:', e.message)));
  }
  await Promise.all(jobs);
  return ok;
}

async function toolHandoff({ reason, summary }, ctx) {
  const prefill = `مرحباً، تحدثت مع أنير على واتساب وأحتاج مساعدة من فريق ${S.name || ''}.`;
  const link = `https://wa.me/${S.handoff_whatsapp}?text=${encodeURIComponent(prefill)}`;
  const recent = ctx.conv.messages.slice(-8).map((m) => `${m.role === 'user' ? '👤' : '🤖'} ${String(m.content).replace(/\s+/g, ' ').slice(0, 220)}`);
  if (ctx.currentText) recent.push(`👤 ${ctx.currentText.replace(/\s+/g, ' ').slice(0, 220)}`);
  const text = [
    `🔔 عميل يحتاج موظفاً — ${S.name || ''}`,
    `الاسم في واتساب: ${ctx.profileName || 'غير معروف'}`,
    `الرقم: +${ctx.waId}`,
    `فتح محادثة: https://wa.me/${ctx.waId}`,
    `السبب: ${String(reason || '').slice(0, 300)}`,
    `الملخص: ${String(summary || '').slice(0, 800)}`,
    '', 'آخر الرسائل:', ...recent,
  ].join('\n');
  const staffNotified = await notifyStaff(text);
  ctx.conv.handoffAt = Date.now();
  return {
    ok: true, customer_link: link, staff_notified: staffNotified,
    note: 'أعطِ العميل الرابط وأخبره أن الفريق سيتواصل معه. لا تَعِد بوقت محدد للرد.',
  };
}

// ───────────────────────── إنشاء الطلب ─────────────────────────
async function toolCreateOrder(input, ctx) {
  if (input.confirmed_by_customer !== true) return { error: 'لم يؤكد العميل الطلب بعد. لخّص الطلب كاملاً واطلب منه تأكيداً صريحاً (نعم) قبل الإنشاء.' };
  const c = input.customer || {};
  for (const f of ['name', 'city', 'address']) if (!String(c[f] || '').trim()) return { error: `معلومة ناقصة: ${f}. اسأل العميل عنها.` };
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) return { error: 'لا توجد منتجات في الطلب.' };
  if (items.length > 10) return { error: 'عدد المنتجات كبير؛ حوّل العميل لموظف.' };
  const enabled = (STORE.payments || []).filter((p) => p.enabled);
  const pm = enabled.find((p) => p.id === input.payment_method);
  if (!pm) return { error: 'طريقة الدفع غير متاحة.', available: enabled.map((p) => ({ id: p.id, label: p.label })) };

  const key = crypto.createHash('sha1').update(JSON.stringify([ctx.waId, items, c.name, c.city, c.address, pm.id])).digest('hex');
  const prev = ctx.conv.lastOrder;
  if (prev && prev.key === key && Date.now() - prev.at < 10 * 60 * 1000) return { ...prev.result, duplicate: true, note: 'هذا الطلب أُنشئ قبل لحظات؛ لا تنشئه مرة ثانية.' };

  let subtotal = 0;
  const line_items = [];
  const summary = [];
  for (const it of items) {
    const qty = Math.floor(Number(it.quantity));
    if (!(qty >= 1 && qty <= 20)) return { error: 'الكمية يجب أن تكون بين 1 و20. للكميات الأكبر حوّل العميل لموظف.' };
    const pid = Math.floor(Number(it.product_id));
    const vid = it.variation_id ? Math.floor(Number(it.variation_id)) : 0;
    if (!pid) return { error: 'product_id غير صالح.' };
    const p = await wc(`/products/${pid}`);
    if (p.status !== 'publish') return { error: `المنتج رقم ${pid} غير متاح.` };
    let unit = p; let name = stripHtml(p.name);
    if (p.type === 'variable') {
      if (!vid) return { error: `المنتج «${name}» له خيارات. اسأل العميل عن الخيار ثم مرّر variation_id.` };
      unit = await wc(`/products/${pid}/variations/${vid}`);
      name += ` (${(unit.attributes || []).map((a) => a.option).join('، ')})`;
    }
    if (unit.stock_status === 'outofstock') return { error: `«${name}» غير متوفر حالياً.` };
    if (unit.manage_stock && unit.backorders === 'no' && unit.stock_quantity != null && unit.stock_quantity < qty) return { error: `المتوفر من «${name}» هو ${unit.stock_quantity} فقط.` };
    const price = Number(unit.price);
    if (!Number.isFinite(price)) return { error: `تعذّر تحديد سعر «${name}». حوّل العميل لموظف.` };
    subtotal += price * qty;
    line_items.push({ product_id: pid, ...(vid ? { variation_id: vid } : {}), quantity: qty });
    summary.push({ name, quantity: qty, unit_price: price });
  }

  const ship = computeShipping(c.city, subtotal);
  if (ship.error) return { error: ship.error };
  const phone = normPhone(c.phone) || normPhone(ctx.waId);
  const [first, ...rest] = String(c.name).trim().split(/\s+/);
  const addr = { first_name: first, last_name: rest.join(' '), address_1: String(c.address).trim(), city: String(c.city).trim(), country: S.country || 'MA' };

  const order = await wc('/orders', {
    method: 'POST',
    body: {
      status: pm.order_status || 'on-hold',
      payment_method: pm.wc_method || pm.id,
      payment_method_title: pm.label,
      set_paid: false,
      billing: { ...addr, phone },
      shipping: addr,
      line_items,
      shipping_lines: [{ method_id: 'flat_rate', method_title: 'التوصيل', total: ship.price.toFixed(2) }],
      customer_note: String(input.note || '').slice(0, 500),
      meta_data: [{ key: '_source', value: 'whatsapp-anir' }, { key: '_whatsapp_number', value: `+${ctx.waId}` }],
    },
  });

  const result = {
    ok: true, order_number: order.number || order.id, total: order.total, currency: order.currency || CURRENCY,
    items: summary, shipping_price: ship.price, delivery_time: ship.delivery_time,
    payment_method: pm.label, payment_instructions: pm.instructions || null,
  };
  ctx.conv.lastOrder = { key, at: Date.now(), result };
  notifyStaff(`🛒 طلب جديد #${result.order_number} عبر أنير\n${c.name} — ${c.city}\n${summary.map((s) => `• ${s.name} × ${s.quantity}`).join('\n')}\nالمجموع: ${result.total} ${result.currency}\nالدفع: ${pm.label}\nهاتف: ${phone}`).catch(() => {});
  return result;
}

// ───────────────────────── تعريف الأدوات لـ Claude ─────────────────────────
const TOOLS = [
  { name: 'search_products', description: 'Search the store catalog by product name, brand, SKU, category or keywords. Use words from the customer message or from the label visible on a product photo. Returns up to 6 matches with id, price, stock status and link. Always use this before stating that a product exists, its price or its availability.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } },
  { name: 'get_product', description: 'Get live full details of one product by id: description (ingredients, directions, warnings as written by the manufacturer/store), price, stock and variations (with variation_id).',
    input_schema: { type: 'object', properties: { product_id: { type: 'integer' } }, required: ['product_id'] } },
  { name: 'list_categories', description: 'List the store product categories with product counts. Use when the customer asks what the store sells.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'search_knowledge', description: "Search the store's vetted reference notes (summaries from recognized scientific bodies, each with its source). Use BEFORE making any general nutrition or supplement science statement that is not on the product page.",
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_shipping_price', description: 'Get the delivery price and delivery time for a city, optionally applying free-shipping thresholds using the products subtotal.',
    input_schema: { type: 'object', properties: { city: { type: 'string' }, order_subtotal: { type: 'number' } }, required: ['city'] } },
  { name: 'create_order', description: 'Create the order in the store. Call ONLY after the customer explicitly confirmed the full summary (products, quantities, address, shipping, payment). Never call it twice for the same order. Prices and totals are computed by the store, not by you.',
    input_schema: { type: 'object', properties: {
      items: { type: 'array', items: { type: 'object', properties: { product_id: { type: 'integer' }, variation_id: { type: 'integer' }, quantity: { type: 'integer' } }, required: ['product_id', 'quantity'] } },
      customer: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string', description: 'Delivery phone. Omit to use the WhatsApp number.' }, city: { type: 'string' }, address: { type: 'string' } }, required: ['name', 'city', 'address'] },
      payment_method: { type: 'string', description: 'One of the payment method ids listed in your instructions.' },
      note: { type: 'string' },
      confirmed_by_customer: { type: 'boolean' },
    }, required: ['items', 'customer', 'payment_method', 'confirmed_by_customer'] } },
  { name: 'handoff_to_human', description: 'Hand the conversation to a human staff member: notifies the staff with a summary and returns a WhatsApp link to the store staff number that you must give to the customer.',
    input_schema: { type: 'object', properties: { reason: { type: 'string', description: 'Short reason (customer asked for staff, complaint, medical question, out of scope, error...).' }, summary: { type: 'string', description: 'Summary of the conversation and what the customer needs, for the staff.' } }, required: ['reason', 'summary'] } },
];

async function runTool(name, input, ctx) {
  input = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'search_products': return toolSearchProducts(input);
    case 'get_product': return toolGetProduct(input);
    case 'list_categories': return toolListCategories();
    case 'search_knowledge': return toolSearchKnowledge(input);
    case 'get_shipping_price': return toolGetShipping(input);
    case 'create_order': return toolCreateOrder(input, ctx);
    case 'handoff_to_human': return toolHandoff(input, ctx);
    default: return { error: `أداة غير معروفة: ${name}` };
  }
}

// ───────────────────────── Claude ─────────────────────────
async function callClaude(messages, dynamicSystem) {
  const body = {
    model: CFG.model, max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }, { type: 'text', text: dynamicSystem }],
    tools: TOOLS, messages,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${CFG.anthropicUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': CFG.anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
      });
      if (res.ok) return await res.json();
      const txt = await res.text();
      if ([429, 500, 502, 503, 529].includes(res.status) && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
      throw new Error(`Claude ${res.status}: ${txt.slice(0, 300)}`);
    } catch (e) {
      if (attempt < 2 && (e.name === 'TimeoutError' || e.name === 'TypeError')) { await sleep(1500 * (attempt + 1)); continue; }
      throw e;
    }
  }
}

const textOf = (blocks) => (blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

async function runClaude(conv, userContent, ctx) {
  const dyn = `الوقت الحالي: ${new Date().toLocaleString('ar-MA-u-nu-latn', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' })}.\n` +
    `رقم واتساب العميل: +${ctx.waId}. اسمه في واتساب: ${ctx.profileName || 'غير معروف'} (قد لا يكون اسمه الحقيقي؛ اسأله عن اسمه عند تسجيل طلب).`;
  const messages = [...conv.messages, { role: 'user', content: userContent }];
  for (let i = 0; i < 8; i++) {
    const resp = await callClaude(messages, dyn);
    messages.push({ role: 'assistant', content: resp.content });
    if (resp.stop_reason !== 'tool_use') return textOf(resp.content);
    const results = [];
    for (const b of resp.content.filter((x) => x.type === 'tool_use')) {
      let out;
      try { out = await runTool(b.name, b.input, ctx); }
      catch (e) { log('خطأ أداة', b.name, e.message); out = { error: 'خطأ تقني مؤقت في الأداة. أخبر العميل بلطف وحوّله لموظف إن استمر.' }; }
      let s = JSON.stringify(out);
      if (s.length > 9000) s = s.slice(0, 9000) + '…(مقتطع)';
      results.push({ type: 'tool_result', tool_use_id: b.id, content: s });
    }
    messages.push({ role: 'user', content: results });
  }
  return '';
}

// ───────────────────────── واتساب ─────────────────────────
const graph = (p) => `${CFG.graphUrl}/${CFG.graphVersion}/${p}`;

async function waPost(payload) {
  const res = await fetch(graph(`${CFG.phoneId}/messages`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${CFG.waToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

function waFormat(t) {
  return String(t)
    .replace(/\*\*(.+?)\*\*/gs, '*$1*').replace(/__(.+?)__/gs, '_$1_')
    .replace(/^#{1,6}\s*/gm, '').replace(/^\s*[-•]\s+/gm, '• ').trim();
}

async function waSend(to, text) {
  let rest = waFormat(text);
  while (rest.length) {
    let chunk = rest;
    if (rest.length > 3800) {
      const cut = rest.lastIndexOf('\n', 3800);
      chunk = rest.slice(0, cut > 1500 ? cut : 3800);
    }
    await waPost({ to, type: 'text', text: { body: chunk, preview_url: false } });
    rest = rest.slice(chunk.length).trim();
  }
}

function markRead(messageId) {
  waPost({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } }).catch(() => {});
}

const SUPPORTED_IMG = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
async function downloadMedia(mediaId) {
  const metaRes = await fetch(graph(mediaId), { headers: { Authorization: `Bearer ${CFG.waToken}` }, signal: AbortSignal.timeout(20000) });
  if (!metaRes.ok) throw new Error(`media meta ${metaRes.status}`);
  const meta = await metaRes.json();
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${CFG.waToken}` }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`media download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 5 * 1024 * 1024) throw new Error('image too large');
  const mime = String(meta.mime_type || '').split(';')[0].toLowerCase();
  if (!SUPPORTED_IMG.has(mime)) throw new Error('unsupported image type ' + mime);
  return { data: buf.toString('base64'), mime };
}

// ───────────────────────── المحادثات ─────────────────────────
const CONV_TTL = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 40;
const convFile = path.join(CFG.dataDir, 'conversations.json');
let convs = {};
try {
  convs = JSON.parse(fs.readFileSync(convFile, 'utf8'));
  for (const k of Object.keys(convs)) if (Date.now() - convs[k].updated > CONV_TTL) delete convs[k];
} catch { convs = {}; }

let saveTimer = null;
function saveConvs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(CFG.dataDir, { recursive: true });
      for (const k of Object.keys(convs)) if (Date.now() - convs[k].updated > CONV_TTL) delete convs[k];
      const tmp = convFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(convs));
      fs.renameSync(tmp, convFile);
    } catch (e) { log('تعذّر حفظ المحادثات:', e.message); }
  }, 500);
}
function getConv(id) {
  let c = convs[id];
  if (!c || Date.now() - c.updated > CONV_TTL) c = convs[id] = { messages: [], updated: Date.now() };
  return c;
}

const rate = new Map();
function rateOk(id) {
  const now = Date.now();
  const arr = (rate.get(id) || []).filter((t) => now - t < 3600e3);
  arr.push(now); rate.set(id, arr);
  return arr.length <= CFG.maxMsgsPerHour;
}

// ───────────────────────── معالجة الرسائل ─────────────────────────
const handoffLinkText = () => `https://wa.me/${S.handoff_whatsapp}`;
const FALLBACK = () => `عذراً، حدث خلل تقني مؤقت 🙏\nيمكنك التواصل مباشرة مع فريقنا هنا:\n${handoffLinkText()}`;

function toItem(m) {
  switch (m.type) {
    case 'text': return { kind: 'text', text: m.text && m.text.body || '' };
    case 'image': return { kind: 'image', mediaId: m.image.id, caption: m.image.caption || '' };
    case 'interactive': {
      const r = m.interactive && (m.interactive.button_reply || m.interactive.list_reply);
      return r ? { kind: 'text', text: r.title || r.id || '' } : null;
    }
    case 'button': return { kind: 'text', text: m.button && m.button.text || '' };
    case 'location': {
      const l = m.location || {};
      return { kind: 'text', text: `[العميل شارك موقعه الجغرافي: ${l.latitude}, ${l.longitude}${l.name ? ' — ' + l.name : ''}${l.address ? ' — ' + l.address : ''}. استعمله كعنوان إضافي واطلب منه تفاصيل العنوان (الحي، الشارع، رقم المنزل) إن لزم.]` };
    }
    case 'audio': return { kind: 'text', text: '[العميل أرسل رسالة صوتية. لا تستطيع سماعها؛ اطلب منه بلطف كتابة رسالته.]' };
    case 'reaction': return null;
    default: return { kind: 'text', text: `[العميل أرسل محتوى من نوع «${m.type}» لا تستطيع فتحه. اطلب منه كتابة طلبه نصاً أو أعرض التحويل لموظف.]` };
  }
}

const seen = new Map();
function isDuplicate(id) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 3600e3) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

const buffers = new Map();
const chains = new Map();
function chain(id, fn) {
  const prev = chains.get(id) || Promise.resolve();
  const next = prev.then(fn).catch((e) => log('خطأ في معالجة محادثة', id, e.message)).finally(() => { if (chains.get(id) === next) chains.delete(id); });
  chains.set(id, next);
}

function enqueue(m, profileName) {
  if (!m || !m.id || !m.from || isDuplicate(m.id)) return;
  let item;
  try { item = toItem(m); } catch { return; }
  if (!item) return;
  markRead(m.id);
  let b = buffers.get(m.from);
  if (!b) { b = { items: [], profileName, timer: null }; buffers.set(m.from, b); }
  b.items.push(item);
  b.profileName = profileName || b.profileName;
  clearTimeout(b.timer);
  b.timer = setTimeout(() => { buffers.delete(m.from); chain(m.from, () => processBatch(m.from, b)); }, CFG.debounceMs);
}

async function processBatch(waId, b) {
  if (!rateOk(waId)) {
    const conv = getConv(waId);
    if (!conv.limitNotified) {
      conv.limitNotified = true;
      await waSend(waId, `وصلنا للحد الأقصى من الرسائل حالياً. للمتابعة مع فريقنا:\n${handoffLinkText()}`).catch(() => {});
    }
    return;
  }
  const conv = getConv(waId);
  conv.limitNotified = false;

  const content = [];
  const plain = [];
  for (const it of b.items) {
    if (it.kind === 'text') {
      if (!it.text.trim()) continue;
      content.push({ type: 'text', text: it.text }); plain.push(it.text);
    } else if (it.kind === 'image') {
      try {
        const img = await downloadMedia(it.mediaId);
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
        content.push({ type: 'text', text: it.caption ? `[صورة من العميل] تعليقه: ${it.caption}` : '[صورة من العميل]' });
        plain.push(it.caption ? `[صورة] ${it.caption}` : '[صورة]');
      } catch (e) {
        log('تعذّر تحميل الصورة:', e.message);
        content.push({ type: 'text', text: '[العميل أرسل صورة لكن تعذّر فتحها. اطلب منه إعادة إرسالها كصورة عادية.]' });
        plain.push('[صورة تعذّر فتحها]');
      }
    }
  }
  if (!content.length) return;

  const ctx = { waId, profileName: b.profileName, conv, currentText: plain.join('\n') };
  let reply = '';
  try { reply = await runClaude(conv, content, ctx); }
  catch (e) { log('خطأ Claude:', e.message); }
  if (!reply) reply = FALLBACK();

  try { await waSend(waId, reply); }
  catch (e) { log('تعذّر الإرسال لواتساب:', e.message); return; }

  conv.messages.push({ role: 'user', content: ctx.currentText }, { role: 'assistant', content: reply });
  while (conv.messages.length > MAX_HISTORY) conv.messages.splice(0, 2);
  conv.updated = Date.now();
  saveConvs();
}

function handlePayload(body) {
  for (const entry of (body && body.entry) || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (v.metadata && v.metadata.phone_number_id && String(v.metadata.phone_number_id) !== String(CFG.phoneId)) continue;
      const names = {};
      for (const c of v.contacts || []) names[c.wa_id] = c.profile && c.profile.name;
      for (const m of v.messages || []) enqueue(m, names[m.from]);
    }
  }
}

// ───────────────────────── خادم HTTP ─────────────────────────
function validSignature(raw, header) {
  const expected = 'sha256=' + crypto.createHmac('sha256', CFG.appSecret).update(raw).digest('hex');
  const a = Buffer.from(expected); const b = Buffer.from(String(header || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/webhook') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === CFG.verifyToken;
    if (ok) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(url.searchParams.get('hub.challenge') || ''); }
    res.writeHead(403); return res.end('forbidden');
  }
  if (req.method === 'POST' && url.pathname === '/webhook') {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 2e6) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!validSignature(raw, req.headers['x-hub-signature-256'])) { res.writeHead(401); return res.end('bad signature'); }
      res.writeHead(200); res.end('ok');
      try { handlePayload(JSON.parse(raw.toString('utf8'))); } catch (e) { log('payload غير صالح:', e.message); }
    });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Anir is running ✅'); }
  res.writeHead(404); res.end('not found');
});

process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message || e));
process.on('uncaughtException', (e) => log('uncaughtException:', e && e.message || e));

server.listen(CFG.port, () => {
  log(`أنير يعمل على المنفذ ${CFG.port} — النموذج: ${CFG.model}`);
  loadCatalog().catch((e) => log('تحذير: تعذّر تحميل الكتالوج عند البدء:', e.message));
});
