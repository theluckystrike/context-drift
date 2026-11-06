'use strict';
// One-time Marketplace rating prompt. No telemetry and no network: the only outbound action is the
// Marketplace page opened by the user's own click on "Rate it".
// The decision logic is pure (decide, recordSuccess, recordAnswer) so it can be unit tested without VS Code.

const STATE_KEY = 'zovo.rating.v1';
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_ASK = 5; // successes before the first ask
const LATER_STEP = 20; // more successes before asking again after "Later"
const MAX_LATER = 2; // asks after the first one, at most (3 in all)
const MIN_DAYS = 2; // days since first use before the first ask
const RATE = 'Rate it';
const LATER = 'Later';
const NEVER = "Don't ask again";

function freshState() {
  return { count: 0, firstUse: 0, firstSession: '', nextAt: FIRST_ASK, asks: 0, done: false };
}

function normalize(raw) {
  const s = freshState();
  if (!raw || typeof raw !== 'object') return s;
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  s.count = num(raw.count, 0);
  s.firstUse = num(raw.firstUse, 0);
  s.firstSession = typeof raw.firstSession === 'string' ? raw.firstSession : '';
  s.nextAt = Math.max(FIRST_ASK, num(raw.nextAt, FIRST_ASK));
  s.asks = num(raw.asks, 0);
  s.done = raw.done === true;
  return s;
}

/** Count one success. Returns a new state; the first success stores the date and the session. */
function recordSuccess(state, now, sessionId) {
  const s = normalize(state);
  s.count += 1;
  if (!s.firstUse) { s.firstUse = now; s.firstSession = String(sessionId || ''); }
  return s;
}

/**
 * Should the prompt show now?
 * env: { now, sessionId, enabled, focused, trusted, remote, askedThisSession }
 */
function decide(state, env) {
  const s = normalize(state);
  if (s.done || !env.enabled) return false;
  if (env.askedThisSession || !env.focused || !env.trusted || env.remote) return false;
  if (!env.sessionId || !s.firstUse) return false;
  if (s.firstSession === String(env.sessionId)) return false; // never in the first session
  if (env.now - s.firstUse < MIN_DAYS * DAY_MS) return false;
  if (s.asks > MAX_LATER) return false;
  return s.count >= s.nextAt;
}

/**
 * Apply an answer. 'shown' is written before the message opens: it uses up one ask and moves the next
 * ask LATER_STEP successes ahead, so "Later", closing the message, or quitting VS Code with it open all
 * wait for 20 more successes. "Rate it" and "Don't ask again" end it. After the last allowed ask, it ends.
 */
function recordAnswer(state, answer) {
  const s = normalize(state);
  if (answer === RATE || answer === NEVER) s.done = true;
  else if (answer === 'shown') {
    s.asks += 1;
    s.nextAt = s.count + LATER_STEP;
    if (s.asks > MAX_LATER) s.done = true;
  }
  return s;
}

function reviewUrl(extensionId) {
  return `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(extensionId)}&ssr=false#review-details`;
}

/**
 * opts: { vscode, context, extensionId, section, message(count) }
 * Returns { success() }: call it once per successful use of the main feature.
 */
function createRatingPrompt(opts) {
  const { vscode, context, extensionId, section, message } = opts;
  let askedThisSession = false;
  const store = context && context.globalState;
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };

  const env = () => ({
    now: Date.now(),
    sessionId: safe(() => vscode.env.sessionId, ''),
    enabled: safe(() => vscode.workspace.getConfiguration(section).get('askForRating', true) !== false, false),
    focused: safe(() => vscode.window.state.focused === true, false),
    trusted: safe(() => vscode.workspace.isTrusted !== false, false),
    remote: safe(() => !!vscode.env.remoteName, true),
    askedThisSession,
  });

  async function ask(s) {
    askedThisSession = true;
    let st = recordAnswer(s, 'shown');
    await store.update(STATE_KEY, st);
    const pick = await vscode.window.showInformationMessage(message(st.count), RATE, LATER, NEVER);
    st = recordAnswer(normalize(store.get(STATE_KEY)), pick);
    await store.update(STATE_KEY, st);
    if (pick === RATE) await vscode.env.openExternal(vscode.Uri.parse(reviewUrl(extensionId)));
  }

  async function success() {
    if (!store || typeof store.get !== 'function' || typeof store.update !== 'function') return;
    const e = env();
    const s = recordSuccess(store.get(STATE_KEY), e.now, e.sessionId);
    await store.update(STATE_KEY, s);
    if (decide(s, e)) await ask(s);
  }

  return { success: () => success().catch(() => {}) };
}

module.exports = {
  createRatingPrompt, decide, recordSuccess, recordAnswer, normalize, freshState, reviewUrl,
  STATE_KEY, DAY_MS, FIRST_ASK, LATER_STEP, MAX_LATER, MIN_DAYS, RATE, LATER, NEVER,
};
