// The input bar: free text → Claude sorts it into sections. Returns the fresh space state.
import { EndpointError } from 'sdk';
import { caller, requireSpace, spaceState } from '../lib/views.js';
import { processText } from '../lib/router.js';
import { resultText, resultKeyboard } from '../lib/format.js';
import { send } from '../lib/telegram.js';
import { escapeHtml as esc } from '../lib/parse.js';
import * as S from '../lib/store.js';

export default async function (input, ctx) {
  const user = await caller(ctx);
  const space = await requireSpace(input.space, user);
  const text = String(input.text || '').trim().slice(0, 4000);
  if (!text) throw new EndpointError('Пустое сообщение.', { code: 'EMPTY' });
  const res = await processText({ space, user, text, preferSectionId: input.section || null });

  // Let the other people in a shared space see the change in their chat.
  if (space.kind === 'shared' && space.chatId && res.changed) {
    try {
      await send(space.chatId, `<b>${esc(S.shortName(user.name))}</b> в приложении:\n${resultText(res, user)}`, {
        reply_markup: await resultKeyboard(res, space.id),
        disable_notification: true,
      });
    } catch (e) { console.warn('notify failed', e && e.message); }
  }
  return {
    batchId: res.batchId,
    summary: res.summary || '',
    reply: res.reply || '',
    fallback: res.fallback,
    aiError: res.aiError,
    state: await spaceState(space, user, { markSeen: false }),
  };
}
