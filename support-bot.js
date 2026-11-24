const { Telegraf } = require('telegraf');
const fs = require('fs');
const crypto = require('crypto');

const TOPICS = {
  ads: { ru: 'Реклама', en: 'Advertising', emoji: '📣' },
  help: { ru: 'Помощь', en: 'Help', emoji: '🆘' },
  rights: { ru: 'Правообладателям', en: 'Rights holders', emoji: '©️' },
  other: { ru: 'Другое', en: 'Other', emoji: '💬' }
};

const DEFAULT_TOPIC = 'other';
const FLOOD_MINUTE_LIMIT = 3;
const FLOOD_MINUTE_MS = 60 * 1000;
const FLOOD_DAY_LIMIT = 20;
const FLOOD_DAY_MS = 24 * 60 * 60 * 1000;
const STRIKE_LIMIT = 3;
const STRIKE_WINDOW_MS = 10 * 60 * 1000;
const MUTE_MS = 60 * 60 * 1000;
const DUP_WINDOW_MS = 10 * 60 * 1000;
const FLOOD_LIMIT = FLOOD_MINUTE_LIMIT;
const FLOOD_WINDOW_MS = FLOOD_MINUTE_MS;
const MAX_ROUTES = 2000;

const TEXTS = {
  ru: {
    welcome:
      'Привет! Это поддержка Steamy Store.\n' +
      'Выберите тему и напишите сообщение — мы ответим здесь.',
    writePrivate: 'Напишите мне в личные сообщения.',
    prompt:
      'Напишите сообщение одним или несколькими сообщениями, можно с фото/файлом.',
    topicSet: 'Тема',
    ack: 'Сообщение получено, ответим здесь.',
    flood: 'Слишком много сообщений. Подождите минуту и напишите снова.',
    floodDay: 'На сегодня лимит сообщений исчерпан. Попробуйте завтра.',
    muted: 'Слишком много сообщений подряд. Написать снова можно через час.',
    banned: 'Вы не можете писать в поддержку.',
    noAdmins: 'Сейчас поддержка недоступна. Попробуйте позже.',
    deliverFailed: 'Не удалось доставить сообщение. Попробуйте ещё раз позже.',
    prefix: 'Ответ поддержки:'
  },
  en: {
    welcome:
      'Hi! This is Steamy Store support.\n' +
      'Pick a topic and send a message — we will reply here.',
    writePrivate: 'Please message me in a private chat.',
    prompt: 'Send one or more messages, you can attach a photo or a file.',
    topicSet: 'Topic',
    ack: 'Got your message, we will reply here.',
    flood: 'Too many messages. Please wait a minute and try again.',
    floodDay: 'You have reached today’s message limit. Please try again tomorrow.',
    muted: 'Too many messages in a row. You can write again in an hour.',
    banned: 'You cannot message support.',
    noAdmins: 'Support is unavailable right now. Please try again later.',
    deliverFailed: 'Could not deliver your message. Please try again later.',
    prefix: 'Support reply:'
  }
};

function normalizeUsername(raw) {
  const value = String(raw || '').trim().replace(/^@+/, '');
  return value ? '@' + value : '';
}

function supportLang(ctxOrCode) {
  const raw = ctxOrCode && ctxOrCode.from
    ? ctxOrCode.from.language_code
    : ctxOrCode;
  const code = String(raw || 'ru').toLowerCase();
  return code.startsWith('en') ? 'en' : 'ru';
}

function topicLabel(topicKey, lang) {
  const topic = TOPICS[topicKey] || TOPICS[DEFAULT_TOPIC];
  const name = topic[lang] || topic.ru;
  return topic.emoji + ' ' + name;
}

function topicKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📣 Реклама', callback_data: 'topic:ads' },
        { text: '🆘 Помощь', callback_data: 'topic:help' }
      ],
      [
        { text: '©️ Правообладателям', callback_data: 'topic:rights' },
        { text: '💬 Другое', callback_data: 'topic:other' }
      ]
    ]
  };
}

function displayName(user) {
  if (!user) return 'Пользователь';
  const parts = [user.first_name, user.last_name].filter(Boolean);
  return parts.join(' ') || 'Пользователь';
}

function formatHeader({ topicKey, name, username, userId, lang }) {
  const from = username ? name + ' (@' + username + ')' : name;
  return (
    topicLabel(topicKey, 'ru') +
    '\n\n' +
    'От: ' + from + '\n' +
    'ID: ' + userId + '\n' +
    'Язык: ' + (lang || 'ru') +
    '\n\n' +
    'Чтобы ответить, сделайте реплай на это или на следующее сообщение — или напишите:\n' +
    '/reply ' + userId + ' текст'
  );
}

function parseReplyCommand(text) {
  const match = String(text || '').match(/^\/reply(?:@\w+)?\s+(\d+)\s+([\s\S]+)$/);
  if (!match) return null;
  const userId = Number(match[1]);
  const body = match[2].trim();
  if (!Number.isInteger(userId) || userId <= 0 || !body) return null;
  return { userId, text: body };
}

function parseUserIdCommand(command, text) {
  const match = String(text || '').match(new RegExp('^/' + command + '(?:@\\w+)?\\s+(\\d+)\\s*$'));
  if (!match) return null;
  const userId = Number(match[1]);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  return userId;
}

function routeKey(adminChatId, messageId) {
  return String(adminChatId) + ':' + String(messageId);
}

function checkFlood(timestamps, now, limit, windowMs) {
  const recent = (timestamps || []).filter((ts) => now - ts < windowMs);
  return { limited: recent.length >= limit, recent };
}

function emptyFloodRecord() {
  return {
    minute: [],
    day: [],
    strikes: [],
    muteUntil: 0,
    muteNotified: false,
    minuteNoticeAt: 0,
    dayNoticeAt: 0,
    lastFingerprint: '',
    lastFingerprintAt: 0,
    topicTimes: [],
    bannedNotified: false
  };
}

function extractFileUniqueId(msg) {
  if (!msg) return '';
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1];
    return (best && best.file_unique_id) || '';
  }
  const keys = ['document', 'video', 'voice', 'audio', 'animation', 'sticker', 'video_note'];
  for (const key of keys) {
    if (msg[key] && msg[key].file_unique_id) return msg[key].file_unique_id;
  }
  return '';
}

function messageFingerprint(msg) {
  const fileId = extractFileUniqueId(msg);
  if (fileId) return 'file:' + fileId;
  const text = String((msg && (msg.text || msg.caption)) || '').trim();
  if (text) return 'text:' + text;
  return '';
}

function isRecentDuplicate(record, fingerprint, now) {
  if (!fingerprint || !record || !record.lastFingerprint) return false;
  if (record.lastFingerprint !== fingerprint) return false;
  return now - (record.lastFingerprintAt || 0) < DUP_WINDOW_MS;
}

function evaluateMessageLimits(record, now) {
  const rec = record || emptyFloodRecord();
  if (rec.muteUntil && rec.muteUntil > now) {
    return {
      action: 'muted',
      notifyUser: !rec.muteNotified,
      notifyAdmins: false,
      record: Object.assign({}, rec, { muteNotified: true })
    };
  }

  const minute = checkFlood(rec.minute, now, FLOOD_MINUTE_LIMIT, FLOOD_MINUTE_MS).recent;
  const day = checkFlood(rec.day, now, FLOOD_DAY_LIMIT, FLOOD_DAY_MS).recent;
  const strikes = checkFlood(rec.strikes, now, STRIKE_LIMIT, STRIKE_WINDOW_MS).recent;

  let reason = null;
  if (minute.length >= FLOOD_MINUTE_LIMIT) reason = 'minute';
  else if (day.length >= FLOOD_DAY_LIMIT) reason = 'day';

  if (reason) {
    const lastNotice = reason === 'minute' ? rec.minuteNoticeAt : rec.dayNoticeAt;
    const windowMs = reason === 'minute' ? FLOOD_MINUTE_MS : FLOOD_DAY_MS;
    const isNewHit = !lastNotice || now - lastNotice >= windowMs;
    let newStrikes = strikes;
    let muteUntil = 0;
    let muteNow = false;
    if (isNewHit) {
      newStrikes = strikes.concat(now);
      if (newStrikes.length >= STRIKE_LIMIT) {
        muteUntil = now + MUTE_MS;
        muteNow = true;
        newStrikes = [];
      }
    }
    return {
      action: muteNow ? 'muted' : 'limited',
      reason,
      notifyUser: muteNow || isNewHit,
      notifyAdmins: muteNow,
      record: Object.assign({}, rec, {
        minute,
        day,
        strikes: newStrikes,
        muteUntil: muteNow ? muteUntil : rec.muteUntil || 0,
        muteNotified: muteNow ? true : rec.muteNotified,
        minuteNoticeAt: reason === 'minute' && isNewHit ? now : rec.minuteNoticeAt,
        dayNoticeAt: reason === 'day' && isNewHit ? now : rec.dayNoticeAt
      })
    };
  }

  return {
    action: 'ok',
    record: Object.assign({}, rec, {
      minute: minute.concat(now),
      day: day.concat(now),
      muteUntil: 0,
      muteNotified: false
    })
  };
}

function rememberFingerprint(record, fingerprint, now) {
  return Object.assign({}, record, {
    lastFingerprint: fingerprint || '',
    lastFingerprintAt: fingerprint ? now : 0
  });
}

function evaluateTopicLimit(record, now) {
  const rec = record || emptyFloodRecord();
  if (rec.muteUntil && rec.muteUntil > now) {
    return { limited: true, record: rec };
  }
  const recent = checkFlood(rec.topicTimes, now, FLOOD_MINUTE_LIMIT, FLOOD_MINUTE_MS).recent;
  if (recent.length >= FLOOD_MINUTE_LIMIT) {
    return { limited: true, record: Object.assign({}, rec, { topicTimes: recent }) };
  }
  return {
    limited: false,
    record: Object.assign({}, rec, { topicTimes: recent.concat(now) })
  };
}

function floodNoticeText(lang, result) {
  const txt = TEXTS[lang] || TEXTS.ru;
  if (result.action === 'muted') return txt.muted;
  if (result.reason === 'day') return txt.floodDay;
  return txt.flood;
}

async function tryDeleteUserMessage(ctx) {
  const chatId = ctx.chat && ctx.chat.id;
  const messageId = ctx.message && ctx.message.message_id;
  if (!chatId || !messageId || !ctx.telegram) return;
  try {
    await ctx.telegram.deleteMessage(chatId, messageId);
  } catch {
    // 48 hours passed, already deleted, or the bot cannot delete it
  }
}

function limitReplyKind(result) {
  return result && result.action === 'muted' ? 'mute' : 'wait';
}

function replaceSupportReply(helper, ctx, kind, sendFn) {
  if (typeof helper === 'function') {
    return helper(ctx, 'support', kind, sendFn, { deleteIncoming: false });
  }
  return sendFn();
}

function prefixText(body, lang) {
  const texts = TEXTS[lang] || TEXTS.ru;
  return texts.prefix + '\n\n' + body;
}

function isPrivateChat(ctx) {
  return Boolean(ctx.chat && ctx.chat.type === 'private');
}

function isAdminUser(userId, adminIds) {
  return adminIds.includes(Number(userId));
}

function hasForwardableContent(msg) {
  if (!msg) return false;
  return Boolean(
    msg.text ||
    msg.caption ||
    msg.photo ||
    msg.document ||
    msg.video ||
    msg.voice ||
    msg.audio ||
    msg.animation ||
    msg.sticker ||
    msg.video_note
  );
}

function isSlashCommand(msg) {
  return Boolean(msg && msg.text && msg.text.startsWith('/'));
}

function isCaptionable(msg) {
  if (!msg) return false;
  return Boolean(msg.photo || msg.document || msg.video || msg.voice || msg.audio || msg.animation);
}

function describeSendError(err) {
  const desc = (err && err.description) || (err && err.message) || 'неизвестная ошибка';
  if (/blocked by the user/i.test(desc) || /bot was blocked/i.test(desc)) {
    return 'Пользователь заблокировал бота.';
  }
  if (/chat not found/i.test(desc)) {
    return 'Чат с пользователем не найден. Возможно, он ещё не нажал Start.';
  }
  return 'Не удалось отправить: ' + desc;
}

function loadState(statePath) {
  const empty = { banned: [], routes: {}, mutes: {} };
  if (!statePath || !fs.existsSync(statePath)) return empty;
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const banned = Array.isArray(data && data.banned) ? data.banned.map(Number).filter((n) => Number.isInteger(n)) : [];
    const routes = data && data.routes && typeof data.routes === 'object' && !Array.isArray(data.routes) ? data.routes : {};
    const mutes = {};
    const rawMutes = data && data.mutes && typeof data.mutes === 'object' && !Array.isArray(data.mutes) ? data.mutes : {};
    const now = Date.now();
    for (const [id, until] of Object.entries(rawMutes)) {
      const userId = Number(id);
      const ts = Number(until);
      if (Number.isInteger(userId) && userId > 0 && ts > now) mutes[userId] = ts;
    }
    return { banned, routes, mutes };
  } catch {
    return empty;
  }
}

function saveState(statePath, bannedSet, routesMap, mutesMap) {
  if (!statePath) return false;
  try {
    const routes = {};
    for (const [key, userId] of routesMap) routes[key] = userId;
    const mutes = {};
    const now = Date.now();
    if (mutesMap) {
      for (const [id, until] of mutesMap) {
        const ts = Number(until);
        if (ts > now) mutes[String(id)] = ts;
      }
    }
    fs.writeFileSync(
      statePath,
      JSON.stringify({ banned: Array.from(bannedSet), routes, mutes }, null, 2) + '\n'
    );
    return true;
  } catch {
    return false;
  }
}

function rememberRoute(routes, adminChatId, messageId, userId) {
  if (!messageId) return;
  routes.set(routeKey(adminChatId, messageId), Number(userId));
  while (routes.size > MAX_ROUTES) {
    const oldest = routes.keys().next().value;
    routes.delete(oldest);
  }
}

function createSupportBot({ token, adminIds, statePath, replaceCommandReply }) {
  const admins = Array.isArray(adminIds) ? adminIds.slice() : [];
  const hookSecret = crypto.createHash('sha256').update('support:' + token).digest('hex').slice(0, 32);
  const hookPath = '/webhook/support/' + hookSecret;
  const bot = new Telegraf(token);
  const handleWebhook = bot.webhookCallback(hookPath, { secretToken: hookSecret });

  const saved = loadState(statePath);
  const banned = new Set(saved.banned);
  const routes = new Map(Object.entries(saved.routes).map(([key, userId]) => [key, Number(userId)]));
  const mutes = new Map(Object.entries(saved.mutes || {}).map(([id, until]) => [Number(id), Number(until)]));
  const sessions = new Map();
  const floods = new Map();
  let usingWebhook = false;

  function persist() {
    saveState(statePath, banned, routes, mutes);
  }

  function getFlood(userId) {
    let rec = floods.get(userId);
    if (!rec) rec = emptyFloodRecord();
    const until = mutes.get(userId) || 0;
    if (until > Date.now()) rec.muteUntil = until;
    floods.set(userId, rec);
    return rec;
  }

  function setFlood(userId, rec) {
    floods.set(userId, rec);
    if (rec && rec.muteUntil && rec.muteUntil > Date.now()) {
      mutes.set(userId, rec.muteUntil);
    } else {
      mutes.delete(userId);
    }
  }

  function clearMute(userId) {
    mutes.delete(userId);
    const rec = floods.get(userId);
    if (rec) {
      rec.muteUntil = 0;
      rec.muteNotified = false;
      rec.strikes = [];
      rec.minuteNoticeAt = 0;
      rec.dayNoticeAt = 0;
      rec.bannedNotified = false;
    }
  }

  async function notifyAdminsMute(telegram, user) {
    const name = displayName(user);
    const who = user && user.username ? name + ' (@' + user.username + ')' : name;
    const text = 'Пользователь ' + (user && user.id) + ' (' + who + ') временно заглушён на час из-за флуда.';
    for (const adminId of admins) {
      try {
        await telegram.sendMessage(adminId, text);
      } catch (err) {
        console.error('support mute notice failed', { adminId, desc: (err && err.description) || err.message });
      }
    }
  }

  function getSession(userId) {
    let session = sessions.get(userId);
    if (!session) {
      session = { topic: DEFAULT_TOPIC, lang: 'ru', ackForTopic: null };
      sessions.set(userId, session);
    }
    return session;
  }

  async function sendWelcome(ctx) {
    const lang = supportLang(ctx);
    const txt = TEXTS[lang];
    return ctx.reply(txt.welcome, { reply_markup: topicKeyboard() });
  }

  async function copyToChat(telegram, toChatId, fromChatId, message) {
    try {
      return await telegram.copyMessage(toChatId, fromChatId, message.message_id);
    } catch (err) {
      const fallback = message.text || message.caption;
      if (fallback) {
        return telegram.sendMessage(toChatId, fallback);
      }
      throw err;
    }
  }

  async function deliverToAdmins(telegram, user, message, session) {
    if (!admins.length) return 0;
    const header = formatHeader({
      topicKey: session.topic,
      name: displayName(user),
      username: user.username || '',
      userId: user.id,
      lang: session.lang
    });
    let delivered = 0;
    for (const adminId of admins) {
      try {
        const headerMsg = await telegram.sendMessage(adminId, header);
        rememberRoute(routes, adminId, headerMsg && headerMsg.message_id, user.id);
        const copied = await copyToChat(telegram, adminId, message.chat.id, message);
        rememberRoute(routes, adminId, copied && copied.message_id, user.id);
        delivered += 1;
      } catch (err) {
        console.error('support deliver to admin failed', { adminId, desc: (err && err.description) || err.message });
      }
    }
    if (delivered) persist();
    return delivered;
  }

  async function sendReplyToUser(telegram, userId, source, textOverride) {
    const session = getSession(userId);
    const lang = session.lang || 'ru';
    if (typeof textOverride === 'string') {
      await telegram.sendMessage(userId, prefixText(textOverride, lang));
      return;
    }
    const msg = source;
    const hasMedia = Boolean(
      msg.photo || msg.document || msg.video || msg.voice || msg.audio || msg.animation || msg.sticker || msg.video_note
    );
    if (msg.text && !hasMedia) {
      await telegram.sendMessage(userId, prefixText(msg.text, lang));
      return;
    }
    if (isCaptionable(msg)) {
      const caption = msg.caption ? prefixText(msg.caption, lang) : (TEXTS[lang] || TEXTS.ru).prefix;
      try {
        await telegram.copyMessage(userId, msg.chat.id, msg.message_id, { caption });
        return;
      } catch {
        await telegram.copyMessage(userId, msg.chat.id, msg.message_id);
        return;
      }
    }
    await telegram.copyMessage(userId, msg.chat.id, msg.message_id);
  }

  bot.start(async (ctx) => {
    if (!isPrivateChat(ctx)) {
      return ctx.reply(TEXTS[supportLang(ctx)].writePrivate);
    }
    const session = getSession(ctx.from.id);
    session.lang = supportLang(ctx);
    if (typeof replaceCommandReply === 'function') {
      return replaceCommandReply(ctx, 'support', 'start', () => sendWelcome(ctx));
    }
    return sendWelcome(ctx);
  });

  bot.command('help', async (ctx) => {
    if (!isPrivateChat(ctx)) {
      return ctx.reply(TEXTS[supportLang(ctx)].writePrivate);
    }
    const session = getSession(ctx.from.id);
    session.lang = supportLang(ctx);
    if (typeof replaceCommandReply === 'function') {
      return replaceCommandReply(ctx, 'support', 'start', () => sendWelcome(ctx));
    }
    return sendWelcome(ctx);
  });

  bot.command('reply', async (ctx) => {
    if (!isAdminUser(ctx.from && ctx.from.id, admins)) {
      if (isPrivateChat(ctx)) await tryDeleteUserMessage(ctx);
      return;
    }
    if (!isPrivateChat(ctx)) {
      return ctx.reply(TEXTS.ru.writePrivate);
    }
    const parsed = parseReplyCommand(ctx.message && ctx.message.text);
    if (!parsed) {
      return ctx.reply('Использование: /reply 123456789 текст ответа');
    }
    try {
      await sendReplyToUser(ctx.telegram, parsed.userId, null, parsed.text);
      await ctx.reply('✅ Отправлено');
    } catch (err) {
      await ctx.reply(describeSendError(err));
    }
  });

  bot.command('ban', async (ctx) => {
    if (!isAdminUser(ctx.from && ctx.from.id, admins)) {
      if (isPrivateChat(ctx)) await tryDeleteUserMessage(ctx);
      return;
    }
    const userId = parseUserIdCommand('ban', ctx.message && ctx.message.text);
    if (!userId) return ctx.reply('Использование: /ban 123456789');
    banned.add(userId);
    persist();
    await ctx.reply('Пользователь ' + userId + ' заблокирован.');
  });

  bot.command('unban', async (ctx) => {
    if (!isAdminUser(ctx.from && ctx.from.id, admins)) {
      if (isPrivateChat(ctx)) await tryDeleteUserMessage(ctx);
      return;
    }
    const userId = parseUserIdCommand('unban', ctx.message && ctx.message.text);
    if (!userId) return ctx.reply('Использование: /unban 123456789');
    banned.delete(userId);
    clearMute(userId);
    persist();
    await ctx.reply('Пользователь ' + userId + ' разблокирован, мут снят.');
  });

  bot.action(/^topic:(.+)$/, async (ctx) => {
    if (!isPrivateChat(ctx)) {
      await ctx.answerCbQuery().catch(() => {});
      return ctx.reply(TEXTS[supportLang(ctx)].writePrivate);
    }
    const fromId = ctx.from && ctx.from.id;
    const admin = isAdminUser(fromId, admins);
    if (!admin) {
      if (banned.has(fromId) || (mutes.get(fromId) || 0) > Date.now()) {
        await ctx.answerCbQuery().catch(() => {});
        return;
      }
      const topicEval = evaluateTopicLimit(getFlood(fromId), Date.now());
      setFlood(fromId, topicEval.record);
      if (topicEval.limited) {
        await ctx.answerCbQuery().catch(() => {});
        return;
      }
    }
    await ctx.answerCbQuery().catch(() => {});
    const key = String(ctx.match[1] || '');
    const topicKey = TOPICS[key] ? key : DEFAULT_TOPIC;
    const lang = supportLang(ctx);
    const session = getSession(fromId);
    session.topic = topicKey;
    session.lang = lang;
    session.ackForTopic = null;
    const txt = TEXTS[lang];
    await replaceSupportReply(replaceCommandReply, ctx, 'topic', () =>
      ctx.reply(txt.topicSet + ': ' + topicLabel(topicKey, lang) + '.\n\n' + txt.prompt)
    );
  });

  bot.on('message', async (ctx) => {
    if (!isPrivateChat(ctx)) return;
    const msg = ctx.message;
    const fromId = ctx.from && ctx.from.id;
    if (!msg || !fromId) return;

    if (isSlashCommand(msg)) {
      if (!isAdminUser(fromId, admins)) {
        await tryDeleteUserMessage(ctx);
      }
      return;
    }

    if (isAdminUser(fromId, admins) && msg.reply_to_message) {
      const targetId = routes.get(routeKey(ctx.chat.id, msg.reply_to_message.message_id));
      if (targetId) {
        try {
          await sendReplyToUser(ctx.telegram, targetId, msg);
          await ctx.reply('✅ Отправлено');
        } catch (err) {
          await ctx.reply(describeSendError(err));
        }
        return;
      }
      if (msg.reply_to_message.from && msg.reply_to_message.from.is_bot) {
        await ctx.reply('Не удалось понять, кому ответить. Сделайте реплай на обращение или напишите /reply ID текст.');
        return;
      }
    }

    if (!hasForwardableContent(msg)) return;

    const admin = isAdminUser(fromId, admins);
    const lang = supportLang(ctx);
    const rec = getFlood(fromId);

    if (!admin && banned.has(fromId)) {
      if (!rec.bannedNotified) {
        rec.bannedNotified = true;
        setFlood(fromId, rec);
        await replaceSupportReply(replaceCommandReply, ctx, 'banned', () =>
          ctx.reply(TEXTS[lang].banned)
        );
      }
      return;
    }

    if (!admin) {
      const now = Date.now();
      const fingerprint = messageFingerprint(msg);
      if (isRecentDuplicate(rec, fingerprint, now)) {
        return;
      }

      const result = evaluateMessageLimits(rec, now);
      let next = result.record;
      if (result.action !== 'ok') {
        setFlood(fromId, next);
        if (result.notifyAdmins) {
          persist();
          await notifyAdminsMute(ctx.telegram, ctx.from);
        } else if (result.action === 'muted') {
          persist();
        }
        if (result.notifyUser) {
          await replaceSupportReply(replaceCommandReply, ctx, limitReplyKind(result), () =>
            ctx.reply(floodNoticeText(lang, result))
          );
        }
        return;
      }

      next = rememberFingerprint(next, fingerprint, now);
      setFlood(fromId, next);
    }

    if (!admins.length) {
      return ctx.reply(TEXTS[lang].noAdmins);
    }

    const session = getSession(fromId);
    session.lang = lang;
    if (!session.topic) session.topic = DEFAULT_TOPIC;

    const delivered = await deliverToAdmins(ctx.telegram, ctx.from, msg, session);
    if (!delivered) {
      return ctx.reply(TEXTS[session.lang].deliverFailed);
    }

    if (session.ackForTopic !== session.topic) {
      session.ackForTopic = session.topic;
      await replaceSupportReply(replaceCommandReply, ctx, 'ack', () =>
        ctx.reply(TEXTS[session.lang].ack)
      );
    }
  });

  bot.catch((err) => {
    console.error('Support bot error', err);
  });

  async function setupCommands() {
    await bot.telegram.setMyCommands(
      [{ command: 'start', description: 'Начать' }],
      { language_code: 'ru' }
    );
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Start' }
    ]);
  }

  async function start(base) {
    try {
      if (base) {
        usingWebhook = true;
        const url = base + hookPath;
        await bot.telegram.setWebhook(url, { secret_token: hookSecret });
        console.log('Support bot webhook:', base + '/webhook/support/...');
      } else {
        await bot.launch();
        console.log('Support bot started (long polling)');
      }
      await setupCommands();
    } catch (err) {
      console.error('Не удалось запустить бота поддержки (остальные боты продолжают работать)', err);
    }
  }

  function stop(signal) {
    if (!usingWebhook) bot.stop(signal);
  }

  return {
    bot,
    hookPath,
    hookSecret,
    handleWebhook,
    start,
    stop,
    get usingWebhook() {
      return usingWebhook;
    }
  };
}

module.exports = {
  createSupportBot,
  normalizeUsername,
  supportLang,
  topicLabel,
  topicKeyboard,
  displayName,
  formatHeader,
  parseReplyCommand,
  parseUserIdCommand,
  routeKey,
  checkFlood,
  prefixText,
  hasForwardableContent,
  isCaptionable,
  describeSendError,
  loadState,
  saveState,
  rememberRoute,
  emptyFloodRecord,
  extractFileUniqueId,
  messageFingerprint,
  isRecentDuplicate,
  evaluateMessageLimits,
  rememberFingerprint,
  evaluateTopicLimit,
  floodNoticeText,
  limitReplyKind,
  replaceSupportReply,
  TOPICS,
  DEFAULT_TOPIC,
  FLOOD_LIMIT,
  FLOOD_WINDOW_MS,
  FLOOD_MINUTE_LIMIT,
  FLOOD_MINUTE_MS,
  FLOOD_DAY_LIMIT,
  FLOOD_DAY_MS,
  STRIKE_LIMIT,
  STRIKE_WINDOW_MS,
  MUTE_MS,
  DUP_WINDOW_MS,
  MAX_ROUTES,
  TEXTS
};
