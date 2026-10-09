import { EndpointError } from 'sdk';
import { caller, requireSpace, spaceState } from '../lib/views.js';
import * as S from '../lib/store.js';

export default async function (input, ctx) {
  const user = await caller(ctx);
  const space = await requireSpace(input.space, user);
  const title = S.clip(input.title, 40);
  if (!title) throw new EndpointError('Назови раздел.', { code: 'EMPTY' });
  const sec = await S.addSection(space.id, { title, view: input.view });
  return { section: sec.id, state: await spaceState(space, user, { markSeen: false }) };
}
