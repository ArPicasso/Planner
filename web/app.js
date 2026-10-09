(() => {
'use strict';
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { document.documentElement.classList.add('tg'); tg.ready(); tg.expand(); }

const $ = (s) => document.querySelector(s);
const app = $('#app'), bar = $('#bar'), input = $('#input'), sendBtn = $('#send'), destBtn = $('#dest');
const VIEW_LABEL = { list: 'Список с галочками', plan: 'План по датам', notes: 'Что обсудить' };
const EXAMPLE = {
  list: 'матрас 160, шторы в спальню, роутер',
  plan: 'до 1 ноября подключить интернет',
  notes: 'общий пылесос или каждому свой?',
};
const S = { view: 'home', home: null, space: null, sectionId: null, dest: null, pending: [], showDone: {}, answer: '', flash: new Set() };
let busy = false, toastTimer = null, toastBatch = null;

/* ---------- helpers ---------- */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'value') e.value = v;
    else if (k === 'disabled') e.disabled = !!v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}
function svgCheck() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '14'); s.setAttribute('height', '14');
  s.innerHTML = '<path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>';
  return s;
}
function call(name, payload) {
  return new Promise((resolve, reject) => {
    if (!tg || !tg.Serverless) { reject({ message: 'Открой приложение через Telegram.' }); return; }
    tg.Serverless.call(name, payload || {}, (err, res) => (err ? reject(err) : resolve(res)));
  });
}
const errText = (e) => (e && (e.message || e.description)) || 'Что-то пошло не так. Попробуй ещё раз.';
const haptic = (kind) => { try { kind === 'ok' ? tg.HapticFeedback.notificationOccurred('success') : tg.HapticFeedback.impactOccurred('light'); } catch (e) { /* no haptics */ } };
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } } };

const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MON_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDue = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MON[m - 1]}`; };
const fmtPrice = (p) => (p == null ? '' : (Number.isInteger(p) ? String(p) : p.toFixed(2).replace('.', ',')) + ' €');
const firstName = (n) => String(n || '').split(/\s+/)[0] || 'Кто-то';
const initials = (n) => { const p = String(n || '?').trim().split(/\s+/); return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase(); };
const colorOf = (id) => `var(--m${Math.abs(Number(id) || 0) % 5})`;
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const plural = (n, a, b, c) => { const m = n % 10, k = n % 100; return m === 1 && k !== 11 ? a : m >= 2 && m <= 4 && (k < 12 || k > 14) ? b : c; };

// Same rule as the server's fallback: commas, semicolons and new lines separate entries.
function splitItems(text) {
  let t = String(text || '').trim();
  t = t.replace(/^(купить|нужно купить|нужно|надо|need|buy|kaufen|einkaufen)\s*[:\-–—]?\s*/i, '');
  return t.split(/\n|;|,(?![^()]*\))(?!\d)/).map((s) => s.replace(/^\s*(?:[-•*·]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 50);
}

/* ---------- toast ---------- */
function toast(text, batchId = null, ms = 5000) {
  $('#toast-text').textContent = text;
  toastBatch = batchId;
  $('#toast-undo').hidden = !batchId;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { $('#toast').hidden = true; toastBatch = null; }, ms);
}
$('#toast-undo').addEventListener('click', async () => {
  const b = toastBatch; if (!b) return;
  $('#toast').hidden = true; toastBatch = null;
  try {
    const r = await call('undo', { batch: b });
    if (S.view === 'space' && S.space && r.state.space.id === S.space.space.id) { S.space = r.state; render(); }
    else await reloadHome();
    toast('Отменено');
  } catch (e) { toast(errText(e)); }
});

/* ---------- rows ---------- */
function dueChip(it) {
  if (!it.due) return null;
  const t = todayIso();
  if (it.done) return h('span', { class: 'due', text: fmtDue(it.due) });
  if (it.due < t) return h('span', { class: 'due late', text: `просрочено · ${fmtDue(it.due)}` });
  if (it.due === t) return h('span', { class: 'due today', text: 'сегодня' });
  return h('span', { class: 'due', text: `до ${fmtDue(it.due)}` });
}

function itemRow(it, o) {
  const row = h('div', { class: 'row' + (it.done ? ' done' : '') + (it.pending ? ' pending' : '') + (S.flash.has(it.id) ? ' flash' : '') });
  const chk = h('button', { class: 'check', type: 'button', 'aria-pressed': String(!!it.done), 'aria-label': it.done ? `Вернуть: ${it.text}` : `Готово: ${it.text}`, disabled: !!it.pending }, svgCheck());
  chk.addEventListener('click', () => toggleDone(it, o));

  const meta = [];
  if (o.showSpace) meta.push(h('span', { text: `${it.spaceTitle} · ${it.sectionTitle}` }));
  if (o.showGroup && it.grp) meta.push(h('span', { text: it.grp }));
  if (it.qty) meta.push(h('span', { text: it.qty }));
  if (it.price != null) meta.push(h('span', { text: fmtPrice(it.price) }));
  const dc = dueChip(it); if (dc) meta.push(dc);
  if (it.note) meta.push(h('span', { text: '✎ ' + clip(it.note, 40) }));
  if (o.byLine && it.addedBy && it.addedBy !== o.me) meta.push(h('span', { text: 'от ' + firstName(o.names[it.addedBy]) }));
  if (it.done && it.doneBy && o.names) meta.push(h('span', { text: firstName(o.names[it.doneBy]) }));

  const body = h('button', { class: 'body', type: 'button' },
    h('span', { class: 't' }, it.fresh ? h('i', { class: 'new', title: 'Новое' }) : null, it.text),
    meta.length ? h('span', { class: 'meta' }, meta) : null);
  body.addEventListener('click', () => { if (!it.pending && o.onOpen) o.onOpen(it); });
  row.append(chk, body);

  if (!it.done && !it.pending) {
    if (it.claimedBy) {
      const nm = o.names[it.claimedBy] || 'Участник', mine = it.claimedBy === o.me;
      const b = h('button', { class: 'who taken' + (mine ? ' me' : ''), type: 'button', text: initials(nm),
        title: `Берёт ${nm}`, 'aria-label': mine ? `Берёшь ты. Нажми, чтобы отказаться` : `Берёт ${nm}. Нажми, чтобы забрать себе` });
      b.style.background = colorOf(it.claimedBy);
      b.addEventListener('click', () => toggleClaim(it, o));
      row.append(b);
    } else {
      const b = h('button', { class: 'who', type: 'button', text: 'Беру' });
      b.addEventListener('click', () => toggleClaim(it, o));
      row.append(b);
    }
  }
  return row;
}

async function toggleDone(it, o) {
  const prev = it.done;
  it.done = !prev; it.doneBy = it.done ? o.me : null;
  haptic(); render();
  try {
    const r = await call('setDone', { item: it.id, done: it.done });
    Object.assign(it, r);
    if (o.after) await o.after(); else render();
  } catch (e) { it.done = prev; render(); toast(errText(e)); }
}
async function toggleClaim(it, o) {
  const prev = it.claimedBy;
  it.claimedBy = prev === o.me ? null : o.me;
  haptic(); render();
  try {
    const r = await call('claim', { item: it.id });
    Object.assign(it, r);
    if (o.after) await o.after(); else render();
  } catch (e) { it.claimedBy = prev; render(); toast(errText(e)); }
}

function block(label, count, rows) {
  return [
    h('div', { class: 'label' }, h('span', { text: label }), count != null ? h('span', { class: 'n', text: String(count) }) : null),
    h('div', { class: 'card' }, rows),
  ];
}

/* ---------- home ---------- */
function renderHome() {
  const H = S.home;
  const d = new Date();
  app.replaceChildren(h('header', { class: 'top' },
    h('h1', { text: `Привет, ${firstName(H.me.name)}` }),
    h('p', { text: `${WD[d.getDay()]}, ${d.getDate()} ${MON_GEN[d.getMonth()]}` })));
  if (S.answer) app.append(h('div', { class: 'answer', text: S.answer }));

  const o = { names: H.names, me: H.me.id, showSpace: true, after: reloadHome,
    onOpen: (it) => openSpace(it.spaceId, { section: it.sectionId, flash: it.id }) };
  let any = false;
  if (H.fresh.length) { any = true; app.append(...block('Новое от других', H.fresh.length, H.fresh.map((it) => itemRow(it, { ...o, byLine: true })))); }
  if (H.claimed.length) { any = true; app.append(...block('На мне', H.claimed.length, H.claimed.map((it) => itemRow(it, o)))); }
  const soon = H.soon.filter((it) => !H.claimed.some((c) => c.id === it.id));
  if (soon.length) { any = true; app.append(...block('Скоро', soon.length, soon.map((it) => itemRow(it, o)))); }
  if (!any) app.append(h('div', { class: 'card' }, h('div', { class: 'empty', text: 'Ничего срочного. Пиши внизу всё, что держишь в голове, я разложу по спискам.' })));

  app.append(h('div', { class: 'label' }, h('span', { text: 'Пространства' })));
  app.append(h('div', { class: 'tiles' }, H.spaces.map((sp) => {
    const t = h('button', { class: 'tile', type: 'button' },
      h('span', { class: 'kind', text: sp.kind === 'shared' ? 'Общее' : 'Личное' }),
      h('b', { text: sp.title }),
      h('small', { text: `${sp.open} ${plural(sp.open, 'открытый пункт', 'открытых пункта', 'открытых пунктов')}` }),
      sp.fresh ? h('span', { class: 'badge', text: String(sp.fresh), 'aria-label': `${sp.fresh} новых` }) : null);
    t.addEventListener('click', () => openSpace(sp.id));
    return t;
  })));
  renderDest();
}

// Сервер отдаёт имена массивом (см. homeState) — в браузере удобнее объектом.
const homeWithNames = (home) => ({
  ...home,
  names: Object.fromEntries((home.names || []).map((n) => [n.id, n.name])),
});

async function reloadHome() {
  try {
    const r = await call('bootstrap', {});
    S.home = homeWithNames(r.home);
    if (S.view === 'home') render();
  } catch (e) { toast(errText(e)); }
}

/* ---------- space ---------- */
function names() { return Object.fromEntries((S.space ? S.space.members : []).map((m) => [m.id, m.name])); }
function currentSection() {
  const secs = S.space.sections;
  return secs.find((s) => s.id === S.sectionId) || secs[0] || null;
}

function renderSpace() {
  const st = S.space, sec = currentSection();
  if (sec) S.sectionId = sec.id;
  const nm = names();
  app.replaceChildren(h('header', { class: 'top' },
    h('h1', { text: st.space.title }),
    h('p', { text: st.space.kind === 'shared' ? `Общее · ${st.members.map((m) => firstName(m.name)).join(', ')}` : 'Личное, видишь только ты' })));
  if (S.answer) app.append(h('div', { class: 'answer', text: S.answer }));

  const openCount = (sid) => st.items.filter((i) => i.sectionId === sid && !i.done).length;
  const tabs = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Разделы' },
    st.sections.map((s) => {
      const fresh = st.items.some((i) => i.sectionId === s.id && i.fresh && !i.done);
      const b = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(sec && s.id === sec.id) },
        fresh ? h('i', { class: 'new' }) : null, s.title, h('span', { class: 'c', text: String(openCount(s.id)) }));
      b.addEventListener('click', () => { S.sectionId = s.id; store.set(`sec:${st.space.id}`, String(s.id)); S.answer = ''; render(); });
      return b;
    }),
    h('button', { class: 'tab', type: 'button', 'aria-label': 'Новый раздел', text: '＋', onclick: openSectionSheet }));
  app.append(tabs);
  if (!sec) { app.append(h('div', { class: 'card' }, h('div', { class: 'empty', text: 'Разделов пока нет. Напиши что-нибудь внизу, и они появятся.' }))); renderDest(); return; }

  const o = { names: nm, me: st.me, showGroup: sec.view !== 'list', onOpen: openItemSheet, byLine: st.space.kind === 'shared' };
  const mine = st.items.filter((i) => i.sectionId === sec.id);
  const pending = S.pending.filter((p) => p.sectionId === sec.id);
  const open = mine.filter((i) => !i.done);
  const done = mine.filter((i) => i.done).sort((a, b) => b.updated - a.updated);

  let rows = [];
  if (sec.view === 'plan') {
    open.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.created - b.created);
    rows = open.map((it) => itemRow(it, { ...o, showGroup: true }));
  } else if (sec.view === 'list' && open.some((i) => i.grp)) {
    const order = [...(sec.groups || [])];
    for (const i of open) if (i.grp && !order.includes(i.grp)) order.push(i.grp);
    for (const g of order) {
      const list = open.filter((i) => i.grp === g).sort((a, b) => a.created - b.created);
      if (list.length) rows.push(h('div', { class: 'grp', text: g }), ...list.map((it) => itemRow(it, o)));
    }
    const rest = open.filter((i) => !i.grp);
    if (rest.length) rows.push(h('div', { class: 'grp', text: 'Без группы' }), ...rest.map((it) => itemRow(it, o)));
  } else {
    rows = open.sort((a, b) => a.created - b.created).map((it) => itemRow(it, o));
  }
  rows = pending.map((p) => itemRow(p, o)).concat(rows);

  app.append(h('div', { class: 'label' }, h('span', { text: VIEW_LABEL[sec.view] || 'Список' }), h('span', { class: 'n', text: String(open.length) })));
  app.append(h('div', { class: 'card' }, rows.length ? rows : h('div', { class: 'empty', text: `Пусто. Напиши внизу, например: ${EXAMPLE[sec.view] || EXAMPLE.list}` })));

  const left = open.reduce((s, i) => s + (i.price || 0), 0), spent = done.reduce((s, i) => s + (i.price || 0), 0);
  if (left || spent) app.append(h('div', { class: 'foot' },
    h('span', { text: left ? `Осталось ≈ ${fmtPrice(Math.round(left * 100) / 100)}` : '' }),
    h('span', { text: spent ? `Потрачено ${fmtPrice(Math.round(spent * 100) / 100)}` : '' })));

  if (done.length) {
    const shown = !!S.showDone[sec.id];
    app.append(h('div', { class: 'label' }, h('span', { text: 'Готово' }), h('span', { class: 'n', text: String(done.length) })));
    app.append(h('div', { class: 'card' },
      shown ? done.slice(0, 60).map((it) => itemRow(it, o)) : null,
      h('button', { class: 'linkbtn', type: 'button', text: shown ? 'Скрыть' : 'Показать',
        onclick: () => { S.showDone[sec.id] = !shown; render(); } })));
  }
  renderDest();
}

async function openSpace(id, opts = {}) {
  S.view = 'space'; S.answer = '';
  if (tg) tg.BackButton.show();
  if (!S.space || S.space.space.id !== id) app.replaceChildren(h('div', { class: 'empty', text: 'Открываю…' }));
  try {
    const st = await call('getSpace', { id });
    S.space = st;
    const remembered = Number(store.get(`sec:${id}`));
    S.sectionId = opts.section || (st.sections.some((s) => s.id === remembered) ? remembered : (st.sections[0] && st.sections[0].id));
    if (opts.flash) flash([opts.flash]);
    S.dest = id; store.set('dest', String(id));
    render();
  } catch (e) { toast(errText(e)); goHome(); }
}
function goHome() {
  S.view = 'home'; S.answer = ''; S.pending = [];
  if (tg) tg.BackButton.hide();
  if (S.home) render();
  reloadHome();
}
async function refreshSpace() {
  if (!S.space) return;
  try { S.space = await call('getSpace', { id: S.space.space.id }); render(); } catch (e) { /* quiet */ }
}
function flash(ids) {
  for (const id of ids) S.flash.add(id);
  setTimeout(() => { for (const id of ids) S.flash.delete(id); }, 1800);
}

/* ---------- input bar ---------- */
function destSpaces() { return S.home ? S.home.spaces : []; }
function renderDest() {
  if (S.view === 'space' && S.space) {
    const sec = currentSection();
    destBtn.textContent = sec ? `→ ${sec.title} · Claude разложит по разделам сам` : '→ Claude разложит по разделам';
    destBtn.disabled = true;
  } else {
    const sp = destSpaces().find((s) => s.id === S.dest) || destSpaces()[0];
    S.dest = sp ? sp.id : null;
    destBtn.textContent = sp ? `→ ${sp.title}${destSpaces().length > 1 ? '  · сменить' : ''}` : '';
    destBtn.disabled = destSpaces().length < 2;
  }
}
destBtn.addEventListener('click', () => {
  const list = destSpaces(); if (list.length < 2) return;
  const i = list.findIndex((s) => s.id === S.dest);
  S.dest = list[(i + 1) % list.length].id; store.set('dest', String(S.dest));
  haptic(); renderDest();
});
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; }
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); bar.requestSubmit(); }
});
bar.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  const inSpace = S.view === 'space' && S.space;
  const target = inSpace ? S.space.space.id : S.dest;
  if (!target) return;
  busy = true; sendBtn.disabled = true;
  input.value = ''; autosize(); S.answer = '';
  if (inSpace) {
    S.pending = splitItems(text).map((t, i) => ({ id: `p${i}`, text: t, sectionId: S.sectionId, pending: true }));
    render();
  } else toast('Записываю…', null, 0);
  try {
    const r = await call('addText', { space: target, section: inSpace ? S.sectionId : null, text });
    S.pending = [];
    if (inSpace && S.space && S.space.space.id === target) {
      const before = new Set(S.space.items.map((i) => i.id));
      S.space = r.state;
      flash(r.state.items.filter((i) => !before.has(i.id)).map((i) => i.id));
    } else await reloadHome();
    S.answer = r.reply || '';
    const note = r.fallback && r.batchId ? (r.aiError === 'no_key' ? '\nClaude не подключён, записал как есть' : '\nClaude не ответил, записал как есть') : '';
    if (r.batchId) { haptic('ok'); toast(`${r.summary}${note}`, r.batchId, 6000); }
    else if (!r.reply) toast('Не нашёл, что записать. Напиши, что купить, сделать или обсудить.');
    else $('#toast').hidden = true;
    render();
  } catch (err) {
    S.pending = []; input.value = text; autosize(); render(); toast(errText(err));
  } finally { busy = false; sendBtn.disabled = false; }
});

/* ---------- sheets ---------- */
function openSheet(content) {
  const sh = $('#sheet');
  sh.replaceChildren(h('div', { class: 'grab' }), ...content);
  sh.hidden = false; $('#scrim').hidden = false;
  bar.hidden = true;
}
function closeSheet() { $('#sheet').hidden = true; $('#scrim').hidden = true; bar.hidden = false; }
$('#scrim').addEventListener('click', closeSheet);

function field(label, el) { return h('div', { class: 'field' }, h('label', { for: el.id, text: label }), el); }

function openItemSheet(it) {
  const st = S.space, sec = st.sections.find((s) => s.id === it.sectionId);
  const groups = new Set([...(sec && sec.groups || []), ...st.items.filter((i) => i.sectionId === it.sectionId && i.grp).map((i) => i.grp)]);
  const f = {
    text: h('input', { id: 'f-text', type: 'text', value: it.text }),
    section: h('select', { id: 'f-section' }, st.sections.map((s) => h('option', { value: String(s.id), text: s.title, selected: s.id === it.sectionId }))),
    grp: h('input', { id: 'f-grp', type: 'text', value: it.grp, list: 'f-groups', placeholder: 'Кухня, Спальня…' }),
    qty: h('input', { id: 'f-qty', type: 'text', value: it.qty, placeholder: '2 шт, 160×200' }),
    price: h('input', { id: 'f-price', type: 'text', inputmode: 'decimal', value: it.price != null ? String(it.price).replace('.', ',') : '', placeholder: '0' }),
    due: h('input', { id: 'f-due', type: 'date', value: it.due }),
    note: h('textarea', { id: 'f-note', value: it.note, placeholder: 'Ссылка, размер, где купить' }),
  };
  const nm = names();
  const added = it.addedBy ? `Добавил${st.space.kind === 'shared' ? ' ' + firstName(nm[it.addedBy]) : ''} · ${new Date(it.created).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}` : '';
  const save = async () => {
    const fields = { text: f.text.value, sectionId: Number(f.section.value), grp: f.grp.value, qty: f.qty.value, price: f.price.value, due: f.due.value, note: f.note.value };
    try {
      const r = await call('editItem', { item: it.id, fields });
      Object.assign(it, r); closeSheet(); render(); haptic();
    } catch (e) { toast(errText(e)); }
  };
  const del = async () => {
    try {
      const r = await call('deleteItem', { item: it.id });
      st.items = st.items.filter((x) => x.id !== it.id);
      closeSheet(); render(); toast(`Удалено: ${clip(it.text, 40)}`, r.batchId);
    } catch (e) { toast(errText(e)); }
  };
  openSheet([
    h('h2', { text: 'Пункт' }),
    field('Название', f.text),
    h('div', { class: 'pair' }, field('Раздел', f.section), field('Группа', f.grp)),
    h('datalist', { id: 'f-groups' }, [...groups].map((g) => h('option', { value: g }))),
    h('div', { class: 'pair' }, field('Количество', f.qty), field('Цена, €', f.price)),
    field('Срок', f.due),
    field('Заметка', f.note),
    added ? h('p', { class: 'meta', text: added }) : null,
    h('div', { class: 'actions' }, h('button', { class: 'danger', type: 'button', text: 'Удалить', onclick: del }), h('button', { class: 'primary', type: 'button', text: 'Сохранить', onclick: save })),
  ]);
}

function openSectionSheet() {
  const title = h('input', { id: 's-title', type: 'text', placeholder: 'Например: Расходы, Документы, Ремонт' });
  const view = h('select', { id: 's-view' }, Object.entries(VIEW_LABEL).map(([k, v]) => h('option', { value: k, text: v })));
  const create = async () => {
    if (!title.value.trim()) { title.focus(); return; }
    try {
      const r = await call('addSection', { space: S.space.space.id, title: title.value, view: view.value });
      S.space = r.state; S.sectionId = r.section; closeSheet(); render();
    } catch (e) { toast(errText(e)); }
  };
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  openSheet([
    h('h2', { text: 'Новый раздел' }),
    field('Название', title),
    field('Как показывать', view),
    h('div', { class: 'actions' }, h('button', { class: 'ghost', type: 'button', text: 'Отмена', onclick: closeSheet }), h('button', { class: 'primary', type: 'button', text: 'Создать', onclick: create })),
  ]);
  setTimeout(() => title.focus(), 50);
}

/* ---------- render & boot ---------- */
function render() {
  if (S.view === 'space' && S.space) renderSpace();
  else if (S.home) renderHome();
}

if (tg) tg.BackButton.onClick(() => { if (!$('#sheet').hidden) closeSheet(); else goHome(); });

// Pick up the other person's changes while the app is open.
setInterval(() => {
  if (document.hidden || busy || !$('#sheet').hidden || input.value) return;
  if (S.view === 'space') refreshSpace(); else reloadHome();
}, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) (S.view === 'space' ? refreshSpace() : reloadHome()); });

async function boot() {
  if (!tg || !tg.initData) {
    bar.hidden = true;
    app.replaceChildren(h('header', { class: 'top' }, h('h1', { text: 'Атлас' }), h('p', { text: 'Открой это приложение из Telegram, через бота.' })));
    return;
  }
  app.replaceChildren(h('div', { class: 'empty', text: 'Загружаю…' }));
  try {
    // start_param приходит только при запуске по ссылке t.me?startapp=.
    // Кнопка web_app открывает адрес напрямую, поэтому id пространства едет в ?s=.
    const qs = new URLSearchParams(location.search).get('s');
    const r = await call('bootstrap', {
      start: (tg.initDataUnsafe && tg.initDataUnsafe.start_param) || (qs ? `s${qs}` : ''),
      origin: location.origin,
    });
    S.home = homeWithNames(r.home);
    const saved = Number(store.get('dest'));
    S.dest = r.home.spaces.some((s) => s.id === saved) ? saved : (r.home.spaces[0] && r.home.spaces[0].id);
    if (r.open) openSpace(r.open); else render();
  } catch (e) {
    bar.hidden = true;
    app.replaceChildren(h('p', { class: 'err', text: errText(e) }));
  }
}
boot();
})();
