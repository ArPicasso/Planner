// Local end-to-end run against the in-memory SDK mock: node test/run.mjs
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);

const sdk = await import('./mock-sdk.mjs');
const { calls, claude } = sdk;
const H = (p) => import(new URL(`../tgcloud/${p}.js`, import.meta.url)).then((m) => m.default);
const message = await H('handlers/message');
const callback = await H('handlers/callback_query');
const chatMember = await H('handlers/my_chat_member');
const ep = {};
for (const n of ['bootstrap', 'getSpace', 'addText', 'setDone', 'claim', 'editItem', 'deleteItem', 'addSection', 'undo']) ep[n] = await H(`endpoints/${n}`);
const schema = await import('../tgcloud/schema.js');

let fails = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) fails++; };
const last = (method) => [...calls].reverse().find((c) => c.method === method);
const PAVEL = { id: 111, first_name: 'Павел', username: 'pavel' };
const MISHA = { id: 222, first_name: 'Миша' };
const STRANGER = { id: 333, first_name: 'Чужой' };
const GROUP = { id: -500, type: 'supergroup', title: 'Квартира Мюнхен' };
let mid = 1;
const msg = (from, chat, text) => message({ message_id: mid++, from, chat, text, date: 0 }, {});
const priv = (u) => ({ id: u.id, type: 'private', first_name: u.first_name });
const ctxOf = (u, start) => ({ initData: { user: u, start_param: start } });

// 1. Owner bootstrap
await msg(PAVEL, priv(PAVEL), '/start');
ok(schema.config.__rows.find((r) => r.key === 'owner')?.value === '111', 'first /start makes Pavel the owner');

// 2. API key
claude.next = 'Работает';
await msg(PAVEL, priv(PAVEL), '/key sk-ant-test-123');
ok(schema.config.__rows.find((r) => r.key === 'anthropic_key')?.value === 'sk-ant-test-123', '/key stores the key');
ok(calls.some((c) => c.method === 'deleteMessage'), '/key deletes the message with the key');

// 3. Bot added to group, template chosen
await chatMember({ chat: GROUP, from: PAVEL, new_chat_member: { status: 'member', user: { id: 1 } } }, {});
const space = schema.spaces.__rows.find((s) => s.chatId === GROUP.id);
ok(space && space.kind === 'shared', 'group space created when the owner adds the bot');
await callback({ id: 'q1', data: `tpl:${space.id}:home`, from: PAVEL, message: { message_id: 9, chat: GROUP } }, {});
const secs = schema.sections.__rows.filter((s) => s.spaceId === space.id);
ok(secs.map((s) => s.title).join(',') === 'Купить,Дела,Обсудить', 'home template: Купить, Дела, Обсудить');
const [BUY, TODO] = secs.map((s) => s.id);

// 4. Small talk is ignored
claude.next = JSON.stringify({ actionable: false, ops: [], reply: '' });
const before = calls.length;
await msg(MISHA, GROUP, 'привет, как дела?');
ok(!calls.slice(before).some((c) => c.method === 'sendMessage'), 'small talk gets no reply');
ok(schema.users.__rows.find((u) => u.id === 222)?.allowed === true, 'friend in the group becomes allowed');

// 5. Free text → items in the right sections
claude.next = (req) => {
  ok(req.messages[0].content.includes(`[${BUY}] Купить`), 'Claude sees the sections with ids');
  return JSON.stringify({ actionable: true, reply: '', ops: [
    { op: 'add', section: BUY, text: 'Матрас', qty: '160×200', group: 'Спальня' },
    { op: 'add', section: BUY, text: 'Шторы', group: 'Спальня' },
    { op: 'add', section: BUY, text: 'Роутер', group: 'Техника' },
    { op: 'add', section: TODO, text: 'Подключить интернет', due: '2026-11-01' },
    { op: 'add', section: TODO, text: 'Забрать ключи', due: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) },
  ] });
};
await msg(PAVEL, GROUP, 'матрас 160, шторы в спальню, роутер; до 1 ноября подключить интернет');
ok(schema.items.__rows.length === 5, '5 items created from one message');
const reply = last('sendMessage');
ok(/Купить<\/b> \+3/.test(reply.params.text) && /Дела<\/b> \+2/.test(reply.params.text), 'reply groups items by section');
ok(reply.params.reply_markup.inline_keyboard[0].some((b) => b.callback_data?.startsWith('undo:')), 'reply has an undo button');
ok(reply.params.reply_markup.inline_keyboard[0].some((b) => b.url === `https://t.me/atlas_test_bot?startapp=s${space.id}`), 'reply has an open-list link');
const router = schema.items.__rows.find((i) => i.text === 'Роутер');

// 6. Claim and done by the friend
claude.next = JSON.stringify({ actionable: true, ops: [{ op: 'claim', item: router.id }] });
await msg(MISHA, GROUP, 'беру роутер');
ok(schema.items.__rows.find((i) => i.id === router.id).claimedBy === 222, '"беру роутер" claims it for Misha');
claude.next = JSON.stringify({ actionable: true, ops: [{ op: 'done', item: router.id, price: 45 }] });
await msg(MISHA, GROUP, 'купил роутер 45€');
let r = schema.items.__rows.find((i) => i.id === router.id);
ok(r.done === true && r.price === 45 && r.doneBy === 222, '"купил роутер 45€" closes it with the price');

// 7. Undo via button
const undoBtn = last('sendMessage').params.reply_markup.inline_keyboard[0].find((b) => b.callback_data?.startsWith('undo:'));
await callback({ id: 'q2', data: undoBtn.callback_data, from: MISHA, message: { message_id: 10, chat: GROUP } }, {});
r = schema.items.__rows.find((i) => i.id === router.id);
ok(r.done === false && r.price == null, 'undo restores the item');

// 8. Question answered from the list
claude.next = JSON.stringify({ actionable: true, ops: [], reply: 'Осталось: матрас, шторы, роутер.' });
await msg(PAVEL, GROUP, 'что осталось купить?');
ok(/Осталось: матрас/.test(last('sendMessage').params.text), 'questions get an answer');

// 9. Mini App: bootstrap from the group link
const boot = await ep.bootstrap({}, ctxOf(MISHA, `s${space.id}`));
ok(boot.open === space.id, 'bootstrap opens the space from start_param');
ok(boot.home.spaces.some((s) => s.kind === 'personal'), 'a personal space is created for the friend');
ok(boot.home.claimed.some((i) => i.id === router.id), '"На мне" lists the claimed router');
ok(boot.home.soon.some((i) => i.text === 'Забрать ключи') && !boot.home.soon.some((i) => i.due === '2026-11-01'), '"Скоро" lists tasks due within 2 weeks only');
const st = await ep.getSpace({ id: space.id }, ctxOf(MISHA));
ok(st.items.length === 5 && st.sections.length === 3, 'getSpace returns items and sections');
ok(st.items.filter((i) => i.fresh).length === 5, 'items added by Pavel are flagged new for Misha');
const st2 = await ep.getSpace({ id: space.id }, ctxOf(MISHA));
ok(st2.items.every((i) => !i.fresh), 'new flags clear after viewing');

// 10. addText with Claude down → plain split into the open section, group notified
claude.next = 'HTTP_401';
const before2 = calls.length;
const add = await ep.addText({ space: space.id, section: BUY, text: 'сковородка, нож, доска' }, ctxOf(PAVEL));
ok(add.fallback && add.state.items.filter((i) => i.sectionId === BUY && !i.done).length === 6, 'fallback adds 3 items to the open section');
ok(calls.slice(before2).some((c) => c.method === 'sendMessage' && c.params.chat_id === GROUP.id && /в приложении/.test(c.params.text)), 'group is told about app additions');

// 11. Item actions from the app
const pan = add.state.items.find((i) => i.text === 'сковородка');
ok((await ep.claim({ item: pan.id }, ctxOf(PAVEL))).claimedBy === 111, 'claim from app');
ok((await ep.claim({ item: pan.id }, ctxOf(PAVEL))).claimedBy === null, 'second tap releases it');
ok((await ep.setDone({ item: pan.id, done: true }, ctxOf(PAVEL))).done === true, 'tick from app');
const edited = await ep.editItem({ item: pan.id, fields: { text: 'Сковорода 28 см', price: '24,90', grp: 'Кухня', due: 'bad' } }, ctxOf(PAVEL));
ok(edited.text === 'Сковорода 28 см' && edited.price === 24.9 && edited.grp === 'Кухня' && edited.due === '', 'edit sanitizes fields');
const del = await ep.deleteItem({ item: pan.id }, ctxOf(PAVEL));
ok(!schema.items.__rows.some((i) => i.id === pan.id), 'delete removes it');
await ep.undo({ batch: del.batchId }, ctxOf(PAVEL));
ok(schema.items.__rows.some((i) => i.id === pan.id && i.text === 'Сковорода 28 см'), 'undo brings it back');
const sec = await ep.addSection({ space: space.id, title: 'Расходы', view: 'list' }, ctxOf(PAVEL));
ok(sec.state.sections.some((s) => s.title === 'Расходы'), 'add section');

// 12. Access control
await msg(STRANGER, priv(STRANGER), '/start');
ok(/закрытый бот/.test(last('sendMessage').params.text), 'stranger gets the closed-bot message');
let denied = false;
try { await ep.getSpace({ id: space.id }, ctxOf(STRANGER)); } catch (e) { denied = e.parameters?.code === 'FORBIDDEN'; }
ok(denied, 'stranger cannot open the space from the app');
let denied2 = false;
const pavelPersonal = schema.spaces.__rows.find((s) => s.chatId === 111);
try { await ep.getSpace({ id: pavelPersonal.id }, ctxOf(MISHA)); } catch (e) { denied2 = true; }
ok(denied2, "friend cannot open Pavel's personal space");

// 13. /list
await msg(PAVEL, GROUP, '/list');
ok(/Купить<\/b> · /.test(last('sendMessage').params.text), '/list prints sections');

// 14. Добавили в группу, но человек там ещё ничего не писал
const KATE = { id: 444, first_name: 'Катя' };
sdk.joinChat(GROUP.id, KATE.id);
await msg(KATE, priv(KATE), '/start');
ok(!/закрытый бот/.test(last('sendMessage').params.text), 'a group member gets in without writing in the group');
ok(schema.users.__rows.find((u) => u.id === 444)?.allowed === true, 'and is marked allowed');
let kateApp = false;
try { await ep.getSpace({ id: space.id }, ctxOf(KATE)); kateApp = true; } catch (e) { kateApp = false; }
ok(kateApp, 'and can open the shared space in the Mini App');
ok(schema.members.__rows.some((m) => m.spaceId === space.id && m.userId === 444), 'and is added to the space members');

// 15. Кто не состоит ни в одной группе — по-прежнему чужой
const OUTSIDER = { id: 555, first_name: 'Посторонний' };
await msg(OUTSIDER, priv(OUTSIDER), '/start');
ok(/закрытый бот/.test(last('sendMessage').params.text), 'a non-member is still refused');
ok(schema.users.__rows.find((u) => u.id === 555)?.allowed === false, 'and stays not allowed');

// 16. Бот узнаёт адрес Mini App от владельца
await ep.bootstrap({ origin: 'https://app1.tgcloud.ai' }, ctxOf(PAVEL));
const appCfg = () => schema.config.__rows.find((r) => r.key === 'app_url')?.value;
ok(appCfg() === 'https://app1.tgcloud.ai', 'the owner opening the app teaches the bot its URL');
await ep.bootstrap({ origin: 'https://evil.example.com' }, ctxOf(MISHA));
ok(appCfg() === 'https://app1.tgcloud.ai', 'a non-owner cannot change the stored app URL');

// 17. Кнопка: web_app в личке (один тап), ссылка t.me в группе (Bot API запрещает web_app)
claude.next = JSON.stringify({ actionable: true, ops: [], reply: 'Ок.' });
await msg(PAVEL, GROUP, 'что осталось?');
const gBtn = last('sendMessage').params.reply_markup.inline_keyboard[0].find((b) => /Открыть/.test(b.text));
ok(!!gBtn.url && !gBtn.web_app, 'in a group the button stays a t.me link');

claude.next = JSON.stringify({ actionable: true, ops: [], reply: 'Ок.' });
await msg(PAVEL, priv(PAVEL), 'что осталось?');
const pBtn = last('sendMessage').params.reply_markup.inline_keyboard[0].find((b) => /Открыть/.test(b.text));
ok(!!pBtn.web_app && !pBtn.url, 'in private it is a one-tap web_app button');
ok(/^https:\/\/app1\.tgcloud\.ai\?s=\d+$/.test(pBtn.web_app.url), 'and carries the space id as ?s=');

console.log(fails ? `\n${fails} FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
