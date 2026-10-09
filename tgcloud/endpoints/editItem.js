import { db, EndpointError } from 'sdk';
import { eq, and } from 'sdk/db';
import { items, sections } from '../schema.js';
import { caller, requireItem, publicItem } from '../lib/views.js';
import { toNumber, toDate } from '../lib/parse.js';
import * as S from '../lib/store.js';

export default async function (input, ctx) {
  const user = await caller(ctx);
  const it = await requireItem(input.item, user);
  const f = input.fields || {};
  const set = { updated: S.now() };
  if ('text' in f) {
    const t = S.clip(f.text, 200);
    if (!t) throw new EndpointError('Название не может быть пустым.', { code: 'EMPTY' });
    set.text = t;
  }
  if ('note' in f) set.note = f.note ? String(f.note).slice(0, 2000) : null;
  if ('grp' in f) set.grp = f.grp ? S.clip(f.grp, 40) : null;
  if ('qty' in f) set.qty = f.qty ? S.clip(f.qty, 40) : null;
  if ('price' in f) set.price = toNumber(f.price);
  if ('due' in f) set.due = toDate(f.due);
  if ('sectionId' in f) {
    const sec = await db.select().from(sections)
      .where(and(eq(sections.id, Number(f.sectionId)), eq(sections.spaceId, it.spaceId))).get();
    if (sec) set.sectionId = sec.id;
  }
  await db.update(items).set(set).where(eq(items.id, it.id)).run();
  return publicItem({ ...it, ...set });
}
