// First call when the Mini App opens: the "Сегодня" screen, plus the space to open
// when the app was launched from a group's "Открыть список" link (start_param "s<id>").
import { caller, homeState, requireSpace } from '../lib/views.js';
import * as S from '../lib/store.js';

export default async function (input, ctx) {
  const user = await caller(ctx);
  // Приложение сообщает свой адрес, чтобы в личке давать кнопку, открывающую Mini App
  // одним тапом. Принимаем только от владельца: иначе участник подменил бы адрес кнопки.
  const origin = String(input.origin || '');
  if (/^https:\/\/[a-z0-9.-]+$/i.test(origin) && (await S.isOwner(user.id)) && (await S.getConfig('app_url')) !== origin) {
    await S.setConfig('app_url', origin);
  }
  const start = String(input.start || (ctx.initData && ctx.initData.start_param) || '');
  let open = null;
  const m = start.match(/^s(\d+)$/);
  if (m) {
    try { open = (await requireSpace(Number(m[1]), user)).id; } catch (e) { open = null; }
  }
  return { home: await homeState(user), open };
}
