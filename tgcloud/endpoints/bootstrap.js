// First call when the Mini App opens: the "Сегодня" screen, plus the space to open
// when the app was launched from a group's "Открыть список" link (start_param "s<id>").
import { caller, homeState, requireSpace } from '../lib/views.js';

export default async function (input, ctx) {
  const user = await caller(ctx);
  const start = String(input.start || (ctx.initData && ctx.initData.start_param) || '');
  let open = null;
  const m = start.match(/^s(\d+)$/);
  if (m) {
    try { open = (await requireSpace(Number(m[1]), user)).id; } catch (e) { open = null; }
  }
  return { home: await homeState(user), open };
}
