// Every incoming message: commands, or free text that becomes list items.
import { api, db } from 'sdk';
import { eq, and, desc } from 'sdk/db';
import { spaces, batches, users, members } from '../schema.js';
import * as S from '../lib/store.js';
import { processText, undoBatch } from '../lib/router.js';
import { askClaude } from '../lib/ai.js';
import { resultText, resultKeyboard, listText, openUrl, HELP } from '../lib/format.js';
import { escapeHtml as esc } from '../lib/parse.js';
import { send, ensureBotUsername, sendSetup } from '../lib/telegram.js';

export default async function (message) {
  const from = message.from;
  if (!from || from.is_bot) return;
  const raw = message.text ?? message.caption;
  if (!raw) return;
  const text = raw.trim();
  const chat = message.chat;
  const isPrivate = chat.type === 'private';
  await ensureBotUsername();

  const m = text.match(/^\/([a-zA-Z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/);
  const cmd = m ? m[1].toLowerCase() : null;
  const arg = m ? (m[3] || '').trim() : '';
  if (m && m[2]) {
    const mine = await S.getConfig('bot_username');
    if (mine && m[2].toLowerCase() !== mine.toLowerCase()) return; // command for another bot
  }

  // The first person to /start the bot in private becomes its owner.
  let owner = await S.getConfig('owner');
  if (!owner && isPrivate && cmd === 'start') {
    await S.setConfig('owner', String(from.id));
    owner = String(from.id);
    await S.upsertUser(from, true);
    await send(chat.id,
`Ты владелец бота. Три шага до запуска:

1. Пришли сюда <code>/key sk-ant-…</code> — ключ Claude API. Сообщение с ключом я сразу удалю.
2. В @BotFather → бот → Bot Settings → Configure Mini App включи Mini App с адресом, который напечатал <code>tgcloud push</code>.
3. Создай группу с другом, добавь меня и в @BotFather отключи Group Privacy, чтобы я видел обычные сообщения.

Здесь, в личке, — твоё личное пространство. Пиши сюда всё, что держишь в голове.`);
    return;
  }

  const user = await S.upsertUser(from, String(from.id) === owner);
  let space = await S.spaceByChat(chat.id);

  if (isPrivate) {
    if (!user.allowed) {
      await send(chat.id, 'Это закрытый бот. Чтобы пользоваться, попроси владельца добавить тебя в общую группу с ботом.');
      return;
    }
    if (!space) space = await S.createSpace({ chatId: chat.id, title: 'Личное', kind: 'personal', ownerId: from.id });
  } else {
    if (!space) {
      if (!user.allowed) return; // a stranger's group: stay silent
      space = await S.createSpace({ chatId: chat.id, title: chat.title || 'Группа', kind: 'shared', ownerId: from.id });
      await sendSetup(space);
      if (cmd) return;
    } else if (!user.allowed) {
      await S.allowUser(from.id); // members of a known group may use the bot
    }
    if (chat.title && chat.title !== space.title) {
      await db.update(spaces).set({ title: chat.title }).where(eq(spaces.id, space.id)).run();
      space = { ...space, title: chat.title };
    }
  }
  await S.ensureMember(space.id, from.id);

  if (cmd) return handleCommand({ cmd, arg, message, chat, from, user, space, isPrivate, owner });
  if (text.startsWith('//')) return;

  try { await api.sendChatAction({ chat_id: chat.id, action: 'typing' }); } catch (e) { /* not critical */ }
  const res = await processText({ space, user, text });
  if (!res.changed && !res.reply) {
    if (isPrivate) await send(chat.id, 'Не нашёл, что записать. Напиши, что нужно купить, сделать или обсудить.');
    return;
  }
  await send(chat.id, resultText(res, user), {
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    reply_markup: await resultKeyboard(res, space.id),
    disable_notification: true,
  });
}

async function handleCommand({ cmd, arg, message, chat, from, user, space, isPrivate, owner }) {
  const isOwner = String(from.id) === String(owner);

  if (cmd === 'start' || cmd === 'help') {
    await send(chat.id, HELP);
    return;
  }

  if (cmd === 'list') {
    const secs = await S.spaceSections(space.id);
    const open = await S.openItems(space.id, 300);
    const mems = await S.spaceMembers(space.id);
    const url = await openUrl(space.id);
    await send(chat.id, listText(space, secs, open, mems),
      url ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть список', url }]] } } : {});
    return;
  }

  if (cmd === 'app') {
    const url = await openUrl(space.id);
    if (!url) { await send(chat.id, 'Ссылка появится после первой команды боту. Попробуй ещё раз.'); return; }
    await send(chat.id, 'Список с разделами и галочками:', { reply_markup: { inline_keyboard: [[{ text: 'Открыть', url }]] } });
    return;
  }

  if (cmd === 'undo') {
    const last = await db.select().from(batches)
      .where(and(eq(batches.spaceId, space.id), eq(batches.userId, from.id), eq(batches.undone, false)))
      .orderBy(desc(batches.id)).limit(1).get();
    const b = last ? await undoBatch(last.id, from.id) : null;
    await send(chat.id, b ? `Отменил: ${esc(b.summary || 'последнее изменение')}` : 'Нечего отменять.');
    return;
  }

  if (cmd === 'key') {
    if (!isOwner) return;
    if (!isPrivate) {
      try { await api.deleteMessage({ chat_id: chat.id, message_id: message.message_id }); } catch (e) { /* no rights */ }
      await send(chat.id, 'Ключ присылай только в личку боту. Если это был настоящий ключ, отзови его в Claude Console.');
      return;
    }
    try { await api.deleteMessage({ chat_id: chat.id, message_id: message.message_id }); } catch (e) { /* ignore */ }
    if (!/^sk-ant-/.test(arg)) { await send(chat.id, 'Формат: <code>/key sk-ant-…</code>'); return; }
    await S.setConfig('anthropic_key', arg);
    try {
      const out = await askClaude('Ответь одним словом.', 'Скажи: работает', 10);
      await send(chat.id, `Ключ сохранён, Claude отвечает: ${esc(out || '…')}`);
    } catch (e) {
      await send(chat.id, `Ключ сохранён, но тестовый запрос не прошёл (${esc(e.message)}). Проверь ключ и баланс в Claude Console.`);
    }
    return;
  }

  if (cmd === 'model') {
    if (!isOwner) return;
    if (arg) await S.setConfig('model', arg);
    await send(chat.id, `Модель: <code>${esc((await S.getConfig('model')) || 'claude-haiku-5-5')}</code>`);
    return;
  }

  if (cmd === 'setapp') {
    if (!isOwner) return;
    if (!/^https:\/\//.test(arg)) { await send(chat.id, 'Формат: <code>/setapp https://app….tgcloud.ai/</code>'); return; }
    await S.setConfig('app_url', arg);
    try {
      await api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Список', web_app: { url: arg } } });
      await send(chat.id, 'Кнопка «Список» добавлена в меню чата.');
    } catch (e) {
      await send(chat.id, `Не получилось поставить кнопку меню: ${esc(e.description || e.message)}`);
    }
    return;
  }

  if (cmd === 'debug') {
    if (!isOwner) return;
    const us = await db.select().from(users).all();
    const sp = await db.select().from(spaces).all();
    const ms = await db.select().from(members).all();
    const lines = [
      `<b>owner:</b> <code>${esc(String(owner))}</code>`,
      `<b>ключ Claude:</b> ${(await S.getConfig('anthropic_key')) ? 'есть' : 'НЕТ'}`,
      '',
      `<b>users (${us.length}):</b>`,
      ...us.map((u) => `  <code>${u.id}</code> ${esc(u.name)} — allowed=${u.allowed}`),
      '',
      `<b>spaces (${sp.length}):</b>`,
      ...sp.map((x) => `  id=${x.id} chat=<code>${x.chatId}</code> ${x.kind} «${esc(x.title)}» setup=${x.setup}`),
      '',
      `<b>members (${ms.length}):</b>`,
      ...ms.map((m) => `  space=${m.spaceId} user=<code>${m.userId}</code>`),
    ];
    await send(chat.id, lines.join('\n').slice(0, 3900));
    return;
  }
}
