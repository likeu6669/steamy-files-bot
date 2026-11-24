const { Telegraf } = require('telegraf');
const fs = require('fs');

const bot = new Telegraf(process.env.BOT_TOKEN); // токен из переменной окружения

const DB_FILE = './games.json';

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Админ-команда: /add 2  → потом отправь файл
bot.command('add', async (ctx) => {
  const id = ctx.message.text.split(' ')[1];
  if (!id) return ctx.reply('Использование: /add 2');
  ctx.session = ctx.session || {};
  ctx.session.waitingForFile = id;
  await ctx.reply(`Отправь файл для игры ID ${id}`);
});

bot.on('document', async (ctx) => {
  if (!ctx.session?.waitingForFile) return;
  const gameId = ctx.session.waitingForFile;
  const fileId = ctx.message.document.file_id;
  const db = loadDB();
  db[gameId] = fileId;
  saveDB(db);
  delete ctx.session.waitingForFile;
  await ctx.reply(`Файл сохранён для игры ${gameId}`);
});

// Обработка перехода из Mini App: /start game_2
bot.start(async (ctx) => {
  const payload = ctx.startPayload; // game_2
  if (!payload || !payload.startsWith('game_')) {
    return ctx.reply('Привет! Я бот-хранилище Steamy Store.\nВыбери игру в Mini App и нажми «Скачать в Telegram».');
  }

  const gameId = payload.replace('game_', '');
  const db = loadDB();
  const fileId = db[gameId];

  if (!fileId) {
    return ctx.reply(`Файл для этой игры ещё не загружен.\nНапиши админу.`);
  }

  await ctx.replyWithDocument(fileId, {
    caption: `Игра ID ${gameId}\nПриятной игры 🔥`
  });
});

bot.launch();
console.log('Bot started');
