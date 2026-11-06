'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../src/rate.js');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const DAY = R.DAY_MS;
const T0 = Date.UTC(2026, 10, 1);
const env = (over = {}) => ({ now: T0 + 3 * DAY, sessionId: 's2', enabled: true, focused: true, trusted: true, remote: false, askedThisSession: false, ...over });

function successes(n, now = T0, session = 's1', state) {
  let s = state;
  for (let i = 0; i < n; i++) s = R.recordSuccess(s, now, session);
  return s;
}

test('rating: first success stores the date and the session', () => {
  const s = R.recordSuccess(undefined, T0, 's1');
  assert.equal(s.count, 1);
  assert.equal(s.firstUse, T0);
  assert.equal(s.firstSession, 's1');
  const s2 = R.recordSuccess(s, T0 + DAY, 's9');
  assert.equal(s2.count, 2);
  assert.equal(s2.firstUse, T0, 'first-use date does not move');
  assert.equal(s2.firstSession, 's1');
});

test('rating: asks after the 5th success, not before', () => {
  assert.equal(R.decide(successes(4), env()), false);
  assert.equal(R.decide(successes(5), env()), true);
});

test('rating: waits 2 days after first use', () => {
  const s = successes(10);
  assert.equal(R.decide(s, env({ now: T0 + DAY })), false);
  assert.equal(R.decide(s, env({ now: T0 + 2 * DAY - 1 })), false);
  assert.equal(R.decide(s, env({ now: T0 + 2 * DAY })), true);
});

test('rating: never in the first session, once per session, focus, trust and remote', () => {
  const s = successes(10);
  assert.equal(R.decide(s, env({ sessionId: 's1' })), false, 'first session');
  assert.equal(R.decide(s, env({ sessionId: '' })), false, 'unknown session');
  assert.equal(R.decide(s, env({ askedThisSession: true })), false);
  assert.equal(R.decide(s, env({ focused: false })), false);
  assert.equal(R.decide(s, env({ trusted: false })), false);
  assert.equal(R.decide(s, env({ remote: true })), false);
});

test('rating: setting off means never', () => {
  assert.equal(R.decide(successes(50), env({ enabled: false })), false);
});

test('rating: "Later" asks again after 20 more successes, at most 2 more times', () => {
  let s = successes(5);
  let asks = 0;
  for (let i = 0; i < 200; i++) {
    if (R.decide(s, env())) {
      asks++;
      s = R.recordAnswer(s, 'shown');
      s = R.recordAnswer(s, R.LATER);
      const at = s.count;
      if (!s.done) {
        assert.equal(R.decide(successes(19, T0, 's1', s), env()), false, 'not after 19 more');
        assert.equal(R.decide(successes(20, T0, 's1', s), env()), true, 'after 20 more');
        assert.equal(s.nextAt, at + 20);
      }
    }
    s = R.recordSuccess(s, T0, 's1');
  }
  assert.equal(asks, 3);
  assert.equal(s.done, true);
});

test('rating: closing the message counts like "Later"', () => {
  let s = R.recordAnswer(successes(5), 'shown');
  s = R.recordAnswer(s, undefined);
  assert.equal(s.done, false);
  assert.equal(R.decide(s, env()), false);
  assert.equal(R.decide(successes(20, T0, 's1', s), env()), true);
});

test('rating: "Rate it" and "Don\'t ask again" end it', () => {
  for (const a of [R.RATE, R.NEVER]) {
    const s = R.recordAnswer(R.recordAnswer(successes(5), 'shown'), a);
    assert.equal(s.done, true);
    assert.equal(R.decide(successes(500, T0, 's1', s), env()), false);
  }
});

test('rating: bad stored state is reset safely', () => {
  for (const bad of [null, 'x', 42, { count: -3, nextAt: 'a', firstUse: NaN }]) {
    const s = R.normalize(bad);
    assert.equal(s.count, 0);
    assert.equal(s.nextAt, R.FIRST_ASK);
    assert.equal(s.done, false);
  }
});

test('rating: review link points at this extension', () => {
  const id = `${pkg.publisher}.${pkg.name}`;
  assert.equal(R.reviewUrl(id), `https://marketplace.visualstudio.com/items?itemName=${id}&ssr=false#review-details`);
});

test('rating: manifest has an askForRating setting, default true', () => {
  const props = pkg.contributes.configuration.properties;
  const key = Object.keys(props).find((k) => k.endsWith('.askForRating'));
  assert.ok(key, 'askForRating setting');
  assert.equal(props[key].type, 'boolean');
  assert.equal(props[key].default, true);
});

function fakeVscode(o = {}) {
  const calls = { shown: [], opened: [] };
  const vscode = {
    env: { sessionId: o.sessionId || 's1', remoteName: o.remoteName, openExternal: async (u) => { calls.opened.push(String(u)); return true; } },
    Uri: { parse: (s) => ({ toString: () => s }) },
    window: {
      state: { focused: o.focused !== false },
      showInformationMessage: async (msg, ...items) => { calls.shown.push([msg, items]); return o.answer; },
    },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: (k, d) => (k === 'askForRating' && 'enabled' in o ? o.enabled : d) }) },
  };
  const data = new Map();
  const context = { globalState: { get: (k) => data.get(k), update: async (k, v) => { data.set(k, v); } } };
  return { vscode, context, calls, data };
}

test('rating: prompt wiring shows one message, opens the review page on "Rate it"', async () => {
  const f = fakeVscode({ answer: R.RATE });
  const make = () => R.createRatingPrompt({ vscode: f.vscode, context: f.context, extensionId: 'zovo.x', section: 'x', message: (n) => `X has opened ${n} files for you.` });
  let p = make();
  for (let i = 0; i < 6; i++) await p.success();
  assert.equal(f.calls.shown.length, 0, 'first session');
  const st = f.data.get(R.STATE_KEY);
  f.data.set(R.STATE_KEY, { ...st, firstUse: st.firstUse - 3 * DAY });
  f.vscode.env.sessionId = 's2';
  p = make();
  await p.success();
  await p.success();
  assert.equal(f.calls.shown.length, 1, 'once per session');
  assert.equal(f.calls.shown[0][0], 'X has opened 7 files for you.');
  assert.deepEqual(f.calls.shown[0][1], [R.RATE, R.LATER, R.NEVER]);
  assert.deepEqual(f.calls.opened, [R.reviewUrl('zovo.x')]);
  assert.equal(f.data.get(R.STATE_KEY).done, true);
});

test('rating: prompt wiring respects the setting and a missing globalState', async () => {
  const f = fakeVscode({ enabled: false, sessionId: 's2' });
  f.data.set(R.STATE_KEY, { count: 30, firstUse: 1, firstSession: 's1', nextAt: 5, asks: 0, done: false });
  const p = R.createRatingPrompt({ vscode: f.vscode, context: f.context, extensionId: 'zovo.x', section: 'x', message: String });
  await p.success();
  assert.equal(f.calls.shown.length, 0);
  await R.createRatingPrompt({ vscode: f.vscode, context: {}, extensionId: 'zovo.x', section: 'x', message: String }).success();
});
