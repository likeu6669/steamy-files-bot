// База данных Supabase (PostgreSQL через PostgREST) для ботов.
// Включается, только если заданы SUPABASE_URL и SUPABASE_SERVICE_KEY.
// Любая ошибка базы только пишется в лог: выдача файлов и поддержка
// продолжают работать на памяти и файле состояния в канале.

const DEFAULT_TIMEOUT_MS = 8000;
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_TOUCH_CACHE = 5000;
const ROUTES_LIMIT = 2000;
const DEFAULT_PLATFORM = 'android';

function authHeaders(key) {
  // Новые ключи sb_secret_… не JWT: их передают только в apikey.
  // Старый service_role (JWT) — в apikey и в Authorization.
  const k = String(key || '');
  return k.startsWith('sb_') ? { apikey: k } : { apikey: k, Authorization: 'Bearer ' + k };
}

function toIso(ms) {
  return new Date(Number(ms)).toISOString();
}

function createDb(options) {
  const opts = options || {};
  const baseUrl = String(opts.url || '').trim().replace(/\/+$/, '');
  const key = String(opts.key || '').trim();
  if (!baseUrl || !key) return null;

  const fetchFn = opts.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    console.error('Supabase: в этой версии Node нет fetch, база отключена');
    return null;
  }
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const log = opts.log || console;
  const now = opts.now || (() => Date.now());
  const lastErrorAt = new Map();
  const touched = new Map();

  function logError(label, err) {
    const t = now();
    if (now() - (lastErrorAt.get(label) || 0) < 60 * 1000) return;
    lastErrorAt.set(label, t);
    const msg = (err && err.message) || String(err);
    log.error && log.error('Supabase ' + label + ' failed:', msg);
  }

  async function request(method, path, body, prefer) {
    const headers = Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, authHeaders(key));
    if (prefer) headers.Prefer = prefer;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchFn(baseUrl + '/rest/v1/' + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
      const text = await res.text();
      if (!res.ok) {
        let detail = text;
        try {
          const j = JSON.parse(text);
          detail = [j.code, j.message].filter(Boolean).join(' ') || text;
        } catch {
          // not JSON
        }
        throw new Error('HTTP ' + res.status + ' ' + String(detail).slice(0, 200));
      }
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Обёртка «мягкой» ошибки: вернёт fallback и запишет в лог.
  function soft(label, fn, fallback) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        logError(label, err);
        return fallback;
      }
    };
  }

  const rpc = (name, args) => request('POST', 'rpc/' + name, args || {});
  const upsert = (table, rows, conflict) =>
    request('POST', table + '?on_conflict=' + conflict, rows, 'resolution=merge-duplicates,return=minimal');

  const api = {
    enabled: true,

    touchUser: soft('touchUser', async (from, bot) => {
      if (!from || from.is_bot || !Number.isInteger(from.id)) return false;
      const t = now();
      const cacheKey = from.id + ':' + bot;
      if (t - (touched.get(cacheKey) || 0) < TOUCH_INTERVAL_MS) return false;
      touched.set(cacheKey, t);
      if (touched.size > MAX_TOUCH_CACHE) touched.clear();
      await rpc('touch_user', {
        p_telegram_id: from.id,
        p_username: from.username || null,
        p_language: from.language_code || null,
        p_bot: bot
      });
      return true;
    }, false),

    loadLinks: soft('loadLinks', async () => {
      const rows = await request('GET', 'file_links?select=game_id,platform,post_ids&platform=eq.' + DEFAULT_PLATFORM);
      const out = {};
      for (const row of Array.isArray(rows) ? rows : []) {
        const ids = (row.post_ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
        if (ids.length) out[String(row.game_id)] = ids;
      }
      return out;
    }, null),

    saveLink: soft('saveLink', async (gameId, postIds, version) => {
      await upsert('file_links', [{
        game_id: Number(gameId),
        platform: DEFAULT_PLATFORM,
        post_ids: postIds.map(Number),
        version: version || null,
        updated_at: new Date(now()).toISOString()
      }], 'game_id,platform');
      return true;
    }, false),

    saveLinks: soft('saveLinks', async (links, versions) => {
      const rows = Object.entries(links || {}).map(([gameId, ids]) => ({
        game_id: Number(gameId),
        platform: DEFAULT_PLATFORM,
        post_ids: ids.map(Number),
        version: (versions && versions[gameId]) || null,
        updated_at: new Date(now()).toISOString()
      }));
      if (rows.length) await upsert('file_links', rows, 'game_id,platform');
      return true;
    }, false),

    loadSupport: soft('loadSupport', async () => {
      const [bans, mutes, routes] = await Promise.all([
        request('GET', 'support_bans?select=telegram_id'),
        request('GET', 'support_mutes?select=telegram_id,mute_until&mute_until=gt.' + encodeURIComponent(toIso(now()))),
        request('GET', 'support_routes?select=admin_chat_id,admin_message_id,user_id&order=created_at.desc&limit=' + ROUTES_LIMIT)
      ]);
      const out = { banned: [], mutes: {}, routes: {} };
      for (const r of bans || []) out.banned.push(Number(r.telegram_id));
      for (const r of mutes || []) out.mutes[String(r.telegram_id)] = Date.parse(r.mute_until);
      // Сначала старые, потом новые: так в памяти самые свежие маршруты окажутся последними.
      for (const r of (routes || []).slice().reverse()) {
        out.routes[r.admin_chat_id + ':' + r.admin_message_id] = Number(r.user_id);
      }
      return out;
    }, null),

    addBan: soft('addBan', async (userId, adminId) => {
      await upsert('support_bans', [{ telegram_id: Number(userId), banned_by: adminId ? Number(adminId) : null }], 'telegram_id');
      return true;
    }, false),

    addBans: soft('addBans', async (ids) => {
      const rows = (ids || []).map((id) => ({ telegram_id: Number(id) }));
      if (rows.length) await upsert('support_bans', rows, 'telegram_id');
      return true;
    }, false),

    removeBan: soft('removeBan', async (userId) => {
      await request('DELETE', 'support_bans?telegram_id=eq.' + Number(userId), undefined, 'return=minimal');
      await request('DELETE', 'support_mutes?telegram_id=eq.' + Number(userId), undefined, 'return=minimal');
      return true;
    }, false),

    setMute: soft('setMute', async (userId, untilMs) => {
      await upsert('support_mutes', [{ telegram_id: Number(userId), mute_until: toIso(untilMs) }], 'telegram_id');
      return true;
    }, false),

    setMutes: soft('setMutes', async (mutes) => {
      const rows = Object.entries(mutes || {})
        .filter(([, until]) => Number(until) > now())
        .map(([id, until]) => ({ telegram_id: Number(id), mute_until: toIso(until) }));
      if (rows.length) await upsert('support_mutes', rows, 'telegram_id');
      return true;
    }, false),

    supportUserMessage: soft('supportUserMessage', async (userId, topic, language) => {
      const id = await rpc('support_user_message', {
        p_user_id: Number(userId),
        p_topic: topic || null,
        p_language: language || null
      });
      return id == null ? null : Number(id);
    }, null),

    addRoutes: soft('addRoutes', async (rows) => {
      const clean = (rows || []).filter((r) => r && r.admin_message_id).map((r) => ({
        admin_chat_id: Number(r.admin_chat_id),
        admin_message_id: Number(r.admin_message_id),
        user_id: Number(r.user_id),
        ticket_id: r.ticket_id == null ? null : Number(r.ticket_id),
        topic: r.topic || null,
        language: r.language || null
      }));
      if (clean.length) await upsert('support_routes', clean, 'admin_chat_id,admin_message_id');
      return true;
    }, false),

    ticketAnswered: soft('ticketAnswered', async (userId) => {
      await rpc('support_ticket_answered', { p_user_id: Number(userId) });
      return true;
    }, false),

    userLanguage: soft('userLanguage', async (userId) => {
      const id = Number(userId);
      const routes = await request('GET', 'support_routes?select=language&user_id=eq.' + id + '&language=not.is.null&order=created_at.desc&limit=1');
      if (Array.isArray(routes) && routes[0] && routes[0].language) return routes[0].language;
      const users = await request('GET', 'bot_users?select=language&telegram_id=eq.' + id + '&limit=1');
      if (Array.isArray(users) && users[0] && users[0].language) return users[0].language;
      return null;
    }, null),

    recordDownload: soft('recordDownload', async (userId, gameId, platform, ok) => {
      await request('POST', 'download_events', [{
        user_id: Number(userId),
        game_id: Number(gameId),
        platform: platform || DEFAULT_PLATFORM,
        ok: ok !== false
      }], 'return=minimal');
      return true;
    }, false),

    stats: soft('stats', async (tz) => rpc('bot_stats', { p_tz: tz || 'Europe/Vilnius' }), null),

    getMeta: soft('getMeta', async (metaKey) => {
      const rows = await request('GET', 'app_meta?select=value&key=eq.' + encodeURIComponent(metaKey) + '&limit=1');
      return Array.isArray(rows) && rows[0] ? { value: rows[0].value } : { value: undefined };
    }, null),

    setMeta: soft('setMeta', async (metaKey, value) => {
      await upsert('app_meta', [{ key: metaKey, value, updated_at: new Date(now()).toISOString() }], 'key');
      return true;
    }, false),

    // Пустая ли база (нет ни банов, ни привязок) — для разового переноса.
    isEmpty: soft('isEmpty', async () => {
      const [bans, links] = await Promise.all([
        request('GET', 'support_bans?select=telegram_id&limit=1'),
        request('GET', 'file_links?select=game_id&limit=1')
      ]);
      return (!bans || !bans.length) && (!links || !links.length);
    }, null),

    // Для тестов и /stats: проверка связи.
    ping: soft('ping', async () => {
      await request('GET', 'app_meta?select=key&limit=1');
      return true;
    }, false)
  };
  return api;
}

const MIGRATION_KEY = 'channel_state_migrated_v1';

// Разовый перенос банов, мутов, маршрутов и привязок из канала (или памяти) в пустую базу.
async function migrateOnce(db, state, options) {
  if (!db) return { migrated: false, reason: 'no-db' };
  const meta = await db.getMeta(MIGRATION_KEY);
  if (!meta) return { migrated: false, reason: 'db-error' };
  if (meta.value) return { migrated: false, reason: 'already' };
  const empty = await db.isEmpty();
  if (empty === null) return { migrated: false, reason: 'db-error' };
  const st = state || {};
  const sup = st.support || {};
  const skip = new Set(((options && options.skipBanIds) || []).map(Number));
  let ok = true;
  const counts = { bans: 0, mutes: 0, routes: 0, links: 0 };
  if (empty) {
    const bans = (sup.banned || []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && !skip.has(n));
    counts.bans = bans.length;
    counts.mutes = Object.keys(sup.mutes || {}).length;
    const routeRows = Object.entries(sup.routes || {}).map(([k, userId]) => {
      const [chat, msg] = k.split(':');
      return { admin_chat_id: Number(chat), admin_message_id: Number(msg), user_id: Number(userId) };
    });
    counts.routes = routeRows.length;
    counts.links = Object.keys(st.links || {}).length;
    ok = (await db.addBans(bans)) && ok;
    ok = (await db.setMutes(sup.mutes || {})) && ok;
    ok = (await db.addRoutes(routeRows)) && ok;
    ok = (await db.saveLinks(st.links || {}, options && options.versions)) && ok;
  }
  if (!ok) return { migrated: false, reason: 'db-error' };
  await db.setMeta(MIGRATION_KEY, { at: new Date().toISOString(), empty: Boolean(empty), counts });
  return { migrated: Boolean(empty), reason: empty ? 'done' : 'not-empty', counts };
}

function formatStats(stats, gameName, lang) {
  if (!stats) {
    return lang === 'en'
      ? 'Could not read statistics from the database. Check the Render logs.'
      : 'Не удалось получить статистику из базы. Подробности в логах Render.';
  }
  const n = (v) => Number(v || 0);
  const top = Array.isArray(stats.top_games_7d) ? stats.top_games_7d : [];
  const topLines = top.length
    ? top.map((g, i) => `${i + 1}. ${gameName(g.game_id)} — ${n(g.downloads)}`).join('\n')
    : '—';
  return (
    '📊 Статистика Steamy Store\n\n' +
    `Пользователи: всего ${n(stats.users_total)}, новых сегодня ${n(stats.users_today)}, за 7 дней ${n(stats.users_7d)}\n` +
    `Активных за 7 дней: ${n(stats.active_7d)}\n` +
    `Скачивания: сегодня ${n(stats.downloads_today)}, за 7 дней ${n(stats.downloads_7d)}\n\n` +
    'Топ-5 игр за 7 дней:\n' + topLines + '\n\n' +
    `Открытые обращения в поддержку: ${n(stats.tickets_open)}\n` +
    `Баны в поддержке: ${n(stats.bans)}\n\n` +
    '«Сегодня» — по времени Вильнюса.'
  );
}

const NO_DB_STATS_TEXT =
  'База данных не подключена, статистики пока нет.\n' +
  'Добавьте на Render переменные SUPABASE_URL и SUPABASE_SERVICE_KEY и перезапустите сервис (шаги в README).';

module.exports = {
  createDb,
  migrateOnce,
  formatStats,
  authHeaders,
  NO_DB_STATS_TEXT,
  MIGRATION_KEY
};
