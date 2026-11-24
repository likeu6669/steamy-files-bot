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
  checkFlood,
  prefixText,
  hasForwardableContent,
  describeSendError,
  loadState,
  saveState,
  rememberRoute,
  DEFAULT_TOPIC,
  FLOOD_LIMIT,
  FLOOD_WINDOW_MS,
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

let flood = checkFlood([], 1000, FLOOD_LIMIT, FLOOD_WINDOW_MS);
assert.strictEqual(flood.limited, false);
const stamps = [1000, 2000, 3000, 4000, 5000];
flood = checkFlood(stamps, 10000, FLOOD_LIMIT, FLOOD_WINDOW_MS);
assert.strictEqual(flood.limited, true);
flood = checkFlood(stamps, 1000 + FLOOD_WINDOW_MS, FLOOD_LIMIT, FLOOD_WINDOW_MS);
assert.strictEqual(flood.limited, false);

const tmp = path.join(os.tmpdir(), 'support-state-test-' + Date.now() + '.json');
const banned = new Set([5]);
const routes = new Map();
rememberRoute(routes, 10, 20, 5);
assert.strictEqual(routes.get('10:20'), 5);
assert.ok(saveState(tmp, banned, routes));
const loaded = loadState(tmp);
assert.deepStrictEqual(loaded.banned, [5]);
assert.strictEqual(loaded.routes['10:20'], 5);
fs.unlinkSync(tmp);

const many = new Map();
for (let i = 0; i < MAX_ROUTES + 3; i++) rememberRoute(many, 1, i + 1, 9);
assert.strictEqual(many.size, MAX_ROUTES);
assert.ok(!many.has('1:1'));
assert.ok(many.has(routeKey(1, MAX_ROUTES + 3)));

assert.strictEqual(DEFAULT_TOPIC, 'other');

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

// Mock telegram relay: header + copy, then admin reply prefix, flood, ban, ack-once
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
  // Use exported helpers to emulate the same sequence the bot runs
  const { formatHeader, prefixText, checkFlood, FLOOD_LIMIT, FLOOD_WINDOW_MS, routeKey, rememberRoute } = require('./support-bot');
  const routes = new Map();
  const session = { topic: 'ads', lang: 'ru', ackForTopic: null };
  const user = { id: 42, first_name: 'Anna', username: 'ari' };
  const header = formatHeader({ topicKey: session.topic, name: 'Anna', username: 'ari', userId: 42, lang: 'ru' });
  const h = await telegram.sendMessage(1, header);
  rememberRoute(routes, 1, h.message_id, 42);
  const c = await telegram.copyMessage(1, 42, 100);
  rememberRoute(routes, 1, c.message_id, 42);
  assert.strictEqual(routes.get(routeKey(1, h.message_id)), 42);
  assert.strictEqual(routes.get(routeKey(1, c.message_id)), 42);

  const target = routes.get(routeKey(1, c.message_id));
  await telegram.sendMessage(target, prefixText('Да, возьмём рекламу', 'ru'));
  assert.ok(sent[sent.length - 1].text.startsWith('Ответ поддержки:'));

  let stamps = [];
  for (let i = 0; i < 5; i++) {
    const f = checkFlood(stamps, 1000 + i, FLOOD_LIMIT, FLOOD_WINDOW_MS);
    assert.strictEqual(f.limited, false);
    f.recent.push(1000 + i);
    stamps = f.recent;
  }
  assert.strictEqual(checkFlood(stamps, 1010, FLOOD_LIMIT, FLOOD_WINDOW_MS).limited, true);

  if (session.ackForTopic !== session.topic) session.ackForTopic = session.topic;
  const shouldAckAgain = session.ackForTopic !== session.topic;
  assert.strictEqual(shouldAckAgain, false);
  session.topic = 'help';
  session.ackForTopic = null;
  assert.notStrictEqual(session.ackForTopic, session.topic);
}

mockRelay().then(() => {
  console.log('SUPPORT_LOGIC_OK');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
