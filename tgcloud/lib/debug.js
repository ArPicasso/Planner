// Диагностика: npx tgcloud run lib/debug
// Печатает состояние базы — кто владелец, у кого есть доступ, какие пространства.
import { db } from 'sdk';
import { users, spaces, members, config } from '../schema.js';

export default async function () {
  const cfg = await db.select().from(config).all();
  console.log('owner:', cfg.find((r) => r.key === 'owner')?.value || '(не задан)');
  console.log('ключ Claude:', cfg.some((r) => r.key === 'anthropic_key') ? 'есть' : 'НЕТ');
  console.log('bot_username:', cfg.find((r) => r.key === 'bot_username')?.value || '(не задан)');

  const u = await db.select().from(users).all();
  console.log(`\nusers (${u.length}):`);
  for (const r of u) console.log(`  ${r.id}  ${r.name}  allowed=${r.allowed}`);

  const s = await db.select().from(spaces).all();
  console.log(`\nspaces (${s.length}):`);
  for (const r of s) console.log(`  id=${r.id}  chat=${r.chatId}  ${r.kind}  "${r.title}"  setup=${r.setup}`);

  const m = await db.select().from(members).all();
  console.log(`\nmembers (${m.length}):`);
  for (const r of m) console.log(`  space=${r.spaceId}  user=${r.userId}`);
}
