// Inline buttons: template choice after the bot joins a group, and "Отменить" under replies.
import { api } from 'sdk';
import * as S from '../lib/store.js';
import { undoBatch } from '../lib/router.js';
import { escapeHtml as esc } from '../lib/parse.js';
import { openUrl } from '../lib/format.js';

async function answer(q, text) {
  try { await api.answerCallbackQuery({ callback_query_id: q.id, text }); } catch (e) { /* expired */ }
}

export default async function (q) {
  const data = String(q.data || '');
  const msg = q.message;

  if (data.startsWith('tpl:')) {
    const [, spaceId, name] = data.split(':');
    const space = await S.spaceById(spaceId);
    if (!space || !(await S.membership(space.id, q.from.id))) return answer(q, 'Нет доступа');
    if (!space.setup) await S.applyTemplate(space, name);
    const secs = await S.spaceSections(space.id);
    const url = await openUrl(space.id);
    const text = `Пространство «${esc(space.title)}» готово. Разделы: ${secs.map((s) => esc(s.title)).join(', ')}.

Просто пишите сюда, например: <i>матрас 160, шторы в спальню, до 1 ноября подключить интернет</i>. Я разложу по разделам. /help — подробнее.`;
    if (msg) {
      try {
        await api.editMessageText({
          chat_id: msg.chat.id, message_id: msg.message_id, text, parse_mode: 'HTML',
          reply_markup: url ? { inline_keyboard: [[{ text: 'Открыть список', url }]] } : undefined,
        });
      } catch (e) { /* message too old */ }
    }
    return answer(q, 'Готово');
  }

  if (data.startsWith('undo:')) {
    const b = await undoBatch(data.slice(5), q.from.id);
    if (!b) return answer(q, 'Уже отменено или нет доступа');
    if (msg) {
      try {
        await api.editMessageText({
          chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML',
          text: `<s>${esc(b.summary || 'Изменение')}</s> — отменил ${esc(S.shortName(S.displayName(q.from)))}`,
        });
      } catch (e) { /* ignore */ }
    }
    return answer(q, 'Отменено');
  }

  return answer(q);
}
