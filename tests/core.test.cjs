const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const match = html.match(/<script id="game-core">([\s\S]*?)<\/script>/);
assert.ok(match, 'the standalone page must expose its testable game core');
const sandbox = { window: {}, Date, Math };
vm.runInNewContext(match[1], sandbox);
const core = sandbox.window.TCXY;

function reveal(game, a, b) {
  core.setWord(game, 0, a);
  core.setWord(game, 1, b);
  core.toggleLock(game, 0);
  core.toggleLock(game, 1);
  core.beginReveal(game);
  return core.resolveRound(game);
}

test('normalization preserves words while ignoring spaces, punctuation and case', () => {
  assert.equal(core.normalize('  Hello， WORLD！ '), 'helloworld');
  assert.equal(core.normalize('海　 洋。'), '海洋');
  assert.equal(core.normalize('。。。 ✨'), '');
  assert.equal(core.normalize('\u200b\u200d\ufeff'), '');
});

test('both players must lock valid words before reveal; locked words cannot change', () => {
  const game = core.createGame();
  assert.throws(() => core.toggleLock(game, 0), /词/);
  core.setWord(game, 0, '山川');
  core.toggleLock(game, 0);
  assert.throws(() => core.setWord(game, 0, '偷改'), /锁/);
  assert.throws(() => core.beginReveal(game), /锁/);
  core.toggleLock(game, 0);
  core.setWord(game, 0, '森林');
  assert.equal(game.words[0], '森林');
});

test('mismatched rounds advance and normalized exact matches finish once', () => {
  const game = core.createGame();
  reveal(game, '山川', '海洋');
  assert.equal(game.phase, 'next');
  assert.equal(game.round, 1);
  core.nextRound(game);
  assert.equal(game.round, 2);
  assert.equal(game.locked.some(Boolean), false);
  reveal(game, '自然。', ' 自　然 ');
  assert.equal(game.phase, 'done');
  assert.equal(game.history.length, 2);
  assert.throws(() => core.resolveRound(game));
});

test('punctuation-only and oversized input cannot be submitted', () => {
  const game = core.createGame();
  core.setWord(game, 0, '。。。');
  assert.throws(() => core.toggleLock(game, 0), /词/);
  assert.throws(() => core.setWord(game, 0, '一二三四五六七八九十一'), /10/);
});

test('timed mode expires against a deadline and never reveals private words', () => {
  const game = core.createGame({ mode: 'timed' });
  core.startTimer(game, 1000);
  core.setWord(game, 0, '秘密');
  core.toggleLock(game, 0);
  assert.equal(core.tick(game, 30999), false);
  assert.equal(core.tick(game, 31000), true);
  assert.equal(game.phase, 'timeout');
  assert.equal(game.words.join(''), '');
  assert.equal(game.history[0].timeout, true);
  assert.equal(game.history[0].a, undefined);
  assert.throws(() => core.beginReveal(game));
  core.nextRound(game);
  assert.equal(game.round, 2);
  assert.equal(game.deadline, null);
});

test('classic mode does not expire and a reveal stops the timed deadline', () => {
  const classic = core.createGame();
  core.startTimer(classic, 0);
  assert.equal(core.tick(classic, 999999), false);
  const timed = core.createGame({ mode: 'timed' });
  core.startTimer(timed, 0);
  core.setWord(timed, 0, '月亮');
  core.setWord(timed, 1, '星星');
  core.toggleLock(timed, 0);
  core.toggleLock(timed, 1);
  core.beginReveal(timed);
  assert.equal(core.tick(timed, 999999), false);
});

test('saved sessions contain only revealed history, never current words', () => {
  const game = core.createGame({ mode: 'timed', theme: 'nature' });
  reveal(game, '太阳', '森林');
  core.nextRound(game);
  core.setWord(game, 0, '不能保存的秘密');
  core.toggleLock(game, 0);
  const snapshot = core.snapshot(game);
  assert.equal(JSON.stringify(snapshot).includes('不能保存'), false);
  const restored = core.restore(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(restored.round, 2);
  assert.equal(restored.history.length, 1);
  assert.equal(restored.words.join(''), '');
  assert.equal(restored.deadline, null);
  assert.equal(restored.theme, 'nature');
});

test('restoration rejects corrupt or inconsistent data', () => {
  assert.equal(core.restore({ round: -1, history: [] }), null);
  assert.equal(core.restore({ round: 1, mode: 'wat', history: [] }), null);
  assert.equal(core.restore({ round: 3, mode: 'classic', theme: 'free', phase: 'input', history: [] }), null);
  assert.equal(core.restore(null), null);
});

test('refreshing during the countdown discards both private words and restarts input', () => {
  const game = core.createGame();
  core.setWord(game, 0, '密语甲');
  core.setWord(game, 1, '密语乙');
  core.toggleLock(game, 0);
  core.toggleLock(game, 1);
  core.beginReveal(game);
  const saved = core.snapshot(game);
  assert.equal(saved.phase, 'input');
  assert.equal(JSON.stringify(saved).includes('密语'), false);
  const resumed = core.restore(saved);
  assert.equal(resumed.phase, 'input');
  assert.equal(resumed.locked.some(Boolean), false);
});

test('restored timeout and next phases remain distinct and malformed histories are rejected', () => {
  const game = core.createGame({ mode: 'timed' });
  core.startTimer(game, 0);
  core.tick(game, 30000);
  const saved = core.snapshot(game);
  assert.equal(core.restore(saved).phase, 'timeout');
  saved.phase = 'next';
  assert.equal(core.restore(saved), null);
  saved.phase = 'timeout';
  saved.history[0].a = '不该保存';
  assert.equal(core.restore(saved), null);
});

test('daily inspiration is deterministic and rating reflects actual rounds', () => {
  assert.equal(core.dailyIndex('2026-10-29', 12), core.dailyIndex('2026-10-29', 12));
  assert.ok(core.dailyIndex('2026-10-29', 12) < 12);
  assert.equal(core.rating(1), 'SSS');
  assert.equal(core.rating(3), 'S');
  assert.equal(core.rating(5), 'A');
});
