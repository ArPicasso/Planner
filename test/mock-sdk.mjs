// In-memory stand-in for the tgcloud `sdk`, covering only what this project uses.
// Lets the handlers and endpoints run locally under `npm test`.

/* ---------- schema DSL ---------- */
function col(type, name, opts = {}) {
  const c = {
    type, name, mode: opts.mode, _pk: false, _auto: false, _default: undefined, _unique: false,
    primaryKey(o = {}) { c._pk = true; c._auto = !!o.autoIncrement; return c; },
    notNull() { return c; }, unique() { c._unique = true; return c; },
    default(v) { c._default = v; return c; }, deprecated() { return c; }, constraint() { return c; },
  };
  return c;
}
export const text = (n, o) => col('text', n, o);
export const integer = (n, o) => col('integer', n, o);
export const real = (n, o) => col('real', n, o);
export const boolean = (n) => col('boolean', n);
export const json = (n) => col('json', n);
const idx = () => ({ on() { return this; }, where() { return this; } });
export const index = idx, uniqueIndex = idx;

export function table(name, cols, extra) {
  const t = { __name: name, __cols: cols, __rows: [], __seq: 0 };
  for (const [k, c] of Object.entries(cols)) { c.key = k; c.table = t; t[k] = c; }
  if (extra) extra(t);
  return t;
}

/* ---------- operators: predicates over JS-keyed rows ---------- */
const val = (r, x) => (x && x.key && x.table ? r[x.key] : x);
export const eq = (a, b) => (r) => val(r, a) === val(r, b) || (val(r, a) == null && val(r, b) == null);
export const ne = (a, b) => (r) => !eq(a, b)(r);
export const gt = (a, b) => (r) => val(r, a) > val(r, b);
export const and = (...ps) => (r) => ps.filter(Boolean).every((p) => p(r));
export const or = (...ps) => (r) => ps.filter(Boolean).some((p) => p(r));
export const inArray = (a, list) => (r) => list.includes(val(r, a));
export const desc = (c) => ({ c, dir: -1 });
export const asc = (c) => ({ c, dir: 1 });
export const sql = (s) => s;

const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
function fill(t, v) {
  const row = {};
  for (const [k, c] of Object.entries(t.__cols)) {
    row[k] = k in v ? v[k] : (c._default !== undefined ? c._default : null);
    if (c.type === 'boolean' && row[k] != null) row[k] = !!row[k];
  }
  const pk = Object.values(t.__cols).find((c) => c._pk);
  if (pk && row[pk.key] == null && pk._auto) row[pk.key] = ++t.__seq;
  if (pk && pk._auto && row[pk.key] > t.__seq) t.__seq = row[pk.key];
  return row;
}
function conflict(t, row, target) {
  const keys = (Array.isArray(target) ? target : [target]).map((c) => c.key);
  return t.__rows.find((r) => keys.every((k) => r[k] === row[k]));
}

function thenable(o, exec) {
  o.then = (res, rej) => Promise.resolve().then(exec).then(res, rej);
  return o;
}

export const db = {
  select() {
    let t, where = () => true, order = null, lim = Infinity;
    const q = {
      from(x) { t = x; return q; },
      where(...p) { where = and(...p); return q; },
      orderBy(...o) { order = o; return q; },
      limit(n) { lim = n; return q; },
      offset() { return q; },
      all: async () => {
        let rows = t.__rows.filter(where);
        if (order) rows = rows.slice().sort((a, b) => {
          for (const o of order) {
            const c = o.c || o, d = o.dir || 1;
            if (a[c.key] < b[c.key]) return -d;
            if (a[c.key] > b[c.key]) return d;
          }
          return 0;
        });
        return rows.slice(0, lim).map(clone);
      },
      get: async () => (await q.all())[0] || null,
    };
    return thenable(q, () => q.all());
  },
  insert(t) {
    let vals = [], onc = null, ret = false;
    const q = {
      values(v) { vals = Array.isArray(v) ? v : [v]; return q; },
      onConflictDoUpdate(o) { onc = { ...o, update: true }; return q; },
      onConflictDoNothing(o) { onc = { ...(o || {}), nothing: true }; return q; },
      returning() { ret = true; return q; },
      run: async () => {
        const out = [];
        for (const v of vals) {
          const row = fill(t, clone(v));
          const pk = Object.values(t.__cols).find((c) => c._pk);
          const target = onc && onc.target ? onc.target : pk;
          const hit = target ? conflict(t, row, target) : null;
          if (hit) {
            if (onc && onc.update) { Object.assign(hit, clone(onc.set)); out.push(clone(hit)); continue; }
            if (onc && onc.nothing) continue;
            throw new Error(`UNIQUE constraint failed: ${t.__name}`);
          }
          t.__rows.push(row); out.push(clone(row));
        }
        return ret ? out : { rowsAffected: out.length, lastInsertRowid: out.length ? out[out.length - 1].id : 0, rows: [] };
      },
    };
    return thenable(q, () => q.run());
  },
  update(t) {
    let set = {}, where = () => true;
    const q = {
      set(s) { set = s; return q; },
      where(...p) { where = and(...p); return q; },
      run: async () => {
        const rows = t.__rows.filter(where);
        for (const r of rows) Object.assign(r, clone(set));
        return { rowsAffected: rows.length, lastInsertRowid: 0, rows: [] };
      },
    };
    return thenable(q, () => q.run());
  },
  delete(t) {
    let where = () => true;
    const q = {
      where(...p) { where = and(...p); return q; },
      run: async () => {
        const before = t.__rows.length;
        t.__rows = t.__rows.filter((r) => !where(r));
        return { rowsAffected: before - t.__rows.length, lastInsertRowid: 0, rows: [] };
      },
    };
    return thenable(q, () => q.run());
  },
  async $count(t, where) { return t.__rows.filter(where || (() => true)).length; },
};

/* ---------- Bot API, fetch, errors ---------- */
export const calls = [];
let msgId = 1000;
// Кто в каких групповых чатах. Тесты наполняют через joinChat.
export const chatMembers = new Map();
export const joinChat = (chatId, ...userIds) => {
  const set = chatMembers.get(chatId) || new Set();
  for (const id of userIds) set.add(id);
  chatMembers.set(chatId, set);
};
const inChat = (chatId, userId) => !!chatMembers.get(chatId)?.has(userId);

export const api = new Proxy({}, {
  get(_, method) {
    return async (params) => {
      calls.push({ method, params });
      if (method === 'getMe') return { id: 1, username: 'atlas_test_bot' };
      if (method === 'sendMessage') return { message_id: ++msgId, chat: { id: params.chat_id } };
      if (method === 'getChatMember') return { status: inChat(params.chat_id, params.user_id) ? 'member' : 'left' };
      return true;
    };
  },
});

export const claude = { next: null, requests: [] };
export async function fetch(url, opts) {
  claude.requests.push({ url, body: JSON.parse(opts.body) });
  const reply = typeof claude.next === 'function' ? claude.next(JSON.parse(opts.body)) : claude.next;
  if (reply === 'HTTP_401') return { ok: false, status: 401, text: async () => 'invalid x-api-key' };
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: reply }] }) };
}

export class EndpointError extends Error {
  constructor(description, parameters) { super(description); this.description = description; this.parameters = parameters; }
}
export class BotApiError extends Error {}

export default db;
