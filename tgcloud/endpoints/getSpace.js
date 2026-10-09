import { caller, requireSpace, spaceState } from '../lib/views.js';

export default async function (input, ctx) {
  const user = await caller(ctx);
  const space = await requireSpace(input.id, user);
  return spaceState(space, user);
}
