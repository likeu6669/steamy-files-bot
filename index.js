const { Telegraf } = require('telegraf');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const DEFAULT_STORAGE_CHANNEL_ID = '-1004302896014';
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID || DEFAULT_STORAGE_CHANNEL_ID;
if (!process.env.STORAGE_CHANNEL_ID) {
  console.warn('STORAGE_CHANNEL_ID не задан, используется значение по умолчанию');
}
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s))
  .filter((n) => Number.isInteger(n));

const FILES_PATH = path.join(__dirname, 'files.json');
const GAMES_PATH = path.join(__dirname, 'games.json');
const FILES_WELCOME_PHOTO = path.join(__dirname, 'assets', 'files-welcome.jpg');
const RATE_MS = 10000;
const PART_DELAY_MS = 400;
const MINI_APP_URL = 'https://t.me/SteamyStore_bot?startapp';
const { createSupportBot, normalizeUsername } = require('./support-bot');

const SUPPORT_BOT_TOKEN = process.env.SUPPORT_BOT_TOKEN;
const DEFAULT_SUPPORT_USERNAME = 'SteamySupportBot';
const SUPPORT_BOT_USERNAME = normalizeUsername(process.env.SUPPORT_BOT_USERNAME);
const RULES_CONTACT = SUPPORT_BOT_USERNAME || normalizeUsername(DEFAULT_SUPPORT_USERNAME);

if (!BOT_TOKEN) {
  console.error('Нужна переменная окружения BOT_TOKEN');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const lastRequestAt = new Map();

function webhookSecret() {
  if (process.env.WEBHOOK_SECRET) return process.env.WEBHOOK_SECRET;
  return crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32);
}

function webhookBaseUrl() {
  const raw = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;
  if (!raw) return null;
  return String(raw).replace(/\/$/, '');
}

const HOOK_PATH = '/webhook/' + webhookSecret();
const WEBHOOK_SECRET = webhookSecret();
const handleWebhook = bot.webhookCallback(HOOK_PATH, { secretToken: WEBHOOK_SECRET });
let usingWebhook = false;

const STORE_BOT_TOKEN = process.env.STORE_BOT_TOKEN;
const STORE_WEBAPP_URL = String(process.env.STORE_WEBAPP_URL || 'https://steamy-store.vercel.app').replace(/\/$/, '');
const STORE_CHANNEL_URL = 'https://t.me/steamystore';
const STORE_WELCOME_PHOTO = path.join(__dirname, 'assets', 'welcome.jpg');

let storeBot = null;
let handleStoreWebhook = null;
let STORE_HOOK_PATH = null;
let STORE_WEBHOOK_SECRET = null;
let usingStoreWebhook = false;

const lastCommandReplies = new Map();

function commandReplyKey(botTag, chatId, kind) {
  return botTag + ':' + chatId + ':' + kind;
}

function sentMessageId(sent) {
  if (!sent) return null;
  if (sent.message_id) return sent.message_id;
  if (sent.message && sent.message.message_id) return sent.message.message_id;
  return null;
}

async function tryDeleteMessage(telegram, chatId, messageId) {
  if (!telegram || !chatId || !messageId) return;
  try {
    await telegram.deleteMessage(chatId, messageId);
  } catch {
    // 48 hours passed, already deleted, or the bot cannot delete it
  }
}

async function replaceCommandReply(ctx, botTag, kind, sendFn, options) {
  const chatId = ctx.chat && ctx.chat.id;
  const key = commandReplyKey(botTag, chatId, kind);
  const previousId = lastCommandReplies.get(key);
  const deleteIncoming = !options || options.deleteIncoming !== false;

  const sent = await sendFn();
  const newId = sentMessageId(sent);
  if (newId) lastCommandReplies.set(key, newId);

  if (previousId && previousId !== newId) {
    await tryDeleteMessage(ctx.telegram, chatId, previousId);
  }
  if (deleteIncoming && ctx.message && ctx.message.message_id) {
    await tryDeleteMessage(ctx.telegram, chatId, ctx.message.message_id);
  }
  return sent;
}

const STORE_TEXTS = {
  ru: {
    welcome:
      'Привет! Это Steamy Store — каталог игр для взрослых (18+).\n' +
      'Откройте магазин внутри Telegram, подпишитесь на канал или прочитайте правила.',
    open: '🎮 Открыть магазин',
    channel: '📢 Канал',
    rulesBtn: '📜 Правила',
    help:
      'Я бот магазина Steamy Store.\n' +
      'Нажмите «Открыть магазин», чтобы зайти в каталог. Канал новостей — @steamystore.\n\n' +
      'По вопросам напишите: ' +
      RULES_CONTACT,
    rules:
      '🔞 Правила Steamy Store\n\n' +
      '1. Вам исполнилось 18 лет. Здесь игры для взрослых с откровенным контентом.\n' +
      '2. Все игры принадлежат их разработчикам. Если игра понравилась, поддержите автора: кнопка есть в карточке игры.\n' +
      '3. Файлы предназначены только для личного использования. Перепродавать их или выдавать за свои запрещено.\n' +
      '4. Вы скачиваете и устанавливаете файлы на свой страх и риск.\n' +
      '5. Если вы правообладатель и хотите, чтобы игру убрали, напишите: ' +
      RULES_CONTACT +
      '.',
    writePrivate: 'Напишите мне в личные сообщения.'
  },
  en: {
    welcome:
      'Hi! This is Steamy Store, a catalog of adult games (18+).\n' +
      'Open the shop inside Telegram, join the channel, or read the rules.',
    open: '🎮 Open the store',
    channel: '📢 Channel',
    rulesBtn: '📜 Rules',
    help:
      'I am the Steamy Store bot.\n' +
      'Tap “Open the store” to open the catalog. News channel: @steamystore.\n\n' +
      'For questions, write to: ' +
      RULES_CONTACT,
    rules:
      '🔞 Steamy Store rules\n\n' +
      '1. You are 18 or older. This catalog has adult games with explicit content.\n' +
      '2. All games belong to their developers. If you enjoyed a game, support the author: the button is on the game card.\n' +
      '3. Files are for personal use only. Reselling them or passing them off as your own is prohibited.\n' +
      '4. You download and install files at your own risk.\n' +
      '5. If you are a rights holder and want a game removed, write to: ' +
      RULES_CONTACT +
      '.',
    writePrivate: 'Please message me in a private chat.'
  }
};

function storeLang(ctx) {
  const code = String((ctx.from && ctx.from.language_code) || 'ru').toLowerCase();
  return code.startsWith('en') ? 'en' : 'ru';
}

function storeKeyboard(lang) {
  const txt = STORE_TEXTS[lang] || STORE_TEXTS.ru;
  return {
    inline_keyboard: [
      [{ text: txt.open, web_app: { url: STORE_WEBAPP_URL } }],
      [
        { text: txt.channel, url: STORE_CHANNEL_URL },
        { text: txt.rulesBtn, callback_data: 'rules' }
      ]
    ]
  };
}

async function sendStoreWelcome(ctx) {
  const lang = storeLang(ctx);
  const txt = STORE_TEXTS[lang];
  const extra = { caption: txt.welcome, reply_markup: storeKeyboard(lang) };
  if (fs.existsSync(STORE_WELCOME_PHOTO)) {
    try {
      return await ctx.replyWithPhoto({ source: STORE_WELCOME_PHOTO }, extra);
    } catch (err) {
      console.error('store welcome photo failed', err);
    }
  }
  return ctx.reply(txt.welcome, { reply_markup: storeKeyboard(lang) });
}

function attachStoreHandlers(store) {
  store.start(async (ctx) => {
    if (!isPrivateChat(ctx)) {
      return ctx.reply(STORE_TEXTS[storeLang(ctx)].writePrivate);
    }
    await replaceCommandReply(ctx, 'store', 'start', () => sendStoreWelcome(ctx));
  });

  store.command('help', async (ctx) => {
    if (!isPrivateChat(ctx)) {
      return ctx.reply(STORE_TEXTS[storeLang(ctx)].writePrivate);
    }
    const lang = storeLang(ctx);
    await replaceCommandReply(ctx, 'store', 'help', () =>
      ctx.reply(STORE_TEXTS[lang].help, { reply_markup: storeKeyboard(lang) })
    );
  });

  store.command('rules', async (ctx) => {
    if (!isPrivateChat(ctx)) {
      return ctx.reply(STORE_TEXTS[storeLang(ctx)].writePrivate);
    }
    await replaceCommandReply(ctx, 'store', 'rules', () =>
      ctx.reply(STORE_TEXTS[storeLang(ctx)].rules)
    );
  });

  store.action('rules', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isPrivateChat(ctx)) {
      return ctx.reply(STORE_TEXTS[storeLang(ctx)].writePrivate);
    }
    await replaceCommandReply(ctx, 'store', 'rules', () =>
      ctx.reply(STORE_TEXTS[storeLang(ctx)].rules)
    );
  });

  store.catch((err) => {
    console.error('Store bot error', err);
  });
}

if (STORE_BOT_TOKEN && STORE_BOT_TOKEN === BOT_TOKEN) {
  console.error('STORE_BOT_TOKEN совпадает с BOT_TOKEN — бот магазина не запущен, чтобы не сломать webhook бота файлов.');
} else if (STORE_BOT_TOKEN) {
  storeBot = new Telegraf(STORE_BOT_TOKEN);
  STORE_WEBHOOK_SECRET = crypto.createHash('sha256').update('store:' + STORE_BOT_TOKEN).digest('hex').slice(0, 32);
  STORE_HOOK_PATH = '/webhook/store/' + STORE_WEBHOOK_SECRET;
  handleStoreWebhook = storeBot.webhookCallback(STORE_HOOK_PATH, { secretToken: STORE_WEBHOOK_SECRET });
  attachStoreHandlers(storeBot);
  console.log('Store bot enabled');
}

let supportBot = null;
if (SUPPORT_BOT_TOKEN && (SUPPORT_BOT_TOKEN === BOT_TOKEN || SUPPORT_BOT_TOKEN === STORE_BOT_TOKEN)) {
  console.error('SUPPORT_BOT_TOKEN совпадает с токеном другого бота — бот поддержки не запущен, чтобы не сломать webhook.');
} else if (SUPPORT_BOT_TOKEN) {
  supportBot = createSupportBot({
    token: SUPPORT_BOT_TOKEN,
    adminIds: ADMIN_IDS,
    statePath: path.join(__dirname, 'support-state.json'),
    replaceCommandReply
  });
  console.log('Support bot enabled');
}

function loadFiles() {
  if (!fs.existsSync(FILES_PATH)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(FILES_PATH, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

let files = loadFiles();

function loadGames() {
  if (!fs.existsSync(GAMES_PATH)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(GAMES_PATH, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

const gamesMeta = loadGames();

function gameMeta(gameId) {
  return gamesMeta[String(gameId)] || null;
}

function miniAppUrl(gameId) {
  return gameId ? MINI_APP_URL + '=game_' + gameId : MINI_APP_URL;
}

function userLang(ctx) {
  const code = String((ctx.from && ctx.from.language_code) || 'ru').toLowerCase();
  return code.startsWith('en') ? 'en' : 'ru';
}

const FILES_TEXTS = {
  ru: {
    welcome:
      'Привет! Я бот-хранилище Steamy Store.\n' +
      'Откройте магазин, выберите игру и нажмите «Скачать в Telegram» — я пришлю файл в этот чат. 18+.',
    open: '🎮 Открыть магазин',
    channel: '📢 Канал',
    rulesBtn: '📜 Правила',
    help:
      'Я выдаю файлы игр из Steamy Store.\n' +
      'Откройте магазин, выберите карточку и нажмите «Скачать в Telegram». Здесь только публичные версии, 18+.\n\n' +
      'Канал новостей: @steamystore\n\n' +
      'По вопросам напишите: ' +
      RULES_CONTACT,
    rules:
      '🔞 Правила Steamy Files\n\n' +
      '1. Вам исполнилось 18 лет. Здесь игры для взрослых с откровенным контентом.\n' +
      '2. Все игры принадлежат их разработчикам. Если игра понравилась, поддержите автора: кнопка есть в карточке игры.\n' +
      '3. Файлы предназначены только для личного использования. Перепродавать их или выдавать за свои запрещено.\n' +
      '4. Вы скачиваете и устанавливаете файлы на свой страх и риск.\n' +
      '5. Если вы правообладатель и хотите, чтобы игру убрали, напишите: ' +
      RULES_CONTACT +
      '.',
    support: '❤️ Автору',
    store: '🎮 Магазин',
    belongs: 'Игра принадлежит разработчику — поддержите автора'
  },
  en: {
    welcome:
      'Hi! I am the Steamy Store file bot.\n' +
      'Open the shop, pick a game and tap “Download in Telegram” — I will send the file here. 18+.',
    open: '🎮 Open the store',
    channel: '📢 Channel',
    rulesBtn: '📜 Rules',
    help:
      'I deliver game files from Steamy Store.\n' +
      'Open the shop, open a game card and tap “Download in Telegram”. These are public versions only, 18+.\n\n' +
      'News channel: @steamystore\n\n' +
      'For questions, write to: ' +
      RULES_CONTACT,
    rules:
      '🔞 Steamy Files rules\n\n' +
      '1. You are 18 or older. This catalog has adult games with explicit content.\n' +
      '2. All games belong to their developers. If you enjoyed a game, support the author: the button is on the game card.\n' +
      '3. Files are for personal use only. Reselling them or passing them off as your own is prohibited.\n' +
      '4. You download and install files at your own risk.\n' +
      '5. If you are a rights holder and want a game removed, write to: ' +
      RULES_CONTACT +
      '.',
    support: '❤️ Author',
    store: '🎮 Store',
    belongs: 'This game belongs to its developer — please support the author'
  }
};

function filesWelcomeKeyboard(lang) {
  const txt = FILES_TEXTS[lang] || FILES_TEXTS.ru;
  return {
    inline_keyboard: [
      [{ text: txt.open, url: MINI_APP_URL }],
      [
        { text: txt.channel, url: STORE_CHANNEL_URL },
        { text: txt.rulesBtn, callback_data: 'rules' }
      ]
    ]
  };
}

async function sendFilesWelcome(ctx) {
  const lang = userLang(ctx);
  const txt = FILES_TEXTS[lang];
  const extra = { caption: txt.welcome, reply_markup: filesWelcomeKeyboard(lang) };
  if (fs.existsSync(FILES_WELCOME_PHOTO)) {
    try {
      return await ctx.replyWithPhoto({ source: FILES_WELCOME_PHOTO }, extra);
    } catch (err) {
      console.error('files welcome photo failed', err);
    }
  }
  return ctx.reply(txt.welcome, { reply_markup: filesWelcomeKeyboard(lang) });
}

function deliveryKeyboard(gameId, lang) {
  const txt = FILES_TEXTS[lang] || FILES_TEXTS.ru;
  const meta = gameMeta(gameId);
  const row = [];
  if (meta && meta.supportUrl) {
    row.push({ text: txt.support, url: meta.supportUrl });
  }
  row.push({ text: txt.store, url: miniAppUrl(gameId) });
  return { inline_keyboard: [row] };
}

function deliveryText(gameId, lang) {
  const txt = FILES_TEXTS[lang] || FILES_TEXTS.ru;
  const meta = gameMeta(gameId);
  const name = (meta && meta.name) || ('Игра ' + gameId);
  let title = '🎮 ' + name;
  if (meta && meta.version) title += ' ' + meta.version;
  title += ' · Android';
  return title + '\n\n' + txt.belongs;
}

function deliveryExtra(gameId, lang) {
  return {
    caption: deliveryText(gameId, lang),
    reply_markup: deliveryKeyboard(gameId, lang)
  };
}

async function sendDeliveryCard(telegram, chatId, gameId, lang) {
  await telegram.sendMessage(chatId, deliveryText(gameId, lang), {
    reply_markup: deliveryKeyboard(gameId, lang)
  });
}

function isAdmin(ctx) {
  return Boolean(ctx.from && ADMIN_IDS.includes(ctx.from.id));
}

function isPrivateChat(ctx) {
  return ctx.chat && ctx.chat.type === 'private';
}

function askToWritePrivately(ctx) {
  return ctx.reply('Напишите мне в личные сообщения, чтобы получить файл.');
}

function isGameId(id) {
  return /^\d+$/.test(id);
}

function mappingJson() {
  return JSON.stringify(files, null, 2);
}

function trySaveFiles() {
  try {
    fs.writeFileSync(FILES_PATH, mappingJson() + '\n');
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getForwardedPost(msg) {
  if (!msg) return null;
  if (msg.forward_origin && msg.forward_origin.type === 'channel') {
    return {
      chatId: msg.forward_origin.chat && msg.forward_origin.chat.id,
      messageId: msg.forward_origin.message_id
    };
  }
  if (msg.forward_from_message_id) {
    return {
      chatId: msg.forward_from_chat && msg.forward_from_chat.id,
      messageId: msg.forward_from_message_id
    };
  }
  return null;
}

function rateLimited(userId) {
  const now = Date.now();
  const prev = lastRequestAt.get(userId) || 0;
  if (now - prev < RATE_MS) return true;
  lastRequestAt.set(userId, now);
  return false;
}

const RATE_SWEEP_MS = 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [userId, ts] of lastRequestAt) {
    if (now - ts >= RATE_MS) lastRequestAt.delete(userId);
  }
}, RATE_SWEEP_MS).unref();

async function copyGamePost(telegram, chatId, postId, extra) {
  if (extra) {
    return telegram.copyMessage(chatId, STORAGE_CHANNEL_ID, postId, extra);
  }
  return telegram.copyMessage(chatId, STORAGE_CHANNEL_ID, postId);
}

async function sendGameFiles(telegram, chatId, gameId, lang) {
  const posts = Array.isArray(files[gameId]) ? files[gameId] : [];
  if (!posts.length) {
    await telegram.sendMessage(chatId, 'Файл для этой игры ещё не загружен.');
    return false;
  }

  const cardLang = lang || 'ru';
  const cardExtra = deliveryExtra(gameId, cardLang);
  let sent = 0;
  for (let i = 0; i < posts.length; i++) {
    const extra = i === 0 ? cardExtra : undefined;
    try {
      await copyGamePost(telegram, chatId, posts[i], extra);
      sent += 1;
    } catch (err) {
      const desc = (err && err.description) || (err && err.message) || 'неизвестная ошибка';
      console.error('copyMessage failed', { gameId, postId: posts[i], desc, withCaption: Boolean(extra) });
      if (String(desc).includes('blocked') || String(desc).includes('bot was blocked')) {
        return false;
      }
      if (extra) {
        try {
          await copyGamePost(telegram, chatId, posts[i]);
          sent += 1;
          await sendDeliveryCard(telegram, chatId, gameId, cardLang).catch((cardErr) => {
            console.error('delivery card fallback failed', cardErr);
          });
        } catch (plainErr) {
          const plainDesc = (plainErr && plainErr.description) || (plainErr && plainErr.message) || desc;
          console.error('copyMessage fallback failed', { gameId, postId: posts[i], desc: plainDesc });
          await telegram.sendMessage(
            chatId,
            posts.length > 1
              ? `Не удалось отправить часть ${i + 1} из ${posts.length}. Попробуйте ещё раз позже.`
              : 'Не удалось отправить файл. Попробуйте ещё раз позже.'
          ).catch(() => {});
        }
      } else {
        await telegram.sendMessage(
          chatId,
          posts.length > 1
            ? `Не удалось отправить часть ${i + 1} из ${posts.length}. Попробуйте ещё раз позже.`
            : 'Не удалось отправить файл. Попробуйте ещё раз позже.'
        ).catch(() => {});
      }
    }
    if (i < posts.length - 1) await sleep(PART_DELAY_MS);
  }
  return sent > 0;
}

// HTTP-сервер: GET / — проверка живости, POST /webhook/<secret> — обновления Telegram
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  const pathOnly = (req.url || '/').split('?')[0];
  if (req.method === 'POST' && pathOnly === HOOK_PATH) {
    return handleWebhook(req, res);
  }
  if (handleStoreWebhook && req.method === 'POST' && pathOnly === STORE_HOOK_PATH) {
    return handleStoreWebhook(req, res);
  }
  if (supportBot && req.method === 'POST' && pathOnly === supportBot.hookPath) {
    return supportBot.handleWebhook(req, res);
  }
  res.writeHead(200);
  res.end('Bot is alive');
});

bot.start(async (ctx) => {
  if (!isPrivateChat(ctx)) {
    return askToWritePrivately(ctx);
  }

  const payload = ctx.startPayload;
  const gameId = payload && payload.startsWith('game_') ? String(payload).slice('game_'.length) : '';
  if (!isGameId(gameId)) {
    return replaceCommandReply(ctx, 'files', 'start', () => sendFilesWelcome(ctx));
  }

  if (!isAdmin(ctx) && ctx.from && rateLimited(ctx.from.id)) {
    return ctx.reply('Подождите несколько секунд перед следующим запросом.');
  }

  try {
    await sendGameFiles(ctx.telegram, ctx.chat.id, gameId, userLang(ctx));
  } catch (err) {
    console.error('start delivery failed', err);
    await ctx.reply('Не удалось отправить файл. Попробуйте ещё раз позже.').catch(() => {});
  }
});

bot.command('help', async (ctx) => {
  if (!isPrivateChat(ctx)) {
    return askToWritePrivately(ctx);
  }
  const lang = userLang(ctx);
  await replaceCommandReply(ctx, 'files', 'help', () =>
    ctx.reply(FILES_TEXTS[lang].help, { reply_markup: filesWelcomeKeyboard(lang) })
  );
});

bot.command('rules', async (ctx) => {
  if (!isPrivateChat(ctx)) {
    return askToWritePrivately(ctx);
  }
  await replaceCommandReply(ctx, 'files', 'rules', () =>
    ctx.reply(FILES_TEXTS[userLang(ctx)].rules)
  );
});

bot.action('rules', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isPrivateChat(ctx)) {
    return askToWritePrivately(ctx);
  }
  await replaceCommandReply(ctx, 'files', 'rules', () =>
    ctx.reply(FILES_TEXTS[userLang(ctx)].rules)
  );
});

bot.command('link', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(/\s+/).slice(1);
  const gameId = parts[0];
  const postIds = parts.slice(1).map((n) => parseInt(n, 10));
  if (!isGameId(gameId) || !postIds.length || postIds.some((n) => !Number.isInteger(n) || n <= 0)) {
    return ctx.reply('Использование: /link 2 12 13 14');
  }

  files[gameId] = postIds;
  const saved = trySaveFiles();
  const json = mappingJson();
  const diskNote = saved
    ? 'Записал в files.json на диске. На Render файл пропадёт после перезапуска — скопируйте его в репозиторий:'
    : 'На диск записать не удалось, но в памяти привязка есть до перезапуска. Скопируйте в files.json в репозитории:';
  await ctx.reply(`${diskNote}\n\n${json}`);
});

bot.command('files', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply(`Текущие привязки:\n\n${mappingJson()}`);
});

bot.command('test', async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (!isPrivateChat(ctx)) {
    return askToWritePrivately(ctx);
  }
  const gameId = ctx.message.text.split(/\s+/)[1];
  if (!isGameId(gameId || '')) {
    return ctx.reply('Использование: /test 2');
  }
  try {
    await sendGameFiles(ctx.telegram, ctx.chat.id, gameId, userLang(ctx));
  } catch (err) {
    console.error('test delivery failed', err);
    await ctx.reply('Не удалось отправить файл. Проверьте, что бот — админ канала, и что номера постов верные.');
  }
});

// Админ пересылает пост из канала — бот отвечает номером поста
bot.on('message', async (ctx, next) => {
  if (!isAdmin(ctx)) return next();
  const text = ctx.message && ctx.message.text;
  if (text && text.startsWith('/')) return next();

  const post = getForwardedPost(ctx.message);
  if (!post || !post.messageId) return next();

  const sameChannel = String(post.chatId) === String(STORAGE_CHANNEL_ID);
  await ctx.reply(
    sameChannel
      ? `Номер поста: ${post.messageId}\nПривязать, например: /link 2 ${post.messageId}`
      : `Это пост ${post.messageId} из чата ${post.chatId}.\nОжидается канал ${STORAGE_CHANNEL_ID}.`
  );
});

bot.catch((err) => {
  console.error('Bot error', err);
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});

async function setupStoreCommands() {
  await storeBot.telegram.setMyCommands(
    [
      { command: 'start', description: 'Открыть магазин' },
      { command: 'rules', description: 'Правила' },
      { command: 'help', description: 'Помощь' }
    ],
    { language_code: 'ru' }
  );
  await storeBot.telegram.setMyCommands([
    { command: 'start', description: 'Open the store' },
    { command: 'rules', description: 'Rules' },
    { command: 'help', description: 'Help' }
  ]);
}

async function startStoreBot(base) {
  if (!storeBot) return;
  try {
    if (base) {
      usingStoreWebhook = true;
      const url = base + STORE_HOOK_PATH;
      await storeBot.telegram.setWebhook(url, { secret_token: STORE_WEBHOOK_SECRET });
      console.log('Store bot webhook:', base + '/webhook/store/...');
    } else {
      await storeBot.launch();
      console.log('Store bot started (long polling)');
    }
    await setupStoreCommands();
  } catch (err) {
    console.error('Не удалось запустить бота магазина (бот файлов продолжает работать)', err);
  }
}

async function setupFilesCommands() {
  await bot.telegram.setMyCommands(
    [
      { command: 'start', description: 'Начать' },
      { command: 'help', description: 'Помощь' },
      { command: 'rules', description: 'Правила' }
    ],
    { language_code: 'ru' }
  );
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Start' },
    { command: 'help', description: 'Help' },
    { command: 'rules', description: 'Rules' }
  ]);
}

async function startBot() {
  const base = webhookBaseUrl();
  if (base) {
    usingWebhook = true;
    const url = base + HOOK_PATH;
    await bot.telegram.setWebhook(url, { secret_token: WEBHOOK_SECRET });
    console.log('Bot started on port', PORT, 'webhook:', base + '/webhook/...');
    try {
      await setupFilesCommands();
    } catch (err) {
      console.error('Не удалось обновить меню команд бота файлов', err);
    }
    await startStoreBot(base);
    if (supportBot) await supportBot.start(base);
    return;
  }

  await bot.launch();
  console.log('Bot started on port', PORT, '(long polling: нет WEBHOOK_URL / RENDER_EXTERNAL_URL)');
  try {
    await setupFilesCommands();
  } catch (err) {
    console.error('Не удалось обновить меню команд бота файлов', err);
  }
  await startStoreBot(null);
  if (supportBot) await supportBot.start(null);
}

server.listen(PORT, () => {
  startBot().catch((err) => {
    console.error('Не удалось запустить бота', err);
    process.exit(1);
  });
});

const stop = (signal) => {
  if (!usingWebhook) bot.stop(signal);
  if (storeBot && !usingStoreWebhook) storeBot.stop(signal);
  if (supportBot) supportBot.stop(signal);
  server.close();
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
