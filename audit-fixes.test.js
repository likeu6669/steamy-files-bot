const assert = require('assert');
const {
  createChannelState,
  normalizeState,
  parseIdList,
  STATE_FILENAME
} = require('./channel-state');
const { createUpdateDeduper } = require('./update-dedupe');
const { canRetryWithoutCaption, isBlockedError } = require('./antispam');
const { createSupportBot, topicKeyboard, supportLang, TEXTS } = require('./support-bot');

const { Telegram } = require('telegraf');

const quietLog = { log() {}, warn() {}, error() {} };

// Telegraf создаёт новый клиент на каждое обновление, поэтому подменяем
// отправку на уровне прототипа: тест никогда не ходит в настоящий Telegram.
const apiHandlers = new Map();
Telegram.prototype.callApi = async function (method, payload) {
  const handler = apiHandlers.get(this.token);
  if (!handler) throw new Error('unexpected Telegram call in test: ' + method);
  return handler(method, payload);
};

function mockChannelTelegram(initialPinned) {
  const calls = [];
  let nextId = 500;
  const docs = {};
  const tg = {
    pinned: initialPinned || null,
    failGetChat: 0,
    editError: null,
    calls,
    async getChat() {
      calls.push('getChat');
      if (tg.failGetChat > 0) {
        tg.failGetChat -= 1;
        throw new Error('ETIMEDOUT');
      }
      return { id: -100, pinned_message: tg.pinned };
    },
    async getFileLink(fileId) {
      calls.push('getFileLink');
      return 'https://files.test/' + fileId;
    },
    async sendDocument(chatId, file, extra) {
      calls.push('sendDocument');
      const message_id = ++nextId;
      docs[message_id] = file.source.toString('utf8');
      tg.lastBody = docs[message_id];
      assert.strictEqual(file.filename, STATE_FILENAME);
      assert.ok(extra.disable_notification);
      return { message_id };
    },
    async pinChatMessage(chatId, messageId) {
      calls.push('pin:' + messageId);
      tg.pinned = { message_id: messageId, document: { file_id: 'f' + messageId, file_name: STATE_FILENAME } };
      return true;
    },
    async editMessageMedia(chatId, messageId, inlineId, media) {
      calls.push('edit:' + messageId);
      if (tg.editError) {
        const e = tg.editError;
        tg.editError = null;
        throw e;
      }
      assert.strictEqual(media.type, 'document');
      docs[messageId] = media.media.source.toString('utf8');
      tg.lastBody = docs[messageId];
      return true;
    }
  };
  return tg;
}

async function testChannelStateFreshStart() {
  const tg = mockChannelTelegram(null);
  let current = { support: { banned: [], mutes: {}, routes: {} }, links: {} };
  let applied = null;
  const store = createChannelState({
    telegram: tg,
    channelId: -100,
    debounceMs: 5,
    snapshot: () => current,
    apply: (st) => { applied = st; },
    log: quietLog
  });
  assert.strictEqual(store.loaded, false);
  store.scheduleSave();
  assert.ok(!tg.calls.includes('sendDocument'), 'no writes before load');
  assert.strictEqual(await store.load(), true);
  assert.deepStrictEqual(applied.support.banned, []);

  current = { support: { banned: [7], mutes: {}, routes: { '1:2': 7 } }, links: { 3: [10, 11] } };
  assert.strictEqual(await store.writeNow(), true);
  assert.ok(tg.calls.includes('sendDocument'));
  assert.ok(tg.calls.some((c) => c.startsWith('pin:')));
  const firstId = store.messageId;
  assert.deepStrictEqual(JSON.parse(tg.lastBody).support.banned, [7]);
  assert.deepStrictEqual(JSON.parse(tg.lastBody).links, { 3: [10, 11] });

  const before = tg.calls.length;
  assert.strictEqual(await store.writeNow(), true);
  assert.strictEqual(tg.calls.length, before, 'unchanged state is not re-uploaded');

  current = { support: { banned: [7, 8], mutes: {}, routes: {} }, links: {} };
  store.scheduleSave();
  store.scheduleSave();
  store.scheduleSave();
  await new Promise((r) => setTimeout(r, 30));
  await store.flush();
  const edits = tg.calls.filter((c) => c === 'edit:' + firstId);
  assert.strictEqual(edits.length, 1, 'debounced saves are coalesced into one edit');
  assert.deepStrictEqual(JSON.parse(tg.lastBody).support.banned, [7, 8]);

  const notFound = new Error('400: Bad Request: message to edit not found');
  notFound.description = 'Bad Request: message to edit not found';
  tg.editError = notFound;
  current = { support: { banned: [9], mutes: {}, routes: {} }, links: {} };
  assert.strictEqual(await store.writeNow(), true);
  assert.notStrictEqual(store.messageId, firstId, 'deleted state message is recreated');
  assert.deepStrictEqual(JSON.parse(tg.lastBody).support.banned, [9]);
}

async function testChannelStateLoadExisting() {
  const saved = {
    v: 1,
    support: { banned: [42, 'x', -1], mutes: { 5: Date.now() + 60000 }, routes: { '9000:12': 42, bad: 1 } },
    links: { 2: [3], 6: [20, 21], abc: [1] }
  };
  const tg = mockChannelTelegram({ message_id: 77, document: { file_id: 'F77', file_name: STATE_FILENAME } });
  let applied = null;
  const store = createChannelState({
    telegram: tg,
    channelId: -100,
    snapshot: () => applied,
    apply: (st) => { applied = st; },
    download: async (url) => {
      assert.strictEqual(url, 'https://files.test/F77');
      return JSON.stringify(saved);
    },
    log: quietLog
  });
  assert.strictEqual(await store.load(), true);
  assert.strictEqual(store.messageId, 77);
  assert.deepStrictEqual(applied.support.banned, [42]);
  assert.deepStrictEqual(applied.support.routes, { '9000:12': 42 });
  assert.deepStrictEqual(applied.links, { 2: [3], 6: [20, 21] });
  assert.ok(applied.support.mutes['5'] > Date.now());
  const before = tg.calls.length;
  assert.strictEqual(await store.writeNow(), true);
  assert.strictEqual(tg.calls.length, before, 'loaded state is not re-uploaded unchanged');
}

async function testChannelStateLoadFailureDoesNotOverwrite() {
  const tg = mockChannelTelegram({ message_id: 77, document: { file_id: 'F77', file_name: STATE_FILENAME } });
  tg.failGetChat = 10;
  let applied = null;
  const store = createChannelState({
    telegram: tg,
    channelId: -100,
    debounceMs: 1,
    retryDelaysMs: [1, 1],
    backgroundRetryMs: 5,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    snapshot: () => ({ support: { banned: [1] }, links: {} }),
    apply: (st) => { applied = st; },
    download: async () => JSON.stringify({ support: { banned: [42] }, links: {} }),
    log: quietLog
  });
  assert.strictEqual(await store.load(), false);
  store.scheduleSave();
  assert.strictEqual(await store.flush(), false);
  assert.ok(!tg.calls.includes('sendDocument') && !tg.calls.some((c) => c.startsWith('edit:')), 'nothing written while state is unknown');
  tg.failGetChat = 0;
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(store.loaded, true, 'background retry loads the state');
  assert.deepStrictEqual(applied.support.banned, [42]);
  await new Promise((r) => setTimeout(r, 20));
  await store.flush();
  assert.ok(tg.calls.includes('edit:77'), 'pending change is saved after a late load');
  store.stop();
}

function testHelpers() {
  assert.deepStrictEqual(parseIdList('12, 34 ;56 abc -7'), [12, 34, 56]);
  assert.deepStrictEqual(parseIdList(undefined), []);
  assert.deepStrictEqual(normalizeState('junk').support.banned, []);
  assert.deepStrictEqual(normalizeState({ support: { banned: [1, 1, 2] } }).support.banned, [1, 2]);

  const e400 = Object.assign(new Error('400'), { response: { error_code: 400 }, description: 'Bad Request: message caption is too long' });
  const e429 = Object.assign(new Error('429'), { response: { error_code: 429 }, description: 'Too Many Requests: retry after 3' });
  const e403 = Object.assign(new Error('403'), { response: { error_code: 403 }, description: 'Forbidden: bot was blocked by the user' });
  const eNet = Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
  const e500 = Object.assign(new Error('500'), { response: { error_code: 500 }, description: 'Internal Server Error' });
  assert.strictEqual(canRetryWithoutCaption(e400), true);
  assert.strictEqual(canRetryWithoutCaption(e429), false, '429 is not retried as a second copy');
  assert.strictEqual(canRetryWithoutCaption(eNet), false, 'timeout may have delivered the file');
  assert.strictEqual(canRetryWithoutCaption(e500), false);
  assert.strictEqual(canRetryWithoutCaption(e403), false);
  assert.strictEqual(isBlockedError(e403), true);
  assert.strictEqual(isBlockedError(e400), false);
}

async function testDeduper() {
  const mw = createUpdateDeduper(3);
  let runs = 0;
  const next = async () => { runs += 1; };
  await mw({ update: { update_id: 1 } }, next);
  await mw({ update: { update_id: 1 } }, next);
  await mw({ update: { update_id: 2 } }, next);
  assert.strictEqual(runs, 2, 'repeated update_id is skipped');
  for (const id of [3, 4, 5, 6]) await mw({ update: { update_id: id } }, next);
  await mw({ update: { update_id: 1 } }, next);
  assert.strictEqual(runs, 7, 'old ids are forgotten, memory stays bounded');
}

function testLanguages() {
  assert.strictEqual(supportLang({ from: { language_code: 'ru' } }), 'ru');
  assert.strictEqual(supportLang({ from: { language_code: 'ru-RU' } }), 'ru');
  assert.strictEqual(supportLang({ from: { language_code: 'en' } }), 'en');
  assert.strictEqual(supportLang({ from: { language_code: 'de' } }), 'en');
  assert.strictEqual(supportLang({ from: { language_code: 'uk' } }), 'en');
  assert.strictEqual(supportLang({ from: {} }), 'ru');
  const en = topicKeyboard('en').inline_keyboard.flat().map((b) => b.text).join('|');
  const ru = topicKeyboard('ru').inline_keyboard.flat().map((b) => b.text).join('|');
  assert.strictEqual(en, '📣 Advertising|🆘 Help|©️ Rights holders|💬 Other');
  assert.strictEqual(ru, '📣 Реклама|🆘 Помощь|©️ Правообладателям|💬 Другое');
  assert.deepStrictEqual(
    topicKeyboard('en').inline_keyboard.flat().map((b) => b.callback_data),
    ['topic:ads', 'topic:help', 'topic:rights', 'topic:other']
  );
  assert.strictEqual(topicKeyboard().inline_keyboard[0][0].text, '📣 Реклама');
}

let tokenSeq = 0;
function makeSupport(extra) {
  let changes = 0;
  const token = (400 + ++tokenSeq) + ':TEST';
  const support = createSupportBot(Object.assign({
    token,
    adminIds: [9000],
    statePath: null,
    replaceCommandReply: async (ctx, tag, kind, fn) => fn(),
    onStateChange: () => { changes += 1; }
  }, extra || {}));
  const calls = [];
  let mid = 100;
  support.bot.botInfo = { id: 333, is_bot: true, first_name: 'Support', username: 'support_test_bot' };
  apiHandlers.set(token, async (method, payload) => {
    calls.push({ method, payload });
    if (['sendMessage', 'copyMessage'].includes(method)) return { message_id: ++mid };
    return true;
  });
  let uid = 1;
  let m = 1;
  const send = (from, text, more) => support.bot.handleUpdate({
    update_id: uid++,
    message: Object.assign({
      message_id: m++,
      from,
      chat: { id: from.id, type: 'private' },
      date: 1,
      text,
      entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined
    }, more || {})
  });
  return { support, calls, send, changes: () => changes };
}

async function testSupportFlows() {
  const { support, calls, send, changes } = makeSupport({ extraBannedIds: [555] });
  const admin = { id: 9000, is_bot: false, first_name: 'Owner', language_code: 'ru' };
  const user = { id: 10, is_bot: false, first_name: 'Ann', language_code: 'en' };

  await send(admin, 'просто заметка');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].payload.chat_id, 9000);
  assert.strictEqual(calls[0].payload.text, TEXTS.ru.adminHint, 'admin gets a hint, no ticket');

  calls.length = 0;
  await send(user, '/start');
  const welcome = calls.find((c) => c.method === 'sendMessage' && c.payload.chat_id === 10);
  assert.strictEqual(welcome.payload.reply_markup.inline_keyboard[0][0].text, '📣 Advertising');

  calls.length = 0;
  await send(user, 'Hello');
  const toAdmin = calls.filter((c) => c.payload.chat_id === 9000);
  assert.strictEqual(toAdmin.length, 2, 'header and copy are sent to the admin');
  assert.ok(changes() >= 1, 'a new ticket route triggers a state save');

  const routeIds = Object.entries(support.exportState().routes)
    .filter(([, userId]) => userId === 10)
    .map(([key]) => Number(key.split(':')[1]));
  assert.strictEqual(routeIds.length, 2);
  const copyId = Math.max(...routeIds);
  calls.length = 0;
  await send(admin, 'Ответ', { reply_to_message: { message_id: copyId, chat: { id: 9000, type: 'private' }, date: 1, from: { id: 333, is_bot: true, first_name: 'Support' } } });
  assert.ok(calls.some((c) => c.payload.chat_id === 10 && /^Support reply:/.test(c.payload.text)), 'reply still reaches the user');

  calls.length = 0;
  await send({ id: 555, is_bot: false, first_name: 'Spam', language_code: 'ru' }, 'spam');
  assert.ok(calls.every((c) => c.payload.chat_id !== 9000), 'BANNED_IDS user is blocked');
  assert.ok(calls.some((c) => c.payload.text === TEXTS.ru.banned));

  const exported = support.exportState();
  assert.ok(exported.banned.includes(555));
  assert.ok(Object.values(exported.routes).includes(10));

  // После перезапуска: новый экземпляр получает баны и маршруты из канала.
  const second = makeSupport();
  second.support.importState({ banned: [77], mutes: { 88: Date.now() + 60000 }, routes: { ['9000:' + copyId]: 10 } });
  const st = second.support.exportState();
  assert.ok(st.banned.includes(77));
  assert.ok(st.mutes['88'] > Date.now());
  second.calls.length = 0;
  await second.send(admin, 'Ответ после перезапуска', { reply_to_message: { message_id: copyId, chat: { id: 9000, type: 'private' }, date: 1, from: { id: 333, is_bot: true, first_name: 'Support' } } });
  assert.ok(second.calls.some((c) => c.payload.chat_id === 10), 'reply-by-reply works after restart');
  second.calls.length = 0;
  await second.send({ id: 77, is_bot: false, first_name: 'X', language_code: 'ru' }, 'hi');
  assert.ok(second.calls.every((c) => c.payload.chat_id !== 9000), 'ban survives restart');

  // Повтор того же update_id (Telegram прислал ещё раз) не создаёт второй тикет.
  const third = makeSupport();
  const upd = { update_id: 4242, message: { message_id: 1, from: user, chat: { id: 10, type: 'private' }, date: 1, text: 'twice' } };
  await third.support.bot.handleUpdate(upd);
  const n = third.calls.length;
  await third.support.bot.handleUpdate(JSON.parse(JSON.stringify(upd)));
  assert.strictEqual(third.calls.length, n, 'duplicate update is ignored');
}

(async () => {
  testHelpers();
  testLanguages();
  await testDeduper();
  await testChannelStateFreshStart();
  await testChannelStateLoadExisting();
  await testChannelStateLoadFailureDoesNotOverwrite();
  await testSupportFlows();
  console.log('AUDIT_FIXES_OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
