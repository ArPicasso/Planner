// Turns a free-form message into list operations (via Claude), applies them as one
// undoable batch, and falls back to a plain split when Claude is unavailable.
import { db } from 'sdk';
import { eq, and } from 'sdk/db';
import { items, sections, batches } from '../schema.js';
import { askClaude, parseJson } from './ai.js';
import { splitItems, toNumber, toDate } from './parse.js';
import * as S from './store.js';

const SYSTEM = `Ты — диспетчер общего списка покупок, дел и планов. Люди пишут коротко и свободно (по-русски, иногда по-немецки или по-английски). Превращай сообщение в операции над списком.

Правила:
- Каждая вещь или задача — отдельный пункт: «матрас, шторы и роутер» → 3 пункта.
- Покупки → раздел вида list (обычно «Купить»). Укажи group — комнату или категорию из групп раздела, если подходит.
- Дела с действием или сроком → раздел вида plan (обычно «Дела»). Срок пиши в due как YYYY-MM-DD: «к 1 ноября» → ближайшее будущее 1 ноября, «в пятницу» → ближайшая пятница.
- То, что нужно решить вместе («общий пылесос или каждому свой?») → раздел вида notes («Обсудить»).
- Если подходящего раздела нет, создай его через new_section и ссылайся на его ref.
- «купил X», «сделал X», «готово X» → done для подходящего открытого пункта (по смыслу, не дословно). Если названа цена — price в евро.
- «беру X», «я куплю X», «на мне X» → claim (берёт автор). «не беру X» → unclaim.
- Количество, размер и цену выноси в qty и price, в text оставь короткое название с заглавной буквы.
- Ссылки и подробности клади в note.
- Если пункт уже есть в открытом списке, не дублируй его, а обнови через update.
- Если сообщение — вопрос о списке («что осталось купить?», «что на мне?», «сколько потратили?»), ничего не меняй и ответь в reply коротко и по делу на основе данных ниже.
- Если сообщение не про список (болтовня, приветствие), верни actionable=false и пустые ops.
- Не выдумывай пункты, которых нет в сообщении.

Операции:
{"op":"add","section":<id или ref>,"text":"...","group":"...","qty":"...","price":12.5,"due":"YYYY-MM-DD","note":"..."}
{"op":"new_section","ref":"s1","title":"...","view":"list|plan|notes"}
{"op":"done","item":<id>,"price":45}
{"op":"undone","item":<id>}
{"op":"claim","item":<id>}
{"op":"unclaim","item":<id>}
{"op":"update","item":<id>,"text":"...","group":"...","qty":"...","price":10,"due":"YYYY-MM-DD","note":"...","section":<id>}
{"op":"delete","item":<id>}
Необязательные поля, которых нет в сообщении, не указывай.

Ответь только JSON без пояснений: {"actionable":true,"ops":[...],"reply":""}`;

function buildContext({ space, user, text, secs, open, done, mems, preferSectionId }) {
  const nameOf = (id) => S.shortName(mems.find((m) => m.id === id)?.name);
  const d = S.today();
  const secLines = secs.map((s) =>
    `[${s.id}] ${s.title} (${s.view}${Array.isArray(s.groups) && s.groups.length ? `; группы: ${s.groups.join(', ')}` : ''})`).join('\n');
  const itemLine = (it) => {
    const p = [`#${it.id} [${it.sectionId}] ${it.text}`];
    if (it.grp) p.push(it.grp);
    if (it.qty) p.push(`кол-во ${it.qty}`);
    if (it.price != null) p.push(S.fmtPrice(it.price));
    if (it.due) p.push(`до ${it.due}`);
    if (it.claimedBy) p.push(`берёт ${nameOf(it.claimedBy)}`);
    if (it.note) p.push(`заметка: ${S.clip(it.note, 60)}`);
    return p.join(' | ');
  };
  const pref = preferSectionId ? secs.find((s) => s.id === Number(preferSectionId)) : null;
  return `Сегодня: ${d} (${S.weekday(d)}).
Пространство: «${space.title}» (${space.kind === 'shared' ? 'общее' : 'личное'}). Участники: ${mems.map((m) => S.shortName(m.name)).join(', ')}.
Автор сообщения: ${S.shortName(user.name)}.${pref ? `\nУ автора сейчас открыт раздел [${pref.id}] ${pref.title}: если сообщение явно не про другое, клади пункты туда.` : ''}

Разделы:
${secLines}

Открытые пункты (${open.length}):
${open.map(itemLine).join('\n') || '(нет)'}

Недавно закрытые:
${done.map((it) => `#${it.id} [${it.sectionId}] ${it.text}${it.price != null ? ' | ' + S.fmtPrice(it.price) : ''}${it.doneBy ? ' | закрыл ' + nameOf(it.doneBy) : ''}`).join('\n') || '(нет)'}

Сообщение:
"""
${text}
"""`;
}

export async function processText({ space, user, text, preferSectionId = null }) {
  let secs = await S.spaceSections(space.id);
  if (!secs.length) {
    await S.applyTemplate(space, space.kind === 'shared' ? 'home' : 'personal');
    secs = await S.spaceSections(space.id);
  }
  const open = await S.openItems(space.id, 200);
  const done = await S.doneItems(space.id, 20);
  const mems = await S.spaceMembers(space.id);

  let plan = null, aiError = null;
  try {
    const out = await askClaude(SYSTEM, buildContext({ space, user, text, secs, open, done, mems, preferSectionId }));
    if (out == null) aiError = 'no_key';
    else {
      plan = parseJson(out);
      if (!plan || !Array.isArray(plan.ops)) { aiError = 'format'; plan = null; }
    }
  } catch (e) {
    aiError = e && e.status === 401 ? 'bad_key' : 'unavailable';
  }
  if (!plan) {
    const target = secs.find((s) => s.id === Number(preferSectionId)) || secs.find((s) => s.view === 'list') || secs[0];
    plan = { actionable: true, ops: splitItems(text).map((t) => ({ op: 'add', section: target.id, text: t })), reply: '', fallback: true };
  }
  const result = await applyPlan({ space, user, plan, secs });
  result.reply = plan.reply ? String(plan.reply).slice(0, 1500) : '';
  result.actionable = plan.actionable !== false;
  result.aiError = aiError;
  result.fallback = !!plan.fallback;
  return result;
}

const snapshot = (it) => ({
  text: it.text, note: it.note, grp: it.grp, qty: it.qty, price: it.price, due: it.due,
  done: it.done, claimedBy: it.claimedBy, doneBy: it.doneBy, sectionId: it.sectionId,
});

export async function applyPlan({ space, user, plan, secs }) {
  const ops = Array.isArray(plan.ops) ? plan.ops.slice(0, 60) : [];
  const secById = new Map(secs.map((s) => [s.id, s]));
  const refs = {};
  const undo = [], lines = [];
  const t = S.now();
  if (!ops.length) return { batchId: null, lines, changed: false, sections: secs };

  const [batch] = await db.insert(batches)
    .values({ spaceId: space.id, userId: user.id, summary: '', undo: [], undone: false, created: t })
    .returning().run();

  const resolveSec = (x) => {
    if (x == null) return null;
    if (refs[String(x)]) return refs[String(x)];
    return secById.get(Number(x)) || null;
  };
  const loadItem = async (id) => {
    const it = await S.itemById(id);
    return it && it.spaceId === space.id ? it : null;
  };

  for (const o of ops) {
    try {
      if (o.op === 'new_section') {
        const title = S.clip(o.title, 40);
        if (!title) continue;
        const dup = secs.find((s) => s.title.toLowerCase() === title.toLowerCase());
        if (dup) { if (o.ref) refs[String(o.ref)] = dup; continue; }
        const s = await S.addSection(space.id, { title, view: o.view });
        secs.push(s); secById.set(s.id, s);
        if (o.ref) refs[String(o.ref)] = s;
        undo.push({ t: 'delsec', id: s.id });
        lines.push({ k: 'section', section: s });
      } else if (o.op === 'add') {
        const sec = resolveSec(o.section) || secs.find((s) => s.view === 'list') || secs[0];
        const txt = S.clip(o.text, 200);
        if (!txt || !sec) continue;
        const [row] = await db.insert(items).values({
          spaceId: space.id, sectionId: sec.id, text: txt,
          note: o.note ? String(o.note).slice(0, 2000) : null,
          grp: o.group ? S.clip(o.group, 40) : null,
          qty: o.qty != null && o.qty !== '' ? S.clip(o.qty, 40) : null,
          price: toNumber(o.price), due: toDate(o.due),
          done: false, claimedBy: null, addedBy: user.id, doneBy: null,
          batch: batch.id, created: t, updated: t,
        }).returning().run();
        undo.push({ t: 'del', id: row.id });
        lines.push({ k: 'add', item: row, section: sec });
      } else if (o.op === 'done' || o.op === 'undone') {
        const it = await loadItem(o.item); if (!it) continue;
        const set = o.op === 'done' ? { done: true, doneBy: user.id, updated: t } : { done: false, doneBy: null, updated: t };
        if (o.op === 'done' && toNumber(o.price) != null) set.price = toNumber(o.price);
        undo.push({ t: 'restore', id: it.id, prev: snapshot(it) });
        await db.update(items).set(set).where(eq(items.id, it.id)).run();
        lines.push({ k: o.op, item: { ...it, ...set } });
      } else if (o.op === 'claim' || o.op === 'unclaim') {
        const it = await loadItem(o.item); if (!it) continue;
        const set = { claimedBy: o.op === 'claim' ? user.id : null, updated: t };
        undo.push({ t: 'restore', id: it.id, prev: snapshot(it) });
        await db.update(items).set(set).where(eq(items.id, it.id)).run();
        lines.push({ k: o.op, item: { ...it, ...set }, by: user });
      } else if (o.op === 'update') {
        const it = await loadItem(o.item); if (!it) continue;
        const set = { updated: t };
        if (o.text) set.text = S.clip(o.text, 200);
        if ('group' in o) set.grp = o.group ? S.clip(o.group, 40) : null;
        if ('qty' in o) set.qty = o.qty != null && o.qty !== '' ? S.clip(o.qty, 40) : null;
        if ('price' in o) set.price = toNumber(o.price);
        if ('due' in o) set.due = toDate(o.due);
        if ('note' in o) set.note = o.note ? String(o.note).slice(0, 2000) : null;
        if (o.section != null) { const s = resolveSec(o.section); if (s) set.sectionId = s.id; }
        undo.push({ t: 'restore', id: it.id, prev: snapshot(it) });
        await db.update(items).set(set).where(eq(items.id, it.id)).run();
        lines.push({ k: 'update', item: { ...it, ...set } });
      } else if (o.op === 'delete') {
        const it = await loadItem(o.item); if (!it) continue;
        undo.push({ t: 'reinsert', row: it });
        await db.delete(items).where(eq(items.id, it.id)).run();
        lines.push({ k: 'delete', item: it });
      }
    } catch (e) {
      console.warn('op failed', JSON.stringify(o), e && e.message);
    }
  }

  const summary = shortSummary(lines, secs);
  if (undo.length) await db.update(batches).set({ undo, summary }).where(eq(batches.id, batch.id)).run();
  else await db.delete(batches).where(eq(batches.id, batch.id)).run();
  return { batchId: undo.length ? batch.id : null, lines, summary, changed: undo.length > 0, sections: secs };
}

// "+3 в Купить · +1 в Дела · ✓ 1"
export function shortSummary(lines, secs) {
  const adds = {};
  let done = 0, claim = 0, upd = 0, del = 0, newSec = 0;
  for (const l of lines) {
    if (l.k === 'add') adds[l.section.title] = (adds[l.section.title] || 0) + 1;
    else if (l.k === 'done') done++;
    else if (l.k === 'claim' || l.k === 'unclaim') claim++;
    else if (l.k === 'update' || l.k === 'undone') upd++;
    else if (l.k === 'delete') del++;
    else if (l.k === 'section') newSec++;
  }
  const parts = Object.entries(adds).map(([t, n]) => `+${n} в ${t}`);
  if (done) parts.push(`✓ ${done}`);
  if (claim) parts.push(`взято ${claim}`);
  if (upd) parts.push(`изменено ${upd}`);
  if (del) parts.push(`убрано ${del}`);
  if (newSec && !parts.length) parts.push(`новый раздел`);
  return parts.join(' · ') || 'без изменений';
}

// Reverts a batch. Returns the batch, or null when it can't be undone.
export async function undoBatch(batchId, userId) {
  const b = await db.select().from(batches).where(eq(batches.id, Number(batchId))).get();
  if (!b || b.undone) return null;
  if (!(await S.membership(b.spaceId, userId))) return null;
  const entries = Array.isArray(b.undo) ? b.undo.slice().reverse() : [];
  for (const u of entries) {
    try {
      if (u.t === 'del') await db.delete(items).where(eq(items.id, u.id)).run();
      else if (u.t === 'restore') await db.update(items).set({ ...u.prev, updated: S.now() }).where(eq(items.id, u.id)).run();
      else if (u.t === 'reinsert') await db.insert(items).values(u.row).onConflictDoNothing({ target: items.id }).run();
      else if (u.t === 'delsec') {
        const left = await db.$count(items, eq(items.sectionId, u.id));
        if (!left) await db.delete(sections).where(and(eq(sections.id, u.id), eq(sections.spaceId, b.spaceId))).run();
      }
    } catch (e) {
      console.warn('undo step failed', JSON.stringify(u), e && e.message);
    }
  }
  await db.update(batches).set({ undone: true }).where(eq(batches.id, b.id)).run();
  return b;
}

// Records a single manual change from the Mini App as an undoable batch.
export async function recordBatch(spaceId, userId, summary, undo) {
  const [b] = await db.insert(batches)
    .values({ spaceId, userId, summary, undo, undone: false, created: S.now() })
    .returning().run();
  return b.id;
}
