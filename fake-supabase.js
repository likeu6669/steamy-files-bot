// Тестовая подделка Supabase REST (PostgREST) в памяти. Используется только в тестах.
function createFakeSupabase(options) {
  const opts = options || {};
  const tables = {
    bot_users: [], file_links: [], support_bans: [], support_mutes: [],
    support_tickets: [], support_routes: [], download_events: [], app_meta: []
  };
  const keys = {
    bot_users: ['telegram_id'], file_links: ['game_id', 'platform'], support_bans: ['telegram_id'],
    support_mutes: ['telegram_id'], support_routes: ['admin_chat_id', 'admin_message_id'], app_meta: ['key']
  };
  let seq = 0;
  const requests = [];
  const state = { down: false, failPaths: [] };
  const nowIso = () => new Date().toISOString();

  function match(row, filters) {
    return filters.every(([col, op, val]) => {
      const v = row[col];
      if (op === 'eq') return String(v) === val;
      if (op === 'gt') return (typeof v === 'string' && /T/.test(v) ? Date.parse(v) > Date.parse(val) : Number(v) > Number(val));
      if (op === 'not.is') return v != null;
      return true;
    });
  }

  const rpc = {
    touch_user(a) {
      const row = tables.bot_users.find((r) => r.telegram_id === a.p_telegram_id);
      if (row) Object.assign(row, { username: a.p_username, language: a.p_language || row.language, last_bot: a.p_bot, last_seen: nowIso() });
      else tables.bot_users.push({ telegram_id: a.p_telegram_id, username: a.p_username, language: a.p_language, first_bot: a.p_bot, last_bot: a.p_bot, first_seen: nowIso(), last_seen: nowIso() });
      return null;
    },
    support_user_message(a) {
      let t = tables.support_tickets.find((r) => r.user_id === a.p_user_id && r.status === 'open');
      if (t) { t.messages += 1; if (a.p_topic) t.topic = a.p_topic; return t.id; }
      t = { id: ++seq, user_id: a.p_user_id, topic: a.p_topic || 'other', language: a.p_language || 'ru', status: 'open', messages: 1, created_at: nowIso() };
      tables.support_tickets.push(t);
      return t.id;
    },
    support_ticket_answered(a) {
      for (const t of tables.support_tickets) if (t.user_id === a.p_user_id && t.status === 'open') t.status = 'answered';
      return null;
    },
    bot_stats() {
      const counts = {};
      for (const e of tables.download_events) if (e.ok) counts[e.game_id] = (counts[e.game_id] || 0) + 1;
      const top = Object.entries(counts).map(([g, n]) => ({ game_id: Number(g), downloads: n })).sort((x, y) => y.downloads - x.downloads).slice(0, 5);
      const dl = tables.download_events.filter((e) => e.ok).length;
      return {
        users_total: tables.bot_users.length, users_today: tables.bot_users.length, users_7d: tables.bot_users.length,
        active_7d: tables.bot_users.length, downloads_today: dl, downloads_7d: dl, top_games_7d: top,
        tickets_open: tables.support_tickets.filter((t) => t.status === 'open').length, bans: tables.support_bans.length
      };
    }
  };

  async function fetch(url, init) {
    const u = new URL(url);
    const method = (init && init.method) || 'GET';
    const headers = (init && init.headers) || {};
    requests.push({ method, path: u.pathname + u.search, headers });
    const json = (status, body) => ({ ok: status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
    if (state.down) throw new Error('getaddrinfo ENOTFOUND fake.supabase.co');
    if (opts.key && headers.apikey !== opts.key) return json(401, { message: 'Invalid API key' });
    const path = u.pathname.replace(/^\/rest\/v1\//, '');
    if (state.failPaths.some((p) => path.startsWith(p))) return json(500, { code: 'XX000', message: 'boom' });
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    if (path.startsWith('rpc/')) {
      const fn = rpc[path.slice(4)];
      if (!fn) return json(404, { code: 'PGRST202', message: 'no function' });
      return json(200, fn(body || {}));
    }
    const table = tables[path];
    if (!table) return json(404, { code: '42P01', message: 'relation does not exist' });
    const filters = [];
    let order = null; let limit = null;
    for (const [k, v] of u.searchParams) {
      if (k === 'select' || k === 'on_conflict') continue;
      if (k === 'order') { order = v; continue; }
      if (k === 'limit') { limit = Number(v); continue; }
      const m = v.match(/^(eq|gt|not\.is)\.(.*)$/);
      if (m) filters.push([k, m[1], m[2]]);
    }
    if (method === 'GET') {
      let rows = table.filter((r) => match(r, filters));
      if (order) {
        const [col, dir] = order.split('.');
        rows = rows.slice().sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      if (limit != null) rows = rows.slice(0, limit);
      return json(200, rows);
    }
    if (method === 'DELETE') {
      for (let i = table.length - 1; i >= 0; i--) if (match(table[i], filters)) table.splice(i, 1);
      return json(204);
    }
    if (method === 'POST') {
      const conflict = u.searchParams.get('on_conflict');
      for (const row of Array.isArray(body) ? body : [body]) {
        const stamped = Object.assign({ created_at: nowIso() }, row);
        if (conflict) {
          const cols = conflict.split(',');
          const found = table.find((r) => cols.every((c) => String(r[c]) === String(stamped[c])));
          if (found) { Object.assign(found, row); continue; }
        } else if (!stamped.id) stamped.id = ++seq;
        table.push(stamped);
      }
      return json(201);
    }
    return json(405, { message: 'method' });
  }

  return { fetch, tables, requests, state, keys };
}

module.exports = { createFakeSupabase };
