const assert = require('assert');
const { Telegram } = require('telegraf');
const { createDb, migrateOnce, formatStats, authHeaders, NO_DB_STATS_TEXT, MIGRATION_KEY } = require('./db');
const { createFakeSupabase } = require('./fake-supabase');
const { createSupportBot } = require('./support-bot');

const quiet = { log() {}, warn() {}, error() {} };
const KEY = 'sb_secret_TEST_ONLY';

// Telegram в тестах не вызываем по-настоящему.
const apiHandlers = new Map();
Telegram.prototype.callApi = async function (method, payload) {
  const handler = apiHandlers.get(this.token);
  if (!handler) throw new Error('unexpected Telegram call in test: ' + method);
  return handler(method, payload);
};

function makeDb(fake) {
  return createDb({ url: 'https://fake.supabase.co/', key: KEY, fetch: fake.fetch, log: quiet });
}

function testConfig() {
  assert.strictEqual(createDb({ url: '', key: 'x' }), null, 'no URL — no database');
  assert.strictEqual(createDb({ url: 'https://x.supabase.co', key: '' }), null, 'no key — no database');
  assert.deepStrictEqual(authHeaders('sb_secret_abc'), { apikey: 'sb_secret_abc' }, 'new secret key goes only to apikey');
  assert.deepStrictEqual(authHeaders('eyJhbGc.x.y'), { apikey: 'eyJhbGc.x.y', Authorization: 'Bearer eyJhbGc.x.y' });
  assert.ok(/SUPABASE_URL/.test(NO_DB_STATS_TEXT) && /SUPABASE_SERVICE_KEY/.test(NO_DB_STATS_TEXT));
}

async function testCrud() {
  const fake = createFakeSupabase({ key: KEY });
  const db = makeDb(fake);
  assert.strictEqual(fake.requests.length, 0);

  assert.strictEqual(await db.touchUser({ id: 5, username: 'u5', language_code: 'en' }, 'files'), true);
  assert.strictEqual(await db.touchUser({ id: 5, username: 'u5', language_code: 'en' }, 'files'), false, 'touch is throttled');
  assert.strictEqual(await db.touchUser({ id: 6, is_bot: true }, 'files'), false, 'bots are not users');
  assert.strictEqual(fake.tables.bot_users.length, 1);
  assert.ok(fake.requests[0].path.startsWith('/rest/v1/rpc/touch_user'));
  assert.strictEqual(fake.requests[0].headers.apikey, KEY);
  assert.strictEqual(fake.requests[0].headers.Authorization, undefined);

  assert.strictEqual(await db.saveLink('6', [40, 41], '0.24'), true);
  assert.strictEqual(await db.saveLink('6', [42], '0.24'), true);
  assert.deepStrictEqual(await db.loadLinks(), { 6: [42] }, 'link upsert replaces the old posts');

  await db.addBan(77, 9000);
  await db.setMute(88, Date.now() + 60000);
  await db.setMute(89, Date.now() - 1000);
  const t1 = await db.supportUserMessage(10, 'help', 'en');
  const t2 = await db.supportUserMessage(10, null, 'en');
  assert.strictEqual(t1, t2, 'one open ticket per user');
  await db.addRoutes([{ admin_chat_id: 9000, admin_message_id: 501, user_id: 10, ticket_id: t1, topic: 'help', language: 'en' }]);
  const sup = await db.loadSupport();
  assert.deepStrictEqual(sup.banned, [77]);
  assert.deepStrictEqual(Object.keys(sup.mutes), ['88'], 'expired mutes are not loaded');
  assert.deepStrictEqual(sup.routes, { '9000:501': 10 });
  assert.strictEqual(await db.userLanguage(10), 'en');
  assert.strictEqual(await db.userLanguage(5), 'en', 'falls back to bot_users.language');
  assert.strictEqual(await db.userLanguage(12345), null);

  await db.removeBan(77);
  assert.deepStrictEqual((await db.loadSupport()).banned, []);

  await db.recordDownload(5, 2, 'android', true);
  await db.recordDownload(5, 2, 'android', true);
  await db.recordDownload(6, 3, 'android', false);
  await db.ticketAnswered(10);
  const stats = await db.stats();
  assert.strictEqual(stats.downloads_7d, 2);
  assert.strictEqual(stats.tickets_open, 0, 'answered ticket is not open');
  const text = formatStats(stats, (id) => ({ 2: 'Eternum' }[id] || 'Игра ' + id), 'ru');
  assert.ok(text.includes('Пользователи: всего 1'));
  assert.ok(text.includes('1. Eternum — 2'));
  assert.ok(text.includes('Открытые обращения в поддержку: 0'));
  assert.ok(!/@[A-Za-z0-9_]{3,}/.test(text), 'no handles in stats');
}

async function testFailSoft() {
  const fake = createFakeSupabase({ key: KEY });
  const db = makeDb(fake);
  fake.state.down = true;
  assert.strictEqual(await db.saveLink('2', [3]), false);
  assert.strictEqual(await db.loadLinks(), null);
  assert.strictEqual(await db.loadSupport(), null);
  assert.strictEqual(await db.stats(), null);
  assert.strictEqual(await db.recordDownload(1, 2), false);
  assert.strictEqual(await db.supportUserMessage(1, 'help', 'ru'), null);
  assert.ok(formatStats(null, String, 'ru').includes('Не удалось'));
  fake.state.down = false;
  const wrong = createDb({ url: 'https://fake.supabase.co', key: 'sb_secret_WRONG', fetch: fake.fetch, log: quiet });
  assert.strictEqual(await wrong.ping(), false, 'wrong key fails softly');
  assert.strictEqual(await db.ping(), true);
}

async function testMigration() {
  const fake = createFakeSupabase({ key: KEY });
  const db = makeDb(fake);
  const channelState = {
    support: { banned: [77, 555], mutes: { 88: Date.now() + 60000 }, routes: { '9000:12': 10 } },
    links: { 2: [3], 6: [40, 41] }
  };
  const r1 = await migrateOnce(db, channelState, { skipBanIds: [555], versions: { 6: '0.24' } });
  assert.strictEqual(r1.migrated, true);
  assert.deepStrictEqual(fake.tables.support_bans.map((r) => r.telegram_id), [77], 'BANNED_IDS are not copied into the database');
  assert.strictEqual(fake.tables.file_links.length, 2);
  assert.strictEqual(fake.tables.file_links.find((r) => r.game_id === 6).version, '0.24');
  assert.strictEqual(fake.tables.support_routes.length, 1);
  assert.ok(fake.tables.app_meta.find((r) => r.key === MIGRATION_KEY));
  const r2 = await migrateOnce(db, { support: { banned: [1, 2, 3] }, links: { 9: [1] } });
  assert.strictEqual(r2.reason, 'already', 'migration runs only once');
  assert.strictEqual(fake.tables.support_bans.length, 1);

  const fake2 = createFakeSupabase({ key: KEY });
  const db2 = makeDb(fake2);
  await db2.addBan(1);
  const r3 = await migrateOnce(db2, channelState);
  assert.strictEqual(r3.reason, 'not-empty', 'a non-empty database is not overwritten');
  assert.strictEqual(fake2.tables.file_links.length, 0);

  const fake3 = createFakeSupabase({ key: KEY });
  const db3 = makeDb(fake3);
  fake3.state.down = true;
  assert.strictEqual((await migrateOnce(db3, channelState)).reason, 'db-error');
  fake3.state.down = false;
  assert.strictEqual((await migrateOnce(db3, channelState)).migrated, true, 'retried on the next start');
}

let tokenSeq = 0;
function makeSupport(hooks) {
  const token = (700 + ++tokenSeq) + ':TEST';
  const support = createSupportBot({ token, adminIds: [9000], statePath: null, replaceCommandReply: async (c, t, k, fn) => fn(), hooks });
  support.bot.botInfo = { id: 333, is_bot: true, first_name: 'Support', username: 'support_test_bot' };
  const calls = [];
  let mid = 100;
  apiHandlers.set(token, async (method, payload) => {
    calls.push({ method, payload });
    if (['sendMessage', 'copyMessage'].includes(method)) return { message_id: ++mid };
    return true;
  });
  let uid = 1; let m = 1;
  const send = (from, text, more) => support.bot.handleUpdate({
    update_id: uid++,
    message: Object.assign({
      message_id: m++, from, chat: { id: from.id, type: 'private' }, date: 1, text,
      entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined
    }, more || {})
  });
  return { support, calls, send };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

async function testSupportWithDb() {
  const fake = createFakeSupabase({ key: KEY });
  const db = makeDb(fake);
  const hooks = {
    onUser: (from) => db.touchUser(from, 'support'),
    onBan: (u, a) => db.addBan(u, a),
    onUnban: (u) => db.removeBan(u),
    onMute: (u, until) => db.setMute(u, until),
    onTicketMessage: (u, topic, lang) => db.supportUserMessage(u, topic, lang),
    onRoutes: (rows) => db.addRoutes(rows),
    onAnswered: (u) => db.ticketAnswered(u),
    lookupLang: (u) => db.userLanguage(u),
    statsText: async () => formatStats(await db.stats(), String, 'ru')
  };
  const admin = { id: 9000, is_bot: false, first_name: 'Owner', language_code: 'ru' };
  const user = { id: 10, is_bot: false, first_name: 'Ann', language_code: 'en' };
  const a = makeSupport(hooks);
  await a.send(user, 'Need help');
  await tick();
  assert.strictEqual(fake.tables.support_tickets.length, 1);
  assert.strictEqual(fake.tables.support_tickets[0].language, 'en');
  assert.strictEqual(fake.tables.support_routes.length, 2, 'header and copy routes are saved');
  assert.ok(fake.tables.support_routes.every((r) => r.ticket_id === fake.tables.support_tickets[0].id && r.language === 'en'));
  assert.ok(fake.tables.bot_users.some((u) => u.telegram_id === 10 && u.first_bot === 'support'));

  await a.send(admin, '/ban 77');
  await a.send({ id: 50, is_bot: false, first_name: 'S', language_code: 'ru' }, 'm1');
  await a.send({ id: 50, is_bot: false, first_name: 'S', language_code: 'ru' }, 'm2');
  await a.send({ id: 50, is_bot: false, first_name: 'S', language_code: 'ru' }, 'm3');
  await a.send({ id: 50, is_bot: false, first_name: 'S', language_code: 'ru' }, 'm4');
  await tick();
  assert.deepStrictEqual(fake.tables.support_bans.map((r) => r.telegram_id), [77]);

  a.calls.length = 0;
  await a.send(admin, '/stats');
  const statsMsg = a.calls.find((c) => c.method === 'sendMessage' && c.payload.chat_id === 9000);
  assert.ok(statsMsg && statsMsg.payload.text.includes('Открытые обращения в поддержку: 2'), 'stats for admin');
  a.calls.length = 0;
  await a.send(user, '/stats');
  assert.ok(a.calls.every((c) => c.method === 'deleteMessage'), '/stats is admin-only');

  // «Перезапуск»: новый экземпляр без памяти о собеседниках.
  const b = makeSupport(hooks);
  b.support.importState(await db.loadSupport());
  const routeId = fake.tables.support_routes[1].admin_message_id;
  await b.send(admin, 'Ответ', { reply_to_message: { message_id: routeId, chat: { id: 9000, type: 'private' }, date: 1, from: { id: 333, is_bot: true, first_name: 'Support' } } });
  await tick();
  const toUser = b.calls.find((c) => c.payload.chat_id === 10);
  assert.ok(toUser && toUser.payload.text.startsWith('Support reply:'), 'reply prefix uses the saved user language after restart');
  assert.strictEqual(fake.tables.support_tickets.find((t) => t.user_id === 10).status, 'answered');

  b.calls.length = 0;
  await b.send({ id: 77, is_bot: false, first_name: 'X', language_code: 'ru' }, 'hi');
  assert.ok(b.calls.every((c) => c.payload.chat_id !== 9000), 'ban from the database works after restart');
  await b.send(admin, '/unban 77');
  await tick();
  assert.strictEqual(fake.tables.support_bans.length, 0);

  // База упала — поддержка продолжает пересылать.
  fake.state.down = true;
  const c = makeSupport(hooks);
  await c.send({ id: 11, is_bot: false, first_name: 'Z', language_code: 'ru' }, 'when db is down');
  await tick();
  assert.strictEqual(c.calls.filter((x) => x.payload.chat_id === 9000).length, 2, 'message still reaches the admin');
  c.calls.length = 0;
  await c.send(admin, '/stats');
  assert.ok(c.calls.some((x) => x.payload.chat_id === 9000 && /Не удалось/.test(x.payload.text)));

  // Без базы: /stats объясняет, что делать.
  const d = makeSupport({ statsText: async () => NO_DB_STATS_TEXT });
  await d.send(admin, '/stats');
  assert.ok(d.calls.some((x) => x.payload.text === NO_DB_STATS_TEXT));
}

(async () => {
  testConfig();
  await testCrud();
  await testFailSoft();
  await testMigration();
  await testSupportWithDb();
  console.log('DB_OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
