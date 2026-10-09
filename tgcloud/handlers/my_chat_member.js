// The bot was added to (or removed from) a chat.
import { api } from 'sdk';
import * as S from '../lib/store.js';
import { send, ensureBotUsername, sendSetup } from '../lib/telegram.js';

export default async function (upd) {
  const chat = upd.chat;
  if (!chat || chat.type === 'private' || chat.type === 'channel') return;
  const status = upd.new_chat_member && upd.new_chat_member.status;
  if (status !== 'member' && status !== 'administrator') return;
  await ensureBotUsername();

  const owner = await S.getConfig('owner');
  if (!owner) {
    await send(chat.id, 'Сначала владелец бота должен написать мне /start в личку. Потом напишите здесь любое сообщение.');
    return;
  }
  const adder = await S.upsertUser(upd.from, String(upd.from.id) === owner);
  if (!adder.allowed) {
    // Only the owner and people already in the owner's groups may add the bot.
    try {
      await send(chat.id, 'Это закрытый бот, в чужих группах он не работает.');
      await api.leaveChat({ chat_id: chat.id });
    } catch (e) { /* ignore */ }
    return;
  }

  let space = await S.spaceByChat(chat.id);
  if (!space) space = await S.createSpace({ chatId: chat.id, title: chat.title || 'Группа', kind: 'shared', ownerId: upd.from.id });
  await S.ensureMember(space.id, upd.from.id);
  if (!space.setup) await sendSetup(space);
}
