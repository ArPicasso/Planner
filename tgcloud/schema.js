import { table, integer, text, real, boolean, json, index, uniqueIndex } from 'sdk/db';

// Key/value settings: owner, anthropic_key, model, bot_username, app_url.
export const config = table('config', {
  key:   text('key').primaryKey(),
  value: text('value'),
});

// Telegram users the bot has seen. `allowed` users may use the bot and its AI.
export const users = table('users', {
  id:       integer('id').primaryKey(),          // Telegram user id
  name:     text('name').notNull(),
  username: text('username'),
  allowed:  boolean('allowed').default(false),
  created:  integer('created').notNull(),
});

// A space is one list board: a personal one per user, or a shared one per group chat.
export const spaces = table('spaces', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  chatId:  integer('chat_id'),
  title:   text('title').notNull(),
  kind:    text('kind').notNull(),               // 'personal' | 'shared'
  ownerId: integer('owner_id'),
  setup:   boolean('setup').default(false),      // template chosen
  created: integer('created').notNull(),
}, (t) => ({
  byChat: uniqueIndex('uidx_spaces_chat').on(t.chatId),
}));

export const members = table('members', {
  id:       integer('id').primaryKey({ autoIncrement: true }),
  spaceId:  integer('space_id').notNull(),
  userId:   integer('user_id').notNull(),
  lastSeen: integer('last_seen').default(0),     // ms; items added by others after this are "new"
  joined:   integer('joined').notNull(),
}, (t) => ({
  uniq:   uniqueIndex('uidx_members_space_user').on(t.spaceId, t.userId),
  byUser: index('idx_members_user').on(t.userId),
}));

// A section is a tab inside a space. `view` decides how it is shown:
// 'list' (checklist grouped by `groups`, e.g. rooms), 'plan' (sorted by date), 'notes' (to discuss).
export const sections = table('sections', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  spaceId: integer('space_id').notNull(),
  title:   text('title').notNull(),
  view:    text('view').notNull().default('list'),
  groups:  json('groups'),
  pos:     integer('pos').default(0),
  created: integer('created').notNull(),
}, (t) => ({
  bySpace: index('idx_sections_space').on(t.spaceId),
}));

export const items = table('items', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  spaceId:   integer('space_id').notNull(),
  sectionId: integer('section_id').notNull(),
  text:      text('text').notNull(),
  note:      text('note'),
  grp:       text('grp'),                         // room / category inside a list section
  qty:       text('qty'),
  price:     real('price'),                       // euros
  due:       text('due'),                         // 'YYYY-MM-DD'
  done:      boolean('done').default(false),
  claimedBy: integer('claimed_by'),
  addedBy:   integer('added_by'),
  doneBy:    integer('done_by'),
  batch:     integer('batch'),
  created:   integer('created').notNull(),
  updated:   integer('updated').notNull(),
}, (t) => ({
  bySpace:   index('idx_items_space_done').on(t.spaceId, t.done),
  bySection: index('idx_items_section').on(t.sectionId),
  byClaim:   index('idx_items_claimed').on(t.claimedBy),
}));

// One batch per message / action, so any change can be undone in one tap.
export const batches = table('batches', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  spaceId: integer('space_id').notNull(),
  userId:  integer('user_id'),
  summary: text('summary'),
  undo:    json('undo'),
  undone:  boolean('undone').default(false),
  created: integer('created').notNull(),
});
