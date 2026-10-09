// "Беру": takes the item, or releases it if the caller already has it.
import { db } from 'sdk';
import { eq } from 'sdk/db';
import { items } from '../schema.js';
import { caller, requireItem, publicItem } from '../lib/views.js';
import * as S from '../lib/store.js';

export default async function (input, ctx) {
  const user = await caller(ctx);
  const it = await requireItem(input.item, user);
  const set = { claimedBy: it.claimedBy === user.id ? null : user.id, updated: S.now() };
  await db.update(items).set(set).where(eq(items.id, it.id)).run();
  return publicItem({ ...it, ...set });
}
