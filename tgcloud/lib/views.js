// What the Mini App receives: caller checks and screen payloads.
import { EndpointError, api } from 'sdk';
import * as S from './store.js';
import { allowIfInKnownGroup } from './telegram.js';

export async function caller(ctx) {
  const u = ctx && ctx.initData && ctx.initData.user;
  if (!u) throw new EndpointError('Открой приложение из Telegram.', { code: 'NO_USER' });
  const owner = await S.getConfig('owner');
  let user = await S.upsertUser(u, String(u.id) === owner);
  // То же, что и в личке: членства в общей группе достаточно.
  if (!user.allowed && (await allowIfInKnownGroup(u.id))) user = { ...user, allowed: true };
  if (!user.allowed) throw new EndpointError('Это закрытый бот. Попроси владельца добавить тебя в общую группу.', { code: 'FORBIDDEN' });
  return user;
}

export async function requireSpace(spaceId, user) {
  const space = await S.spaceById(spaceId);
  if (!space) throw new EndpointError('Пространство не найдено.', { code: 'NOT_FOUND' });
  if (!(await S.membership(space.id, user.id))) {
    // A member of the Telegram group who hasn't written there yet still gets in.
    let ok = false;
    if (space.kind === 'shared' && space.chatId) {
      try {
        const cm = await api.getChatMember({ chat_id: space.chatId, user_id: user.id });
        ok = ['creator', 'administrator', 'member', 'restricted'].includes(cm.status);
      } catch (e) { ok = false; }
    }
    if (!ok) throw new EndpointError('Нет доступа к этому пространству.', { code: 'FORBIDDEN' });
    await S.ensureMember(space.id, user.id);
  }
  return space;
}

export async function requireItem(itemId, user) {
  const it = await S.itemById(itemId);
  if (!it) throw new EndpointError('Пункт уже удалён.', { code: 'NOT_FOUND' });
  await requireSpace(it.spaceId, user);
  return it;
}

const pub = (it) => ({
  id: it.id, sectionId: it.sectionId, text: it.text, note: it.note || '', grp: it.grp || '', qty: it.qty || '',
  price: it.price, due: it.due || '', done: !!it.done, claimedBy: it.claimedBy || null,
  addedBy: it.addedBy || null, doneBy: it.doneBy || null, created: it.created, updated: it.updated,
});
export { pub as publicItem };

// Full state of one space. Marks it as seen afterwards, so "new" flags show once.
export async function spaceState(space, user, { markSeen = true } = {}) {
  const me = await S.membership(space.id, user.id);
  const lastSeen = me ? me.lastSeen || 0 : 0;
  const [secs, open, done, mems] = await Promise.all([
    S.spaceSections(space.id), S.openItems(space.id, 500), S.doneItems(space.id, 80), S.spaceMembers(space.id),
  ]);
  if (markSeen) await S.touchSeen(space.id, user.id);
  return {
    space: { id: space.id, title: space.title, kind: space.kind },
    sections: secs.map((s) => ({ id: s.id, title: s.title, view: s.view, groups: Array.isArray(s.groups) ? s.groups : [] })),
    items: open.concat(done).map((it) => ({ ...pub(it), fresh: it.addedBy !== user.id && it.created >= lastSeen })),
    members: mems.map((m) => ({ id: m.id, name: m.name })),
    me: user.id,
  };
}

export async function homeState(user) {
  let mine = await S.userSpaces(user.id);
  if (!mine.some((s) => s.kind === 'personal' && s.ownerId === user.id)) {
    const existing = await S.spaceByChat(user.id);
    if (existing) await S.ensureMember(existing.id, user.id);
    else await S.createSpace({ chatId: user.id, title: 'Личное', kind: 'personal', ownerId: user.id });
    mine = await S.userSpaces(user.id);
  }
  const t = S.today();
  const soonLimit = new Date(Date.parse(t + 'T00:00:00Z') + 14 * 864e5).toISOString().slice(0, 10);
  const spacesOut = [], claimed = [], soon = [], fresh = [];
  const names = {};
  for (const sp of mine) {
    const [open, secs, mems] = await Promise.all([S.openItems(sp.id, 500), S.spaceSections(sp.id), S.spaceMembers(sp.id)]);
    for (const m of mems) names[m.id] = m.name;
    const secTitle = Object.fromEntries(secs.map((s) => [s.id, s.title]));
    const tag = (it) => ({ ...pub(it), spaceId: sp.id, spaceTitle: sp.title, sectionTitle: secTitle[it.sectionId] || '' });
    let freshCount = 0;
    for (const it of open) {
      const isFresh = it.addedBy !== user.id && it.created >= (sp.lastSeen || 0);
      if (isFresh) { freshCount++; fresh.push(tag(it)); }
      if (it.claimedBy === user.id) claimed.push(tag(it));
      if (it.due && it.due <= soonLimit) soon.push(tag(it));
    }
    spacesOut.push({
      id: sp.id, title: sp.title, kind: sp.kind, open: open.length, fresh: freshCount,
      sections: secs.map((s) => s.title), members: mems.length,
    });
  }
  spacesOut.sort((a, b) => (a.kind === b.kind ? b.open - a.open : a.kind === 'shared' ? -1 : 1));
  soon.sort((a, b) => a.due.localeCompare(b.due));
  fresh.sort((a, b) => b.created - a.created);
  return {
    me: { id: user.id, name: user.name },
    today: t,
    spaces: spacesOut,
    claimed: claimed.slice(0, 30),
    soon: soon.slice(0, 30),
    fresh: fresh.slice(0, 20),
    names,
  };
}
