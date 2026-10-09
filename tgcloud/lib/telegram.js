// Small Bot API helpers shared by handlers and endpoints.
import { api } from 'sdk';
import * as S from './store.js';
import { escapeHtml as esc } from './parse.js';

export async function send(chat_id, text, extra = {}) {
  return api.sendMessage({ chat_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
}

export async function ensureBotUsername() {
  if (await S.getConfig('bot_username')) return;
  try {
    const me = await api.getMe();
    await S.setConfig('bot_username', me.username);
  } catch (e) { /* retried on the next update */ }
}

export async function sendSetup(space) {
  await send(space.chatId,
    `Готово, это пространство «${esc(space.title)}». Что вы тут планируете?`,
    { reply_markup: { inline_keyboard: [[
      { text: 'Дом и переезд', callback_data: `tpl:${space.id}:home` },
      { text: 'Просто список', callback_data: `tpl:${space.id}:empty` },
    ]] } });
}

// Человека добавили в общую группу, но он там ещё ничего не писал.
// Членства в группе достаточно — спрашиваем у Telegram напрямую.
const IN_CHAT = ['creator', 'administrator', 'member', 'restricted'];
export async function allowIfInKnownGroup(userId) {
  for (const space of await S.sharedSpaces()) {
    if (!space.chatId) continue;
    try {
      const cm = await api.getChatMember({ chat_id: space.chatId, user_id: userId });
      if (!IN_CHAT.includes(cm.status)) continue;
    } catch (e) {
      continue; // бота выгнали из чата или он не может спросить — пробуем следующий
    }
    await S.allowUser(userId);
    await S.ensureMember(space.id, userId);
    return space;
  }
  return null;
}
