// Data access shared by handlers and endpoints.
import { db } from 'sdk';
import { eq, and, desc, inArray } from 'sdk/db';
import { config, users, spaces, members, sections, items } from '../schema.js';

export const now = () => Date.now();

/* ---------- config ---------- */
export async function getConfig(key) {
  const row = await db.select().from(config).where(eq(config.key, key)).get();
  return row ? row.value : null;
}
export async function setConfig(key, value) {
  await db.insert(config).values({ key, value: String(value) })
    .onConflictDoUpdate({ target: config.key, set: { value: String(value) } }).run();
}

/* ---------- users ---------- */
export function displayName(u) {
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || 'Без имени';
}
export function shortName(name) {
  return String(name || '').split(/\s+/)[0] || 'Кто-то';
}
// Creates or refreshes a user. `grant` = true marks them allowed; false never revokes.
export async function upsertUser(tgUser, grant = false) {
  const name = displayName(tgUser);
  const username = tgUser.username || null;
  const set = grant ? { name, username, allowed: true } : { name, username };
  await db.insert(users).values({ id: tgUser.id, name, username, allowed: !!grant, created: now() })
    .onConflictDoUpdate({ target: users.id, set }).run();
  return db.select().from(users).where(eq(users.id, tgUser.id)).get();
}
export async function allowUser(userId) {
  await db.update(users).set({ allowed: true }).where(eq(users.id, userId)).run();
}
export async function isOwner(userId) {
  return String(userId) === String(await getConfig('owner'));
}

/* ---------- spaces & members ---------- */
export async function spaceById(id) {
  return db.select().from(spaces).where(eq(spaces.id, Number(id))).get();
}
export async function sharedSpaces() {
  return db.select().from(spaces).where(eq(spaces.kind, 'shared')).all();
}
export async function spaceByChat(chatId) {
  return db.select().from(spaces).where(eq(spaces.chatId, Number(chatId))).get();
}
export async function createSpace({ chatId, title, kind, ownerId }) {
  const [row] = await db.insert(spaces)
    .values({ chatId, title, kind, ownerId, setup: false, created: now() })
    .returning().run();
  await ensureMember(row.id, ownerId);
  return row;
}
export async function ensureMember(spaceId, userId) {
  await db.insert(members).values({ spaceId, userId, lastSeen: now(), joined: now() })
    .onConflictDoNothing({ target: [members.spaceId, members.userId] }).run();
}
export async function membership(spaceId, userId) {
  return db.select().from(members)
    .where(and(eq(members.spaceId, Number(spaceId)), eq(members.userId, Number(userId)))).get();
}
export async function touchSeen(spaceId, userId) {
  await db.update(members).set({ lastSeen: now() })
    .where(and(eq(members.spaceId, spaceId), eq(members.userId, userId))).run();
}
export async function spaceMembers(spaceId) {
  const rows = await db.select().from(members).where(eq(members.spaceId, spaceId)).all();
  if (!rows.length) return [];
  const us = await db.select().from(users).where(inArray(users.id, rows.map((r) => r.userId))).all();
  const byId = Object.fromEntries(us.map((u) => [u.id, u]));
  return rows.map((r) => ({ id: r.userId, name: byId[r.userId]?.name || 'Участник', lastSeen: r.lastSeen }));
}
export async function userSpaces(userId) {
  const ms = await db.select().from(members).where(eq(members.userId, userId)).all();
  if (!ms.length) return [];
  const sp = await db.select().from(spaces).where(inArray(spaces.id, ms.map((m) => m.spaceId))).all();
  const seen = Object.fromEntries(ms.map((m) => [m.spaceId, m.lastSeen || 0]));
  return sp.map((s) => ({ ...s, lastSeen: seen[s.id] }));
}

/* ---------- sections ---------- */
export async function spaceSections(spaceId) {
  const rows = await db.select().from(sections).where(eq(sections.spaceId, spaceId)).all();
  return rows.sort((a, b) => (a.pos - b.pos) || (a.id - b.id));
}
export async function addSection(spaceId, { title, view = 'list', groups = null }) {
  const existing = await spaceSections(spaceId);
  const [row] = await db.insert(sections).values({
    spaceId, title: clip(title, 40), view: ['list', 'plan', 'notes'].includes(view) ? view : 'list',
    groups, pos: existing.length, created: now(),
  }).returning().run();
  return row;
}

export const TEMPLATES = {
  home: [
    { title: 'Купить', view: 'list', groups: ['Кухня', 'Спальня', 'Ванная', 'Гостиная', 'Прихожая', 'Техника', 'Прочее'] },
    { title: 'Дела', view: 'plan' },
    { title: 'Обсудить', view: 'notes' },
  ],
  personal: [
    { title: 'Входящие', view: 'list' },
    { title: 'Дела', view: 'plan' },
  ],
  empty: [
    { title: 'Список', view: 'list' },
  ],
};
export async function applyTemplate(space, name) {
  const tpl = TEMPLATES[name] || TEMPLATES.empty;
  const have = await spaceSections(space.id);
  if (!have.length) for (const s of tpl) await addSection(space.id, s);
  await db.update(spaces).set({ setup: true }).where(eq(spaces.id, space.id)).run();
}

/* ---------- items ---------- */
export async function openItems(spaceId, limit = 300) {
  return db.select().from(items)
    .where(and(eq(items.spaceId, spaceId), eq(items.done, false)))
    .orderBy(desc(items.id)).limit(limit).all();
}
export async function doneItems(spaceId, limit = 60) {
  return db.select().from(items)
    .where(and(eq(items.spaceId, spaceId), eq(items.done, true)))
    .orderBy(desc(items.updated)).limit(limit).all();
}
export async function itemById(id) {
  return db.select().from(items).where(eq(items.id, Number(id))).get();
}

/* ---------- helpers ---------- */
export function clip(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
// Today's date in Munich time as 'YYYY-MM-DD'; falls back to UTC if Intl time zones are missing.
export function today() {
  try {
    const s = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  } catch (e) { /* no ICU time zones in this runtime */ }
  return new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
}
export function weekday(iso) {
  const names = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const d = new Date(iso + 'T12:00:00Z');
  return names[d.getUTCDay()];
}
export function fmtDue(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const mon = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'][m - 1] || '';
  return `${d} ${mon}`;
}
export function fmtPrice(p) {
  if (p == null || Number.isNaN(Number(p))) return '';
  const n = Number(p);
  return (Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ',')) + ' €';
}
