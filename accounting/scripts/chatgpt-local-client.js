'use strict';
const el = id => document.getElementById(id);
let history = [], busy = false, poll = null, ready = false, available = false;
// The only model the assistant uses; the server enforces it as well
const MODEL = 'gpt-6-luna';
// The admin page on screen; the panel updates it as the user moves between pages
let page = new URLSearchParams(location.search).get('page') || '/accounting';
const chatMode = new URLSearchParams(location.search).get('chat') === '1';
const SUGGESTIONS = [
  'كيف أسوّي تكاليف رحلة شحن؟',
  'كيف أطابق كشف البنك مع الحركات؟',
  'كيف أربط Refund سابق دون تكرار إضافة المحفظة؟',
  'كيف أسجل فاتورة خدمة من مورد؟',
];
if (chatMode) document.body.classList.add('chat');

function node(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; }
function scrollEnd() { el('messages').scrollTop = el('messages').scrollHeight; }
function welcome() {
  const box = node('div', 'welcome');
  box.append(node('h2', '', 'أهلًا، ما الإجراء الذي تريد فهمه؟'), node('p', '', 'اسأل بكلماتك، أو ابدأ بأحد هذه الأسئلة:'));
  const list = node('div', 'suggestions');
  for (const text of SUGGESTIONS) {
    const b = node('button', '', text); b.type = 'button';
    b.onclick = () => { el('question').value = text; grow(); send(false); };
    list.append(b);
  }
  box.append(list);
  el('messages').replaceChildren(box);
}
async function api(route, body) {
  const response = await fetch(route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Exios-Local': '1' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.error || 'تعذر الطلب'}${data.code ? ` [${data.code}]` : ''}`);
  return data;
}
function error(message, link) {
  el('error').hidden = !message; el('error').replaceChildren();
  if (!message) return;
  el('error').append(message);
  if (link) { const a = node('a', '', link.text); a.href = link.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; el('error').append(' ', a); }
}
// The admin that embeds the chat; only the local dev admin is allowed to frame it (see the CSP)
const ADMIN_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://exios-admin-qa.web.app', 'https://exios-admin-qa.firebaseapp.com'];
const adminParam = new URLSearchParams(location.search).get('admin');
const adminOrigin = ADMIN_ORIGINS.includes(adminParam) ? adminParam : ADMIN_ORIGINS[0];
// A page of the admin: the sections of the side menu, with an optional sub-path and query
const SECTIONS = 'accounting|invoices|invoice|clients|balances|expenses|xtracking|mytasks|dailyReport|reports|odo-export|inventory|mangage|marketing|analytics|special-prices|ratings|settings|deleted-payments|activities|unsureOrder|shippings|returnedPayments';
const PATH = `/(?:${SECTIONS})(?:/[A-Za-z0-9\\-_/]*)?(?:\\?[A-Za-z0-9=&\\-_%]*)?(?:#[A-Za-z0-9\\-_]*)?`;
const isPath = value => new RegExp(`^${PATH}$`).test(value) && !value.includes('//') && !value.includes(':');
window.addEventListener('message', e => {
  if (e.source !== window.parent || !ADMIN_ORIGINS.includes(e.origin)) return;
  if (e.data?.type === 'exios-assistant-page' && typeof e.data.path === 'string') page = e.data.path.slice(0, 150);
});
// Inside the accounting panel the parent page moves to the path; opened on its own, a new tab
function go(path) {
  if (window.parent !== window) window.parent.postMessage({ type: 'exios-assistant-navigate', path }, adminOrigin);
  else window.open(adminOrigin + path, '_blank', 'noopener');
}
function pathLink(label, path) {
  const a = node('a', 'go', label); a.href = adminOrigin + path; a.dir = 'auto';
  a.title = path.startsWith('/accounting') ? 'افتح الصفحة' : 'تُفتح في نافذة جديدة';
  a.onclick = e => { e.preventDefault(); go(path); };
  return a;
}
// Answers keep their line breaks. **bold** becomes bold; [screen](/path), `/path` and a bare /path
// of an admin page become links that open it; everything else stays plain text
function rich(target, text) {
  const pattern = new RegExp(`(\\*\\*[^*\\n]+\\*\\*|\\[[^\\]\\n]+\\]\\(${PATH}\\)|\`[^\`\\n]+\`|(?<![\\w:/.])${PATH})`, 'g');
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) target.append(text.slice(last, m.index));
    const part = m[0];
    const link = /^\[([^\]]+)\]\((.+)\)$/.exec(part);
    if (part.startsWith('**')) rich(target.appendChild(node('strong')), part.slice(2, -2));
    else if (link && isPath(link[2])) target.append(pathLink(link[1], link[2]));
    else if (part.startsWith('`')) { const inner = part.slice(1, -1); target.append(isPath(inner) ? pathLink(inner, inner) : node('code', '', inner)); }
    else if (isPath(part)) target.append(pathLink(part, part));
    else target.append(part);
    last = m.index + part.length;
  }
  if (last < text.length) target.append(text.slice(last));
}
function message(text, answer = false) {
  el('messages').querySelector('.welcome')?.remove();
  const n = node('div', `message ${answer ? 'answer' : 'question'}`);
  if (answer) rich(n, text); else n.textContent = text;
  el('messages').append(n); scrollEnd();
}
function typing(on) {
  el('messages').querySelector('.typing')?.remove();
  if (!on) return;
  const t = node('div', 'typing'); t.setAttribute('aria-label', 'المساعد يكتب الرد');
  t.append(node('span'), node('span'), node('span'));
  el('messages').append(t); scrollEnd();
}
function meta(data, check, text) {
  const m = node('div', 'meta');
  if (check) m.append(`وصل رد مكتمل من ${data.model}: الربط يعمل.`);
  else {
    if (data.sources.length) { m.append('المراجع:'); for (const s of data.sources) m.append(node('span', 'chip', s)); }
    else m.append('لم يجد مرجعًا مطابقًا في الدليل');
    const copy = node('button', 'copy', 'نسخ'); copy.type = 'button';
    copy.onclick = () => navigator.clipboard.writeText(text)
      .then(() => { copy.textContent = 'تم النسخ'; setTimeout(() => { copy.textContent = 'نسخ'; }, 1600); })
      .catch(() => { copy.textContent = 'تعذر النسخ'; });
    m.append(copy);
  }
  el('messages').append(m); scrollEnd();
}
function grow() { const q = el('question'); q.style.height = 'auto'; q.style.height = `${Math.min(q.scrollHeight, 150)}px`; }
async function models() {
  // The server returns only the one model the assistant is allowed to use
  const data = await api('/models');
  const luna = data.models.find(m => m.id === MODEL);
  available = !!luna;
  if (luna) el('model').textContent = luna.name;
  el('progress').textContent = chatMode ? '' : available ? 'نموذج GPT-6-Luna متاح. تحقق من التشغيل أو أرسل سؤالك.' : 'نموذج GPT-6-Luna غير متاح لهذا الحساب.';
  if (chatMode && !available) error('نموذج GPT-6-Luna غير متاح لهذا الحساب.');
}
async function status(load = false) {
  const data = await api('/status');
  ready = !!data.planEnabled;
  el('status').textContent = data.error || (data.connected ? `${data.email || 'الحساب مرتبط'}: ${data.planEnabled ? 'إذن استخدام الاشتراك متاح؛ يلزم رد مكتمل للتحقق من التشغيل.' : 'إذن استخدام الاشتراك غير متاح.'}` : data.pending ? 'أكمل تسجيل الدخول والموافقة في نافذة ChatGPT، ثم حدّث حالة الربط.' : 'الحساب غير مرتبط بعد.');
  el('status').className = `notice${data.error ? ' error' : ''}`;
  el('disconnect').hidden = !data.connected;
  el('send').disabled = busy || !data.planEnabled; el('check').disabled = busy || !data.planEnabled; el('models').disabled = busy || !data.planEnabled;
  if (data.connected && !data.pending && poll) { clearInterval(poll); poll = null; }
  if (chatMode && !data.planEnabled) error('المساعد غير مرتبط بحساب ChatGPT بعد.', { text: 'افتح صفحة الربط', href: `/?page=${encodeURIComponent(page)}` });
  if (load && data.planEnabled) await models();
}
el('connect').onclick = async () => {
  error('');
  const popup = window.open('about:blank', '_blank');
  try {
    const data = await api('/connect', {});
    if (popup) popup.location.replace(data.url); else { const link = document.createElement('a'); link.href = data.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'اضغط هنا لفتح تسجيل الدخول'; el('status').replaceChildren(link); }
    if (poll) clearInterval(poll);
    let ticks = 0; poll = setInterval(() => { if (++ticks > 120) { clearInterval(poll); poll = null; return; } status(false).catch(e => error(e.message)); }, 5000);
    await status(false);
  } catch (e) { if (popup) popup.close(); error(e.message); }
};
el('refresh').onclick = () => status(true).catch(e => error(e.message));
el('models').onclick = () => models().catch(e => error(e.message));
el('disconnect').onclick = async () => { try { await api('/disconnect', {}); history = []; available = false; error(''); await status(); } catch (e) { error(e.message); } };
el('clear').onclick = () => { if (busy) return; history = []; welcome(); error(''); el('progress').textContent = ''; el('question').focus(); };
async function send(check = false) {
  if (busy) return;
  if (!ready) return;
  if (!available) return error('نموذج GPT-6-Luna غير متاح لهذا الحساب.');
  const question = check ? 'أجب بجملة قصيرة: الاتصال يعمل. لا تحتاج شرح إجراءات.' : el('question').value.trim();
  if (!question) return error('اكتب سؤالك أولًا.');
  busy = true; el('connect').disabled = true; el('disconnect').disabled = true;
  error(''); message(question);
  if (!check) { el('question').value = ''; grow(); }
  typing(true); if (!chatMode) el('progress').textContent = 'جارٍ طلب الرد من اشتراكك…';
  await status().catch(() => {});
  try {
    const data = await api('/ask', { question, model: MODEL, history: check ? [] : history, page });
    typing(false); message(data.text, true); meta(data, check, data.text);
    if (!check) { history.push({ role: 'user', content: question }, { role: 'assistant', content: data.text }); history = history.slice(-10); }
    el('progress').textContent = check ? 'تم التحقق: الاشتراك أعطى ردًا مكتملًا بنجاح.' : '';
  } catch (e) {
    typing(false); error(e.message);
    if (!check && !el('question').value) { el('question').value = question; grow(); }
    el('progress').textContent = chatMode ? '' : 'لم يكتمل الطلب. سبب الخطأ ظاهر أعلاه.';
  }
  finally { busy = false; el('connect').disabled = false; el('disconnect').disabled = false; await status().catch(e => error(e.message)); if (chatMode) el('question').focus(); }
}
el('composer').onsubmit = e => { e.preventDefault(); send(false); };
el('question').addEventListener('input', grow);
el('question').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(false); } });
el('check').onclick = () => send(true);
welcome();
status(true).catch(e => error(e.message));
