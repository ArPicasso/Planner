// Telegram message texts and keyboards.
import { escapeHtml as esc } from './parse.js';
import * as S from './store.js';

// Reply to a processed message: what landed where, plus Claude's answer for questions.
export function resultText(res, author) {
  const out = [];
  const bySection = new Map();
  for (const l of res.lines) {
    if (l.k !== 'add') continue;
    const key = l.section.title;
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(l.item);
  }
  for (const [title, list] of bySection) {
    const names = list.map((it) => {
      const extra = [it.grp, it.qty, it.price != null ? S.fmtPrice(it.price) : '', it.due ? 'до ' + S.fmtDue(it.due) : '']
        .filter(Boolean).join(', ');
      return esc(it.text) + (extra ? ` <i>(${esc(extra)})</i>` : '');
    });
    out.push(`<b>${esc(title)}</b> +${list.length}: ${names.join(' · ')}`);
  }
  for (const l of res.lines) {
    const it = l.item;
    if (l.k === 'done') out.push(`✓ ${esc(it.text)}${it.price != null ? ' — ' + S.fmtPrice(it.price) : ''}`);
    else if (l.k === 'undone') out.push(`↺ ${esc(it.text)} снова открыт`);
    else if (l.k === 'claim') out.push(`→ ${esc(it.text)}: берёт ${esc(S.shortName(author.name))}`);
    else if (l.k === 'unclaim') out.push(`↩ ${esc(it.text)}: снова свободен`);
    else if (l.k === 'update') out.push(`✎ ${esc(it.text)}`);
    else if (l.k === 'delete') out.push(`✕ ${esc(it.text)}`);
    else if (l.k === 'section') out.push(`Новый раздел: <b>${esc(l.section.title)}</b>`);
  }
  if (res.reply) out.push(esc(res.reply));
  if (res.fallback && res.changed) {
    out.push(res.aiError === 'no_key'
      ? '<i>Claude не подключён, записал как есть. Владелец: /key в личке с ботом.</i>'
      : '<i>Claude не ответил, записал как есть.</i>');
  }
  return out.join('\n');
}

export async function openUrl(spaceId) {
  const username = await S.getConfig('bot_username');
  return username ? `https://t.me/${username}?startapp=s${spaceId}` : null;
}

// Адрес Mini App, если владелец его задал (/setapp) или приложение само его сообщило.
export async function appUrl(spaceId) {
  const raw = ((await S.getConfig('app_url')) || '').trim();
  if (!/^https:\/\/[^\s]+$/.test(raw)) return null;
  const [beforeHash] = raw.split('#');
  const [path, query = ''] = beforeHash.split('?');
  // Telegram отклоняет web_app-URL без пути перед query, поэтому нужен хотя бы "/":
  // location.origin приходит как "https://host" — без слеша на конце.
  const base = path.slice('https://'.length).includes('/') ? path : `${path}/`;
  return `${base}?${query ? `${query}&` : ''}s=${spaceId}`;
}

// Кнопка открытия списка. В личке — web_app: Mini App открывается одним тапом.
// В группах Bot API запрещает web_app-кнопки, поэтому там остаётся ссылка t.me,
// а она показывает промежуточный экран запуска — обойти это нельзя.
export async function openButton(spaceId, isPrivate, text = 'Открыть список') {
  if (isPrivate) {
    const direct = await appUrl(spaceId);
    if (direct) return { text, web_app: { url: direct } };
  }
  const url = await openUrl(spaceId);
  return url ? { text, url } : null;
}

export async function resultKeyboard(res, spaceId, isPrivate = false) {
  const row = [];
  if (res.batchId) row.push({ text: 'Отменить', callback_data: `undo:${res.batchId}` });
  const btn = await openButton(spaceId, isPrivate);
  if (btn) row.push(btn);
  return row.length ? { inline_keyboard: [row] } : undefined;
}

// Plain-text view of open items for /list.
export function listText(space, secs, open, mems) {
  const nameOf = (id) => S.shortName(mems.find((m) => m.id === id)?.name);
  const out = [`<b>${esc(space.title)}</b>`];
  let shown = 0;
  for (const s of secs) {
    const list = open.filter((it) => it.sectionId === s.id);
    if (!list.length) continue;
    out.push('', `<b>${esc(s.title)}</b> · ${list.length}`);
    const sorted = s.view === 'plan'
      ? list.slice().sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'))
      : list.slice().sort((a, b) => (a.grp || 'яяя').localeCompare(b.grp || 'яяя') || a.id - b.id);
    for (const it of sorted) {
      if (shown >= 60) break;
      const meta = [it.grp && s.view === 'list' ? it.grp : '', it.qty, it.price != null ? S.fmtPrice(it.price) : '',
        it.due ? 'до ' + S.fmtDue(it.due) : '', it.claimedBy ? '→ ' + nameOf(it.claimedBy) : ''].filter(Boolean).join(', ');
      out.push(`• ${esc(it.text)}${meta ? ` <i>(${esc(meta)})</i>` : ''}`);
      shown++;
    }
  }
  if (out.length === 1) out.push('', 'Пусто. Напиши, что нужно купить или сделать.');
  return out.join('\n');
}

export const HELP = `<b>Как пользоваться</b>
Пиши как обычно, я разложу по разделам:
• <i>матрас 160, шторы в спальню, роутер</i> → 3 покупки
• <i>до 1 ноября подключить интернет</i> → дело со сроком
• <i>купил роутер 45€</i> → закрою пункт и запишу цену
• <i>беру шторы</i> → пункт закрепится за тобой
• <i>что осталось купить?</i> → отвечу по списку

Сообщения, начинающиеся с //, я пропускаю.
/list — список текстом · /app — открыть приложение · /undo — отменить последнее`;
