// Постоянное состояние ботов в закрытом канале хранения.
// Render (бесплатный тариф) стирает диск при каждом перезапуске, поэтому баны,
// муты, маршруты ответов поддержки и привязки /link хранятся JSON-файлом
// в канале STORAGE_CHANNEL_ID. Файл закреплён в канале; при изменении
// бот заменяет документ в том же сообщении (editMessageMedia).
const https = require('https');

const STATE_FILENAME = 'steamy-state.json';
const STATE_CAPTION = '#steamy_state — служебный файл ботов. Не удаляйте и не открепляйте.';
const STATE_VERSION = 1;
const DEFAULT_DEBOUNCE_MS = 3000;
const MAX_STATE_BYTES = 5 * 1024 * 1024;

function emptyState() {
  return { v: STATE_VERSION, support: { banned: [], mutes: {}, routes: {} }, links: {} };
}

function normalizeState(raw) {
  const out = emptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const sup = raw.support && typeof raw.support === 'object' ? raw.support : {};
  if (Array.isArray(sup.banned)) {
    out.support.banned = Array.from(new Set(sup.banned.map(Number).filter((n) => Number.isInteger(n) && n > 0)));
  }
  if (sup.mutes && typeof sup.mutes === 'object' && !Array.isArray(sup.mutes)) {
    for (const [id, until] of Object.entries(sup.mutes)) {
      const userId = Number(id);
      const ts = Number(until);
      if (Number.isInteger(userId) && userId > 0 && Number.isFinite(ts)) out.support.mutes[String(userId)] = ts;
    }
  }
  if (sup.routes && typeof sup.routes === 'object' && !Array.isArray(sup.routes)) {
    for (const [key, userId] of Object.entries(sup.routes)) {
      const n = Number(userId);
      if (/^-?\d+:\d+$/.test(key) && Number.isInteger(n) && n > 0) out.support.routes[key] = n;
    }
  }
  if (raw.links && typeof raw.links === 'object' && !Array.isArray(raw.links)) {
    for (const [gameId, posts] of Object.entries(raw.links)) {
      if (!/^\d+$/.test(gameId) || !Array.isArray(posts)) continue;
      const ids = posts.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length) out.links[gameId] = ids;
    }
  }
  return out;
}

function parseIdList(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function isStateMessage(msg) {
  return Boolean(
    msg &&
    msg.document &&
    (msg.document.file_name === STATE_FILENAME || String(msg.caption || '').includes('#steamy_state'))
  );
}

function errText(err) {
  return String((err && (err.description || err.message)) || err || '');
}

function downloadText(url, maxBytes) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('download failed: HTTP ' + res.statusCode));
        return;
      }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error('state file too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.setTimeout(15000, () => req.destroy(new Error('download timeout')));
    req.on('error', reject);
  });
}

function createChannelState(options) {
  const opts = options || {};
  const telegram = opts.telegram;
  const channelId = opts.channelId;
  const debounceMs = opts.debounceMs != null ? opts.debounceMs : DEFAULT_DEBOUNCE_MS;
  const snapshot = typeof opts.snapshot === 'function' ? opts.snapshot : () => emptyState();
  const download = opts.download || ((url) => downloadText(url, MAX_STATE_BYTES));
  const log = opts.log || console;

  let messageId = null;
  let loaded = false;
  let lastJson = null;
  let timer = null;
  let chain = Promise.resolve();

  const apply = typeof opts.apply === 'function' ? opts.apply : () => {};
  const retryDelaysMs = Array.isArray(opts.retryDelaysMs) ? opts.retryDelaysMs : [1000, 3000];
  const backgroundRetryMs = opts.backgroundRetryMs != null ? opts.backgroundRetryMs : 60 * 1000;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let pendingSave = false;
  let retryTimer = null;

  // Читает закреплённый файл. Возвращает состояние, null (файла ещё нет) или бросает ошибку.
  async function readPinned() {
    const chat = await telegram.getChat(channelId);
    const pinned = chat && chat.pinned_message;
    if (!isStateMessage(pinned)) return null;
    const link = await telegram.getFileLink(pinned.document.file_id);
    const text = await download(String(link));
    const state = normalizeState(JSON.parse(text));
    messageId = pinned.message_id;
    return state;
  }

  function markLoaded(state) {
    loaded = true;
    if (state) lastJson = JSON.stringify(state);
    try {
      apply(state || emptyState());
    } catch (err) {
      log.error && log.error('Не удалось применить состояние', errText(err));
    }
    if (pendingSave) {
      pendingSave = false;
      scheduleSave();
    }
  }

  async function attempt() {
    try {
      const state = await readPinned();
      if (!state) {
        log.warn && log.warn('Файла состояния в канале пока нет, он появится при первом изменении');
      } else {
        log.log && log.log('Состояние загружено из канала хранения');
      }
      markLoaded(state);
      return true;
    } catch (err) {
      log.error && log.error('Не удалось загрузить состояние из канала', errText(err));
      return false;
    }
  }

  // Загрузка при старте. Пока загрузка не удалась, в канал ничего не пишется,
  // чтобы не затереть сохранённые баны пустым файлом.
  async function load() {
    if (!telegram || !channelId) {
      markLoaded(null);
      return false;
    }
    if (await attempt()) return true;
    for (const delay of retryDelaysMs) {
      await sleep(delay);
      if (await attempt()) return true;
    }
    const retry = async () => {
      retryTimer = null;
      if (loaded) return;
      if (!(await attempt())) {
        retryTimer = setTimeout(retry, backgroundRetryMs);
        if (retryTimer.unref) retryTimer.unref();
      }
    };
    retryTimer = setTimeout(retry, backgroundRetryMs);
    if (retryTimer.unref) retryTimer.unref();
    return false;
  }

  async function createMessage(buf) {
    const sent = await telegram.sendDocument(
      channelId,
      { source: buf, filename: STATE_FILENAME },
      { caption: STATE_CAPTION, disable_notification: true }
    );
    messageId = sent && sent.message_id;
    if (messageId) {
      try {
        await telegram.pinChatMessage(channelId, messageId, { disable_notification: true });
      } catch (err) {
        log.error && log.error('Не удалось закрепить файл состояния в канале', errText(err));
      }
    }
  }

  async function writeNow() {
    if (!telegram || !channelId) return false;
    const state = normalizeState(snapshot());
    state.updatedAt = new Date().toISOString();
    const json = JSON.stringify(Object.assign({}, state, { updatedAt: undefined }));
    if (json === lastJson) return true;
    const buf = Buffer.from(JSON.stringify(state, null, 1) + '\n', 'utf8');
    try {
      if (messageId) {
        try {
          await telegram.editMessageMedia(channelId, messageId, undefined, {
            type: 'document',
            media: { source: buf, filename: STATE_FILENAME },
            caption: STATE_CAPTION
          });
        } catch (err) {
          const desc = errText(err);
          if (/not modified/i.test(desc)) {
            lastJson = json;
            return true;
          }
          if (/not found|can't be edited|message_id_invalid|MESSAGE_ID_INVALID/i.test(desc)) {
            messageId = null;
            await createMessage(buf);
          } else {
            throw err;
          }
        }
      } else {
        await createMessage(buf);
      }
      lastJson = json;
      return true;
    } catch (err) {
      log.error && log.error('Не удалось сохранить состояние в канал', errText(err));
      return false;
    }
  }

  function enqueueWrite() {
    const run = chain.then(() => writeNow());
    chain = run.catch(() => false);
    return run;
  }

  function scheduleSave() {
    if (!loaded) {
      pendingSave = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      enqueueWrite();
    }, debounceMs);
    if (timer.unref) timer.unref();
  }

  async function flush() {
    if (!loaded) return false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
      return enqueueWrite();
    }
    return chain;
  }

  return {
    load,
    scheduleSave,
    flush,
    writeNow: enqueueWrite,
    get messageId() {
      return messageId;
    },
    get loaded() {
      return loaded;
    },
    stop() {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
}

module.exports = {
  STATE_FILENAME,
  STATE_CAPTION,
  emptyState,
  normalizeState,
  parseIdList,
  isStateMessage,
  createChannelState
};
