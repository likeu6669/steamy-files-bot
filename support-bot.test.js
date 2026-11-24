const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeUsername,
  supportLang,
  topicLabel,
  formatHeader,
  parseReplyCommand,
  parseUserIdCommand,
  routeKey,
  prefixText,
  hasForwardableContent,
  describeSendError,
  loadState,
  saveState,
  rememberRoute,
  emptyFloodRecord,
  messageFingerprint,
  isRecentDuplicate,
  evaluateMessageLimits,
  rememberFingerprint,
  evaluateTopicLimit,
  floodNoticeText,
  DEFAULT_TOPIC,
  FLOOD_MINUTE_LIMIT,
  FLOOD_MINUTE_MS,
  FLOOD_DAY_LIMIT,
  STRIKE_LIMIT,
  STRIKE_WINDOW_MS,
  MUTE_MS,
  DUP_WINDOW_MS,
  MAX_ROUTES
} = require('./support-bot');

assert.strictEqual(normalizeUsername('SteamySupportBot'), '@SteamySupportBot');
assert.strictEqual(normalizeUsername('@SteamySupportBot'), '@SteamySupportBot');
assert.strictEqual(normalizeUsername('  @@foo  '), '@foo');
assert.strictEqual(normalizeUsername(''), '');
assert.strictEqual(normalizeUsername(undefined), '');

assert.strictEqual(supportLang({ from: { language_code: 'en-US' } }), 'en');
assert.strictEqual(supportLang({ from: { language_code: 'ru' } }), 'ru');
assert.strictEqual(supportLang({ from: {} }), 'ru');
assert.strictEqual(topicLabel('ads', 'ru'), '📣 Реклама');
assert.strictEqual(topicLabel('rights', 'en'), '©️ Rights holders');
assert.strictEqual(topicLabel('unknown', 'ru'), '💬 Другое');

const header = formatHeader({
  topicKey: 'ads',
  name: 'Anna',
  username: 'ari',
  userId: 42,
  lang: 'ru'
});
assert.ok(header.startsWith('📣 Реклама'));
assert.ok(header.includes('От: Anna (@ari)'));
assert.ok(header.includes('ID: 42'));
assert.ok(header.includes('/reply 42 текст'));

assert.deepStrictEqual(parseReplyCommand('/reply 99 Hello there'), { userId: 99, text: 'Hello there' });
assert.deepStrictEqual(parseReplyCommand('/reply@SteamySupportBot 99 hi'), { userId: 99, text: 'hi' });
assert.strictEqual(parseReplyCommand('/reply 99'), null);
assert.strictEqual(parseReplyCommand('/reply nope'), null);
assert.strictEqual(parseUserIdCommand('ban', '/ban 123'), 123);
assert.strictEqual(parseUserIdCommand('unban', '/unban@bot 7'), 7);
assert.strictEqual(parseUserIdCommand('ban', '/ban'), null);

assert.strictEqual(routeKey(1, 2), '1:2');
assert.strictEqual(prefixText('Ок', 'ru'), 'Ответ поддержки:\n\nОк');
assert.strictEqual(prefixText('Ok', 'en'), 'Support reply:\n\nOk');

assert.ok(hasForwardableContent({ text: 'hi' }));
assert.ok(hasForwardableContent({ photo: [{ file_id: 'x' }] }));
assert.ok(!hasForwardableContent({ new_chat_members: [] }));

const err = describeSendError({ description: 'Forbidden: bot was blocked by the user' });
assert.strictEqual(err, 'Пользователь заблокировал бота.');

assert.strictEqual(messageFingerprint({ text: '  Hello  ' }), 'text:Hello');
assert.strictEqual(
  messageFingerprint({ photo: [{ file_unique_id: 'small' }, { file_unique_id: 'big' }], caption: 'pic' }),
  'file:big'
);
assert.strictEqual(messageFingerprint({ document: { file_unique_id: 'doc1' } }), 'file:doc1');

let rec = emptyFloodRecord();
const now0 = 1_000_000;
rec = rememberFingerprint(rec, 'text:hello', now0);
assert.strictEqual(isRecentDuplicate(rec, 'text:hello', now0 + 1000), true);
assert.strictEqual(isRecentDuplicate(rec, 'text:hello', now0 + DUP_WINDOW_MS), false);
assert.strictEqual(isRecentDuplicate(rec, 'text:bye', now0 + 1000), false);

// 3 per minute, notice only on the first excess in the window
let rec2 = emptyFloodRecord();
let t = 10_000;
for (let i = 0; i < FLOOD_MINUTE_LIMIT; i++) {
  const r = evaluateMessageLimits(rec2, t + i);
  assert.strictEqual(r.action, 'ok', 'accepted ' + i);
  rec2 = r.record;
}
const firstHit = evaluateMessageLimits(rec2, t + 10);
assert.strictEqual(firstHit.action, 'limited');
assert.strictEqual(firstHit.reason, 'minute');
assert.strictEqual(firstHit.notifyUser, true);
assert.strictEqual(firstHit.notifyAdmins, false);
rec2 = firstHit.record;
const secondHit = evaluateMessageLimits(rec2, t + 20);
assert.strictEqual(secondHit.action, 'limited');
assert.strictEqual(secondHit.notifyUser, false);

// after the minute window, a new notice is a new strike
rec2 = evaluateMessageLimits(rec2, t + FLOOD_MINUTE_MS).record; // this may be ok (window expired)
// Fill the new minute window again
for (let i = 0; i < FLOOD_MINUTE_LIMIT; i++) {
  const r = evaluateMessageLimits(rec2, t + FLOOD_MINUTE_MS + i);
  if (r.action === 'ok') rec2 = r.record;
}
const hit2 = evaluateMessageLimits(rec2, t + FLOOD_MINUTE_MS + 20);
assert.strictEqual(hit2.action, 'limited');
assert.strictEqual(hit2.notifyUser, true);
rec2 = hit2.record;

// third window hit within 10 min -> mute
for (let i = 0; i < FLOOD_MINUTE_LIMIT; i++) {
  const r = evaluateMessageLimits(rec2, t + 2 * FLOOD_MINUTE_MS + i);
  if (r.action === 'ok') rec2 = r.record;
}
const muteHit = evaluateMessageLimits(rec2, t + 2 * FLOOD_MINUTE_MS + 20);
assert.strictEqual(muteHit.action, 'muted');
assert.strictEqual(muteHit.notifyUser, true);
assert.strictEqual(muteHit.notifyAdmins, true);
assert.ok(muteHit.record.muteUntil >= t + 2 * FLOOD_MINUTE_MS + 20 + MUTE_MS - 1);
rec2 = muteHit.record;
const mutedAgain = evaluateMessageLimits(rec2, t + 2 * FLOOD_MINUTE_MS + 30);
assert.strictEqual(mutedAgain.action, 'muted');
assert.strictEqual(mutedAgain.notifyUser, false);
assert.strictEqual(mutedAgain.notifyAdmins, false);
assert.ok(floodNoticeText('ru', muteHit).includes('час'));
assert.ok(floodNoticeText('en', firstHit).toLowerCase().includes('minute'));

// 20 per day
let recDay = emptyFloodRecord();
const dayStart = 5_000_000;
for (let i = 0; i < FLOOD_DAY_LIMIT; i++) {
  const r = evaluateMessageLimits(recDay, dayStart + i * 70_000);
  assert.strictEqual(r.action, 'ok', 'day accepted ' + i);
  recDay = r.record;
}
const dayHit = evaluateMessageLimits(recDay, dayStart + FLOOD_DAY_LIMIT * 70_000);
assert.strictEqual(dayHit.action, 'limited');
assert.strictEqual(dayHit.reason, 'day');
assert.strictEqual(dayHit.notifyUser, true);
recDay = dayHit.record;
const dayHit2 = evaluateMessageLimits(recDay, dayStart + FLOOD_DAY_LIMIT * 70_000 + 1000);
assert.strictEqual(dayHit2.notifyUser, false);
assert.ok(floodNoticeText('ru', dayHit).includes('сегодня'));

// topic buttons: 3 per minute, then limited
let recTopic = emptyFloodRecord();
const t0 = 20_000;
for (let i = 0; i < FLOOD_MINUTE_LIMIT; i++) {
  const r = evaluateTopicLimit(recTopic, t0 + i);
  assert.strictEqual(r.limited, false);
  recTopic = r.record;
}
const topicHit = evaluateTopicLimit(recTopic, t0 + 10);
assert.strictEqual(topicHit.limited, true);

// persist mutes
const tmp = path.join(os.tmpdir(), 'support-state-test-' + Date.now() + '.json');
const banned = new Set([5]);
const routes = new Map();
rememberRoute(routes, 10, 20, 5);
const mutes = new Map([[7, Date.now() + MUTE_MS]]);
assert.ok(saveState(tmp, banned, routes, mutes));
const loaded = loadState(tmp);
assert.deepStrictEqual(loaded.banned, [5]);
assert.strictEqual(loaded.routes['10:20'], 5);
assert.ok(loaded.mutes[7] > Date.now());
fs.unlinkSync(tmp);

// expired mutes are not loaded
const tmp2 = path.join(os.tmpdir(), 'support-state-test-exp-' + Date.now() + '.json');
fs.writeFileSync(tmp2, JSON.stringify({ banned: [], routes: {}, mutes: { 8: Date.now() - 1000 } }) + '\n');
const loadedExp = loadState(tmp2);
assert.deepStrictEqual(loadedExp.mutes, {});
fs.unlinkSync(tmp2);

const many = new Map();
for (let i = 0; i < MAX_ROUTES + 3; i++) rememberRoute(many, 1, i + 1, 9);
assert.strictEqual(many.size, MAX_ROUTES);
assert.ok(!many.has('1:1'));
assert.ok(many.has(routeKey(1, MAX_ROUTES + 3)));

assert.strictEqual(DEFAULT_TOPIC, 'other');
assert.strictEqual(STRIKE_LIMIT, 3);
assert.ok(STRIKE_WINDOW_MS >= 10 * 60 * 1000);

const { createSupportBot } = require('./support-bot');
const support = createSupportBot({
  token: '123:ABC',
  adminIds: [1],
  statePath: null,
  replaceCommandReply: async (ctx, tag, kind, fn) => fn()
});
assert.ok(support.hookPath.startsWith('/webhook/support/'));
assert.strictEqual(support.hookSecret.length, 32);
assert.match(support.hookSecret, /^[a-f0-9]{32}$/);
assert.strictEqual(support.usingWebhook, false);
assert.ok(typeof support.handleWebhook === 'function');

async function mockRelay() {
  const sent = [];
  const telegram = {
    async sendMessage(chatId, text, extra) {
      const message_id = sent.length + 1;
      sent.push({ type: 'send', chatId, text, extra, message_id });
      return { message_id };
    },
    async copyMessage(to, from, messageId, extra) {
      const message_id = sent.length + 1;
      sent.push({ type: 'copy', to, from, messageId, extra, message_id });
      return { message_id };
    }
  };
  const headerText = formatHeader({ topicKey: 'ads', name: 'Anna', username: 'ari', userId: 42, lang: 'ru' });
  const h = await telegram.sendMessage(1, headerText);
  rememberRoute(routes, 1, h.message_id, 42);
  const c = await telegram.copyMessage(1, 42, 100);
  rememberRoute(routes, 1, c.message_id, 42);
  assert.strictEqual(routes.get(routeKey(1, h.message_id)), 42);
  await telegram.sendMessage(42, prefixText('Да, возьмём рекламу', 'ru'));
  assert.ok(sent[sent.length - 1].text.startsWith('Ответ поддержки:'));
}

mockRelay().then(() => {
  console.log('SUPPORT_LOGIC_OK');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
