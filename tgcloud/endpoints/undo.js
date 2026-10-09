import { EndpointError } from 'sdk';
import { caller, requireSpace, spaceState } from '../lib/views.js';
import { undoBatch } from '../lib/router.js';

export default async function (input, ctx) {
  const user = await caller(ctx);
  const b = await undoBatch(input.batch, user.id);
  if (!b) throw new EndpointError('Уже отменено.', { code: 'GONE' });
  const space = await requireSpace(b.spaceId, user);
  return { state: await spaceState(space, user, { markSeen: false }) };
}
