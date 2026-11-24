const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = {
  filesPerMinute: 5,
  filesPerDay: 40,
  fileDupMs: 30 * 1000,
  commandsPerMinute: 10,
  strikeLimit: 3,
  strikeWindowMs: 10 * 60 * 1000,
  muteMs: 60 * 60 * 1000
};

const FILE_NOTICE = {
  ru: {
    minute: 'Слишком много запросов, попробуйте через минуту.',
    day: 'На сегодня лимит запросов исчерпан. Попробуйте завтра.',
    muted: 'Слишком много запросов, попробуйте через час.'
  },
  en: {
    minute: 'Too many requests, please try again in a minute.',
    day: 'You have reached today’s request limit. Please try again tomorrow.',
    muted: 'Too many requests, please try again in an hour.'
  }
};

function readEnvInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (min != null && i < min) return min;
  if (max != null && i > max) return max;
  return i;
}

function createLimits(overrides) {
  const src = overrides || {};
  const filesPerMinute = pickInt(src.filesPerMinute, 'FILES_PER_MINUTE', DEFAULTS.filesPerMinute, 1, 100);
  const filesPerDay = pickInt(src.filesPerDay, 'FILES_PER_DAY', DEFAULTS.filesPerDay, 1, 1000);
  const fileDupMs = src.fileDupMs != null
    ? clampInt(src.fileDupMs, 0, 24 * DAY_MS)
    : readEnvInt('FILE_DUP_SECONDS', DEFAULTS.fileDupMs / 1000, 0, 24 * 60 * 60) * 1000;
  const commandsPerMinute = pickInt(src.commandsPerMinute, 'COMMANDS_PER_MINUTE', DEFAULTS.commandsPerMinute, 1, 100);
  const strikeLimit = pickInt(src.strikeLimit, 'ANTISPAM_STRIKES', DEFAULTS.strikeLimit, 1, 20);
  const strikeWindowMs = src.strikeWindowMs != null
    ? clampInt(src.strikeWindowMs, MINUTE_MS, 24 * DAY_MS)
    : readEnvInt('ANTISPAM_STRIKE_WINDOW_MS', DEFAULTS.strikeWindowMs, MINUTE_MS, 24 * DAY_MS);
  const muteMs = src.muteMs != null
    ? clampInt(src.muteMs, MINUTE_MS, 7 * DAY_MS)
    : readEnvInt('ANTISPAM_MUTE_MS', DEFAULTS.muteMs, MINUTE_MS, 7 * DAY_MS);

  return {
    filesPerMinute,
    filesPerDay,
    fileDupMs,
    commandsPerMinute,
    strikeLimit,
    strikeWindowMs,
    muteMs,
    minuteMs: MINUTE_MS,
    dayMs: DAY_MS
  };
}

function pickInt(override, envName, fallback, min, max) {
  if (override != null) return clampInt(override, min, max);
  return readEnvInt(envName, fallback, min, max);
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
}

function emptyRecord() {
  return {
    filesMinute: [],
    filesDay: [],
    cmdsMinute: [],
    recentFiles: [],
    strikes: [],
    muteUntil: 0,
    muteNotified: false,
    fileMinuteNoticeAt: 0,
    fileDayNoticeAt: 0
  };
}

function recentWindow(timestamps, now, windowMs) {
  return (timestamps || []).filter((ts) => now - ts < windowMs);
}

function applyStrike(rec, now, limits, alreadyLimited) {
  const strikes = recentWindow(rec.strikes, now, limits.strikeWindowMs);
  if (alreadyLimited) {
    return { strikes, muteNow: false, muteUntil: rec.muteUntil || 0 };
  }
  const nextStrikes = strikes.concat(now);
  if (nextStrikes.length >= limits.strikeLimit) {
    return { strikes: [], muteNow: true, muteUntil: now + limits.muteMs };
  }
  return { strikes: nextStrikes, muteNow: false, muteUntil: rec.muteUntil || 0 };
}

function mutedResult(rec, now, notifyUser) {
  return {
    action: 'muted',
    reason: 'muted',
    notifyUser: Boolean(notifyUser),
    record: Object.assign({}, rec, { muteNotified: true })
  };
}

function evaluateFileRequest(record, fileKey, now, limits) {
  const rec = record || emptyRecord();
  const key = fileKey == null ? '' : String(fileKey);

  if (rec.muteUntil && rec.muteUntil > now) {
    return mutedResult(rec, now, !rec.muteNotified);
  }

  const recentFiles = (rec.recentFiles || []).filter((item) => now - item.at < limits.fileDupMs);
  if (key && recentFiles.some((item) => item.key === key)) {
    return {
      action: 'duplicate',
      notifyUser: false,
      record: Object.assign({}, rec, { recentFiles })
    };
  }

  const filesMinute = recentWindow(rec.filesMinute, now, limits.minuteMs);
  const filesDay = recentWindow(rec.filesDay, now, limits.dayMs);
  const strikes = recentWindow(rec.strikes, now, limits.strikeWindowMs);

  let reason = null;
  if (filesMinute.length >= limits.filesPerMinute) reason = 'minute';
  else if (filesDay.length >= limits.filesPerDay) reason = 'day';

  if (reason) {
    const lastNotice = reason === 'minute' ? rec.fileMinuteNoticeAt : rec.fileDayNoticeAt;
    const windowMs = reason === 'minute' ? limits.minuteMs : limits.dayMs;
    const isNewHit = !lastNotice || now - lastNotice >= windowMs;
    const struck = applyStrike(Object.assign({}, rec, { strikes }), now, limits, !isNewHit);
    const muteNow = struck.muteNow;
    return {
      action: muteNow ? 'muted' : 'limited',
      reason: muteNow ? 'muted' : reason,
      limitReason: reason,
      notifyUser: muteNow || isNewHit,
      record: Object.assign({}, rec, {
        filesMinute,
        filesDay,
        strikes: struck.strikes,
        muteUntil: muteNow ? struck.muteUntil : rec.muteUntil || 0,
        muteNotified: muteNow ? true : rec.muteNotified,
        fileMinuteNoticeAt: reason === 'minute' && isNewHit ? now : rec.fileMinuteNoticeAt,
        fileDayNoticeAt: reason === 'day' && isNewHit ? now : rec.fileDayNoticeAt
      })
    };
  }

  return {
    action: 'ok',
    notifyUser: false,
    record: Object.assign({}, rec, {
      filesMinute: filesMinute.concat(now),
      filesDay: filesDay.concat(now),
      strikes,
      recentFiles: key ? recentFiles.concat({ key, at: now }) : recentFiles,
      muteUntil: 0,
      muteNotified: false
    })
  };
}

function evaluateCommand(record, now, limits) {
  const rec = record || emptyRecord();

  if (rec.muteUntil && rec.muteUntil > now) {
    return mutedResult(rec, now, false);
  }

  const cmdsMinute = recentWindow(rec.cmdsMinute, now, limits.minuteMs);
  const strikes = recentWindow(rec.strikes, now, limits.strikeWindowMs);

  if (cmdsMinute.length >= limits.commandsPerMinute) {
    const lastNotice = rec.cmdNoticeAt || 0;
    const isNewHit = !lastNotice || now - lastNotice >= limits.minuteMs;
    const struck = applyStrike(Object.assign({}, rec, { strikes }), now, limits, !isNewHit);
    const muteNow = struck.muteNow;
    return {
      action: muteNow ? 'muted' : 'limited',
      reason: muteNow ? 'muted' : 'minute',
      notifyUser: false,
      record: Object.assign({}, rec, {
        cmdsMinute,
        strikes: struck.strikes,
        muteUntil: muteNow ? struck.muteUntil : rec.muteUntil || 0,
        muteNotified: muteNow ? true : rec.muteNotified,
        cmdNoticeAt: isNewHit ? now : rec.cmdNoticeAt
      })
    };
  }

  return {
    action: 'ok',
    notifyUser: false,
    record: Object.assign({}, rec, {
      cmdsMinute: cmdsMinute.concat(now),
      strikes,
      muteUntil: 0,
      muteNotified: false
    })
  };
}

function fileNoticeText(lang, result) {
  const texts = FILE_NOTICE[lang] || FILE_NOTICE.ru;
  if (result && result.action === 'muted') return texts.muted;
  if (result && (result.reason === 'day' || result.limitReason === 'day')) return texts.day;
  return texts.minute;
}

function fileNoticeKind(result) {
  return result && result.action === 'muted' ? 'mute' : 'wait';
}

function isCommandUpdate(ctx) {
  if (!ctx) return false;
  if (ctx.callbackQuery) return true;
  const text = ctx.message && ctx.message.text;
  return Boolean(text && text.startsWith('/'));
}

function parseStartGameId(ctx) {
  const payload = ctx && ctx.startPayload;
  if (payload != null && String(payload).trim()) {
    return gameIdFromPayload(payload);
  }
  const text = ctx && ctx.message && ctx.message.text;
  const match = String(text || '').match(/^\/start(?:@\w+)?(?:\s+|$)([\s\S]*)$/);
  if (!match) return '';
  return gameIdFromPayload(match[1]);
}

function gameIdFromPayload(raw) {
  const payload = String(raw || '').trim();
  if (!payload.startsWith('game_')) return '';
  const gameId = payload.slice('game_'.length);
  return /^\d+$/.test(gameId) ? gameId : '';
}

function telegramRetryAfterSec(err) {
  if (!err) return 0;
  const params = err.parameters || (err.response && err.response.parameters) || {};
  const direct = params.retry_after != null ? params.retry_after : err.retry_after;
  const n = Number(direct);
  if (Number.isFinite(n) && n > 0) return n;
  const desc = String(err.description || err.message || '');
  const match = desc.match(/retry after (\d+)/i);
  if (match) return Number(match[1]);
  return 0;
}

function isTelegramFloodError(err) {
  if (!err) return false;
  const code = err.error_code || err.code || (err.response && err.response.error_code);
  if (Number(code) === 429) return true;
  const desc = String(err.description || err.message || '');
  return /too many requests|\bflood\b|retry after/i.test(desc);
}

function logBotError(tag, err) {
  if (isTelegramFloodError(err)) {
    console.warn(tag + ' Telegram 429', {
      retry_after: telegramRetryAfterSec(err),
      description: err && (err.description || err.message)
    });
    return;
  }
  console.error(tag, err);
}

async function withTelegramRetry(fn, options) {
  const opts = options || {};
  const maxAttempts = opts.maxAttempts || 2;
  const sleepFn = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxWaitMs = opts.maxWaitMs != null ? opts.maxWaitMs : 60 * 1000;
  const log = opts.log || console.warn;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTelegramFloodError(err) && !telegramRetryAfterSec(err)) throw err;
      const waitSec = telegramRetryAfterSec(err) || 1;
      const waitMs = Math.min(waitSec * 1000, maxWaitMs);
      log('Telegram 429', {
        retry_after: waitSec,
        waited_ms: waitMs,
        attempt,
        label: opts.label || ''
      });
      if (attempt >= maxAttempts) throw err;
      await sleepFn(waitMs);
    }
  }
  throw lastErr;
}

function recordActivityAt(rec) {
  const times = []
    .concat(rec.filesMinute || [])
    .concat(rec.filesDay || [])
    .concat(rec.cmdsMinute || [])
    .concat(rec.strikes || [])
    .concat((rec.recentFiles || []).map((item) => item.at))
    .concat(rec.fileMinuteNoticeAt || 0)
    .concat(rec.fileDayNoticeAt || 0)
    .concat(rec.cmdNoticeAt || 0);
  return times.reduce((max, ts) => (ts > max ? ts : max), 0);
}

function shouldKeepRecord(rec, now, limits) {
  if (!rec) return false;
  if (rec.muteUntil && rec.muteUntil > now) return true;
  const last = recordActivityAt(rec);
  return now - last < Math.max(limits.dayMs, limits.muteMs);
}

function createAntispam(options) {
  const opts = options || {};
  const limits = createLimits(opts.limits);
  const adminIds = Array.isArray(opts.adminIds) ? opts.adminIds : [];
  const records = new Map();

  function isAdmin(userId) {
    return adminIds.includes(userId);
  }

  function get(userId) {
    return records.get(userId) || emptyRecord();
  }

  function set(userId, rec) {
    records.set(userId, rec);
    return rec;
  }

  function checkFile(userId, fileKey, now) {
    const ts = now == null ? Date.now() : now;
    if (userId == null || isAdmin(userId)) {
      return { action: 'ok', notifyUser: false, skipped: true, record: userId == null ? emptyRecord() : get(userId) };
    }
    const result = evaluateFileRequest(get(userId), fileKey, ts, limits);
    set(userId, result.record);
    return result;
  }

  function checkCommand(userId, now) {
    const ts = now == null ? Date.now() : now;
    if (userId == null || isAdmin(userId)) {
      return { action: 'ok', notifyUser: false, skipped: true, record: userId == null ? emptyRecord() : get(userId) };
    }
    const result = evaluateCommand(get(userId), ts, limits);
    set(userId, result.record);
    return result;
  }

  function sweep(now) {
    const ts = now == null ? Date.now() : now;
    for (const [userId, rec] of records) {
      if (!shouldKeepRecord(rec, ts, limits)) records.delete(userId);
    }
  }

  let timer = null;
  function startSweep(periodMs) {
    if (timer) return timer;
    timer = setInterval(() => sweep(Date.now()), periodMs || MINUTE_MS);
    if (timer.unref) timer.unref();
    return timer;
  }

  function stopSweep() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    limits,
    records,
    isAdmin,
    get,
    set,
    checkFile,
    checkCommand,
    sweep,
    startSweep,
    stopSweep
  };
}

module.exports = {
  DEFAULTS,
  MINUTE_MS,
  DAY_MS,
  FILE_NOTICE,
  readEnvInt,
  createLimits,
  emptyRecord,
  recentWindow,
  evaluateFileRequest,
  evaluateCommand,
  fileNoticeText,
  fileNoticeKind,
  isCommandUpdate,
  parseStartGameId,
  gameIdFromPayload,
  telegramRetryAfterSec,
  isTelegramFloodError,
  logBotError,
  withTelegramRetry,
  shouldKeepRecord,
  createAntispam
};
