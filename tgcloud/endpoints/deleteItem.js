import { db } from 'sdk';
import { eq } from 'sdk/db';
import { items } from '../schema.js';
import { caller, requireItem } from '../lib/views.js';
import { recordBatch } from '../lib/router.js';

export default async function (input, ctx) {
  const user = await caller(ctx);
  const it = await requireItem(input.item, user);
  await db.delete(items).where(eq(items.id, it.id)).run();
  const batchId = await recordBatch(it.spaceId, user.id, `убрано: ${it.text}`, [{ t: 'reinsert', row: it }]);
  return { batchId };
}
