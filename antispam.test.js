const assert = require('assert');
const {
  DEFAULTS,
  MINUTE_MS,
  DAY_MS,
  createLimits,
  emptyRecord,
  evaluateFileRequest,
  evaluateCommand,
  fileNoticeText,
  fileNoticeKind,
  isCommandUpdate,
  parseStartGameId,
  gameIdFromPayload,
  telegramRetryAfterSec,
  isTelegramFloodError,
  withTelegramRetry,
  shouldKeepRecord,
  createAntispam,
  FILE_NOTICE
} = require('./antispam');

const limits = createLimits({
  filesPerMinute: 5,
  filesPerDay: 40,
  fileDupMs: 30 * 1000,
  commandsPerMinute: 10,
  strikeLimit: 3,
  strikeWindowMs: 10 * 60 * 1000,
  muteMs: 60 * 60 * 1000
});

assert.strictEqual(limits.filesPerMinute, 5);
assert.strictEqual(limits.filesPerDay, 40);
assert.strictEqual(limits.fileDupMs, 30 * 1000);
assert.strictEqual(limits.commandsPerMinute, 10);
assert.strictEqual(DEFAULTS.filesPerMinute, 5);
assert.strictEqual(DEFAULTS.filesPerDay, 40);

const prevFilesMin = process.env.FILES_PER_MINUTE;
const prevDup = process.env.FILE_DUP_SECONDS;
process.env.FILES_PER_MINUTE = '8';
process.env.FILE_DUP_SECONDS = '15';
const fromEnv = createLimits();
assert.strictEqual(fromEnv.filesPerMinute, 8);
assert.strictEqual(fromEnv.fileDupMs, 15 * 1000);
assert.strictEqual(createLimits({ filesPerMinute: 6 }).filesPerMinute, 6);
if (prevFilesMin == null) delete process.env.FILES_PER_MINUTE;
else process.env.FILES_PER_MINUTE = prevFilesMin;
if (prevDup == null) delete process.env.FILE_DUP_SECONDS;
else process.env.FILE_DUP_SECONDS = prevDup;


assert.strictEqual(gameIdFromPayload('game_2'), '2');
assert.strictEqual(gameIdFromPayload('game_12'), '12');
assert.strictEqual(gameIdFromPayload('help'), '');
assert.strictEqual(gameIdFromPayload('game_ab'), '');
assert.strictEqual(parseStartGameId({ startPayload: 'game_4' }), '4');
assert.strictEqual(parseStartGameId({ message: { text: '/start@SteamyFilesBot game_7' } }), '7');
assert.strictEqual(parseStartGameId({ message: { text: '/start' } }), '');
assert.strictEqual(parseStartGameId({ message: { text: '/help' } }), '');
assert.ok(isCommandUpdate({ message: { text: '/rules' } }));
assert.ok(isCommandUpdate({ callbackQuery: { data: 'rules' } }));
assert.ok(!isCommandUpdate({ message: { text: 'hello' } }));

let rec = emptyRecord();
const t0 = 1_000_000;
for (let i = 0; i < 5; i++) {
  const r = evaluateFileRequest(rec, String(i + 1), t0 + i * 1000, limits);
  assert.strictEqual(r.action, 'ok', 'file accepted ' + i);
  rec = r.record;
}

// same file as the last request within 30s is ignored and is not a limit hit
const dup = evaluateFileRequest(rec, '5', t0 + 5000, limits);
assert.strictEqual(dup.action, 'duplicate');
assert.strictEqual(dup.notifyUser, false);
assert.strictEqual(dup.record.filesMinute.length, 5);

// a different file in the same minute after 5 requests is limited
const other = evaluateFileRequest(rec, '99', t0 + 6000, limits);
assert.strictEqual(other.action, 'limited');
assert.strictEqual(other.reason, 'minute');
assert.strictEqual(other.notifyUser, true);
rec = other.record;
const other2 = evaluateFileRequest(rec, '99', t0 + 7000, limits);
assert.strictEqual(other2.action, 'limited');
assert.strictEqual(other2.notifyUser, false);
assert.strictEqual(fileNoticeText('ru', other), 'Слишком много запросов, попробуйте через минуту.');
assert.ok(fileNoticeText('en', other).toLowerCase().includes('minute'));
assert.strictEqual(fileNoticeKind(other), 'wait');

// a later request for an earlier file within 30s is also ignored
let recGap = emptyRecord();
recGap = evaluateFileRequest(recGap, '1', t0, limits).record;
recGap = evaluateFileRequest(recGap, '2', t0 + 1000, limits).record;
const backToFirst = evaluateFileRequest(recGap, '1', t0 + 2000, limits);
assert.strictEqual(backToFirst.action, 'duplicate');

// after 30s the same file can be requested again once the minute window has room
let recDup = emptyRecord();
recDup = evaluateFileRequest(recDup, '2', t0, limits).record;
const stillDup = evaluateFileRequest(recDup, '2', t0 + 29 * 1000, limits);
assert.strictEqual(stillDup.action, 'duplicate');
const afterDup = evaluateFileRequest(recDup, '2', t0 + 30 * 1000, limits);
assert.strictEqual(afterDup.action, 'ok');

// 40 per day, spaced so the minute window is never the blocker
let recDay = emptyRecord();
const dayStart = 5_000_000;
for (let i = 0; i < 40; i++) {
  const r = evaluateFileRequest(recDay, 'g' + i, dayStart + i * 70_000, limits);
  assert.strictEqual(r.action, 'ok', 'day accepted ' + i);
  recDay = r.record;
}
const dayHit = evaluateFileRequest(recDay, 'overflow', dayStart + 40 * 70_000, limits);
assert.strictEqual(dayHit.action, 'limited');
assert.strictEqual(dayHit.reason, 'day');
assert.strictEqual(dayHit.notifyUser, true);
recDay = dayHit.record;
const dayHit2 = evaluateFileRequest(recDay, 'overflow2', dayStart + 40 * 70_000 + 1000, limits);
assert.strictEqual(dayHit2.notifyUser, false);
assert.ok(fileNoticeText('ru', dayHit).includes('сегодня'));

// commands: 10 per minute, always silent
let recCmd = emptyRecord();
const c0 = 8_000_000;
for (let i = 0; i < 10; i++) {
  const r = evaluateCommand(recCmd, c0 + i, limits);
  assert.strictEqual(r.action, 'ok', 'cmd accepted ' + i);
  recCmd = r.record;
}
const cmdHit = evaluateCommand(recCmd, c0 + 20, limits);
assert.strictEqual(cmdHit.action, 'limited');
assert.strictEqual(cmdHit.notifyUser, false);
recCmd = cmdHit.record;
const cmdHit2 = evaluateCommand(recCmd, c0 + 30, limits);
assert.strictEqual(cmdHit2.action, 'limited');
assert.strictEqual(cmdHit2.notifyUser, false);

// three file-limit windows in 10 minutes -> 1h mute
let recMute = emptyRecord();
let t = 10_000;
function fillMinuteAndHit(record, start) {
  let cur = record;
  for (let i = 0; i < 5; i++) {
    const r = evaluateFileRequest(cur, 'f' + start + '-' + i, start + i, limits);
    if (r.action === 'ok') cur = r.record;
  }
  const hit = evaluateFileRequest(cur, 'x' + start, start + 20, limits);
  return hit;
}
let hit1 = fillMinuteAndHit(recMute, t);
assert.strictEqual(hit1.action, 'limited');
assert.strictEqual(hit1.notifyUser, true);
recMute = hit1.record;
let hit2 = fillMinuteAndHit(recMute, t + MINUTE_MS);
assert.strictEqual(hit2.action, 'limited');
assert.strictEqual(hit2.notifyUser, true);
recMute = hit2.record;
let hit3 = fillMinuteAndHit(recMute, t + 2 * MINUTE_MS);
assert.strictEqual(hit3.action, 'muted');
assert.strictEqual(hit3.notifyUser, true);
assert.strictEqual(fileNoticeKind(hit3), 'mute');
assert.ok(fileNoticeText('ru', hit3).includes('час'));
assert.ok(hit3.record.muteUntil >= t + 2 * MINUTE_MS + 20 + limits.muteMs - 1);
recMute = hit3.record;
const mutedAgain = evaluateFileRequest(recMute, '2', t + 2 * MINUTE_MS + 30, limits);
assert.strictEqual(mutedAgain.action, 'muted');
assert.strictEqual(mutedAgain.notifyUser, false);
const mutedCmd = evaluateCommand(recMute, t + 2 * MINUTE_MS + 40, limits);
assert.strictEqual(mutedCmd.action, 'muted');
assert.strictEqual(mutedCmd.notifyUser, false);
const stillMuted = evaluateFileRequest(recMute, '2', t + 2 * MINUTE_MS + limits.muteMs - 1, limits);
assert.strictEqual(stillMuted.action, 'muted');
const afterMute = evaluateFileRequest(recMute, '2', t + 2 * MINUTE_MS + 20 + limits.muteMs, limits);
assert.strictEqual(afterMute.action, 'ok');

// mixed command + file strikes also mute
let recMix = emptyRecord();
const m0 = 20_000_000;
for (let i = 0; i < 10; i++) recMix = evaluateCommand(recMix, m0 + i, limits).record;
const mix1 = evaluateCommand(recMix, m0 + 20, limits);
assert.strictEqual(mix1.action, 'limited');
recMix = mix1.record;
for (let i = 0; i < 5; i++) recMix = evaluateFileRequest(recMix, 'a' + i, m0 + MINUTE_MS + i, limits).record;
const mix2 = evaluateFileRequest(recMix, 'ax', m0 + MINUTE_MS + 20, limits);
assert.strictEqual(mix2.action, 'limited');
recMix = mix2.record;
for (let i = 0; i < 10; i++) {
  const r = evaluateCommand(recMix, m0 + 2 * MINUTE_MS + i, limits);
  if (r.action === 'ok') recMix = r.record;
}
const mix3 = evaluateCommand(recMix, m0 + 2 * MINUTE_MS + 20, limits);
assert.strictEqual(mix3.action, 'muted');
assert.strictEqual(mix3.notifyUser, false);

// createAntispam: admins are exempt, users are not, sweep drops stale records
const gate = createAntispam({
  adminIds: [42],
  limits: {
    filesPerMinute: 5,
    filesPerDay: 40,
    fileDupMs: 30 * 1000,
    commandsPerMinute: 10,
    strikeLimit: 3,
    strikeWindowMs: 10 * 60 * 1000,
    muteMs: 60 * 60 * 1000
  }
});
for (let i = 0; i < 20; i++) {
  const r = gate.checkFile(42, '1', t0 + i);
  assert.strictEqual(r.action, 'ok');
  assert.strictEqual(r.skipped, true);
}
for (let i = 0; i < 5; i++) {
  assert.strictEqual(gate.checkFile(7, String(i), t0 + i).action, 'ok');
}
assert.strictEqual(gate.checkFile(7, '99', t0 + 10).action, 'limited');
assert.strictEqual(gate.checkFile(null, '1', t0).action, 'ok');

const stale = createAntispam({ limits });
stale.checkFile(8, '1', t0);
assert.strictEqual(stale.records.size, 1);
stale.sweep(t0 + DAY_MS + 1);
assert.strictEqual(stale.records.size, 0);
const mutedKeep = createAntispam({ limits });
let mutedRec = emptyRecord();
mutedRec.muteUntil = t0 + limits.muteMs;
mutedKeep.set(9, mutedRec);
assert.ok(shouldKeepRecord(mutedRec, t0 + 1000, limits));
mutedKeep.sweep(t0 + 1000);
assert.strictEqual(mutedKeep.records.size, 1);

assert.strictEqual(telegramRetryAfterSec({ parameters: { retry_after: 12 } }), 12);
assert.strictEqual(telegramRetryAfterSec({ description: 'Too Many Requests: retry after 7' }), 7);
assert.strictEqual(telegramRetryAfterSec({ message: 'nope' }), 0);
assert.ok(isTelegramFloodError({ error_code: 429, description: 'Too Many Requests' }));
assert.ok(isTelegramFloodError({ message: 'FLOOD: retry after 3' }));
assert.ok(!isTelegramFloodError({ error_code: 400, description: 'Bad Request' }));

async function testRetry() {
  const waits = [];
  let calls = 0;
  const ok = await withTelegramRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('Too Many Requests: retry after 2');
        err.error_code = 429;
        err.parameters = { retry_after: 2 };
        throw err;
      }
      return 'sent';
    },
    {
      sleep: async (ms) => { waits.push(ms); },
      log: () => {},
      label: 'copyMessage'
    }
  );
  assert.strictEqual(ok, 'sent');
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(waits, [2000]);

  let failed = 0;
  await withTelegramRetry(
    async () => {
      failed += 1;
      const err = new Error('Too Many Requests: retry after 1');
      err.error_code = 429;
      err.parameters = { retry_after: 1 };
      throw err;
    },
    { sleep: async () => {}, log: () => {}, maxAttempts: 2 }
  ).then(
    () => {
      throw new Error('expected 429 to be rethrown after retries');
    },
    (err) => {
      assert.strictEqual(err.error_code, 429);
    }
  );
  assert.strictEqual(failed, 2);

  const boom = new Error('blocked');
  boom.error_code = 403;
  await withTelegramRetry(async () => { throw boom; }, { log: () => {} }).then(
    () => {
      throw new Error('expected non-429 to throw immediately');
    },
    (err) => {
      assert.strictEqual(err.error_code, 403);
    }
  );

  const allText = JSON.stringify(FILE_NOTICE) + fileNoticeText('ru', { action: 'limited', reason: 'minute' });
  assert.ok(!/rule6669/i.test(allText));
}

testRetry()
  .then(() => {
    console.log('ANTISPAM_OK');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
