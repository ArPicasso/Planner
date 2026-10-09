import { db } from 'sdk';
import { eq } from 'sdk/db';
import { items } from '../schema.js';
import { caller, requireItem, publicItem } from '../lib/views.js';
import * as S from '../lib/store.js';

export default async function (input, ctx) {
  const user = await caller(ctx);
  const it = await requireItem(input.item, user);
  const done = !!input.done;
  const set = { done, doneBy: done ? user.id : null, updated: S.now() };
  await db.update(items).set(set).where(eq(items.id, it.id)).run();
  return publicItem({ ...it, ...set });
}
