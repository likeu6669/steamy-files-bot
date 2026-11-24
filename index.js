const { Telegraf } = require('telegraf');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID || '-1004302896014';
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s))
  .filter((n) => Number.isInteger(n));

const FILES_PATH = path.join(__dirname, 'files.json');
const RATE_MS = 10000;
const PART_DELAY_MS = 400;
const MINI_APP_URL = 'https://t.me/SteamyStore_bot?startapp';

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

function isAdmin(ctx) {
  return Boolean(ctx.from && ADMIN_IDS.includes(ctx.from.id));
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

async function sendGameFiles(telegram, chatId, gameId) {
  const posts = Array.isArray(files[gameId]) ? files[gameId] : [];
  if (!posts.length) {
    await telegram.sendMessage(chatId, 'Файл для этой игры ещё не загружен.');
    return false;
  }

  let sent = 0;
  for (let i = 0; i < posts.length; i++) {
    try {
      await telegram.copyMessage(chatId, STORAGE_CHANNEL_ID, posts[i]);
      sent += 1;
    } catch (err) {
      const desc = (err && err.description) || (err && err.message) || 'неизвестная ошибка';
      console.error('copyMessage failed', { gameId, postId: posts[i], desc });
      if (String(desc).includes('blocked') || String(desc).includes('bot was blocked')) {
        return false;
      }
      await telegram.sendMessage(
        chatId,
        posts.length > 1
          ? `Не удалось отправить часть ${i + 1} из ${posts.length}. Попробуйте ещё раз позже.`
          : 'Не удалось отправить файл. Попробуйте ещё раз позже.'
      ).catch(() => {});
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
  res.writeHead(200);
  res.end('Bot is alive');
});

bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  if (!payload || !payload.startsWith('game_')) {
    return ctx.reply(
      'Привет! Я бот-хранилище Steamy Store.\nВыбери игру в Mini App и нажми «Скачать в Telegram».\n\n' +
      MINI_APP_URL
    );
  }

  const gameId = String(payload).replace('game_', '');
  if (!isGameId(gameId)) {
    return ctx.reply('Некорректный идентификатор игры.');
  }

  if (!isAdmin(ctx) && ctx.from && rateLimited(ctx.from.id)) {
    return ctx.reply('Подождите несколько секунд перед следующим запросом.');
  }

  try {
    await sendGameFiles(ctx.telegram, ctx.chat.id, gameId);
  } catch (err) {
    console.error('start delivery failed', err);
    await ctx.reply('Не удалось отправить файл. Попробуйте ещё раз позже.').catch(() => {});
  }
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
  const gameId = ctx.message.text.split(/\s+/)[1];
  if (!isGameId(gameId || '')) {
    return ctx.reply('Использование: /test 2');
  }
  try {
    await sendGameFiles(ctx.telegram, ctx.chat.id, gameId);
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
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});

async function startBot() {
  const base = webhookBaseUrl();
  if (base) {
    usingWebhook = true;
    const url = base + HOOK_PATH;
    await bot.telegram.setWebhook(url, { secret_token: WEBHOOK_SECRET });
    console.log('Bot started on port', PORT, 'webhook:', base + '/webhook/...');
    return;
  }

  await bot.launch();
  console.log('Bot started on port', PORT, '(long polling: нет WEBHOOK_URL / RENDER_EXTERNAL_URL)');
}

server.listen(PORT, () => {
  startBot().catch((err) => {
    console.error('Не удалось запустить бота', err);
    process.exit(1);
  });
});

const stop = (signal) => {
  if (!usingWebhook) bot.stop(signal);
  server.close();
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
