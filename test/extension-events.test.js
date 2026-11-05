'use strict';
// Drives src/extension.js against a fake `vscode` with real event emitters: what triggers a check,
// which cache level is invalidated, dirty-buffer close, quick-fix placement and untrusted mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const { tempRepo, engine } = require('./helpers');

function emitter() { const ls = []; const ev = (fn) => { ls.push(fn); return { dispose() {} }; }; ev.fire = (x) => ls.forEach((f) => f(x)); return ev; }

function makeVscode(root, settings, trusted) {
  const sets = new Map();
  const commands = new Map();
  let provider = null;
  const status = { shown: false, text: '', tooltip: '', show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} };
  class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
  class Uri { constructor(p) { this.fsPath = p; this.scheme = 'file'; } toString() { return 'file://' + this.fsPath; } static file(p) { return new Uri(p); } static parse(s) { return new Uri(s.replace(/^file:\/\//, '')); } }
  class WorkspaceEdit { constructor() { this.ops = []; } replace(u, r, t) { this.ops.push(['replace', r, t]); } insert(u, p, t) { this.ops.push(['insert', p, t]); } }
  const folder = { uri: Uri.file(root), name: 'f', index: 0 };
  const ev = {};
  for (const n of ['onDidOpenTextDocument', 'onDidChangeTextDocument', 'onDidSaveTextDocument', 'onDidCloseTextDocument', 'onDidCreateFiles', 'onDidDeleteFiles', 'onDidRenameFiles', 'onDidChangeConfiguration', 'onDidChangeWorkspaceFolders', 'onDidGrantWorkspaceTrust']) ev[n] = emitter();
  const watchers = [];
  const vscode = {
    Range, Uri, WorkspaceEdit,
    Position: class { constructor(l, c) { this.line = l; this.character = c; } },
    Selection: class {},
    Location: class { constructor(u, r) { this.uri = u; this.range = r; } },
    Diagnostic: class { constructor(r, m, s) { this.range = r; this.message = m; this.severity = s; } },
    DiagnosticRelatedInformation: class { constructor(l, m) { this.location = l; this.message = m; } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    StatusBarAlignment: { Left: 1 },
    CodeActionKind: { QuickFix: 'quickfix' },
    CodeAction: class { constructor(t, k) { this.title = t; this.kind = k; } },
    ConfigurationTarget: { Workspace: 2 },
    TextEditorRevealType: { AtTop: 3 },
    languages: {
      createDiagnosticCollection: () => ({ set: (u, d) => sets.set(u.fsPath, d), delete: (u) => sets.delete(u.fsPath), dispose() { sets.clear(); } }),
      registerCodeActionsProvider: (sel, p) => { provider = p; return { dispose() {} }; },
    },
    window: { createStatusBarItem: () => status, showInformationMessage: async () => undefined },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, executeCommand: async () => {} },
    workspace: Object.assign({
      workspaceFolders: [folder], isTrusted: trusted !== false, textDocuments: [],
      getWorkspaceFolder: () => folder,
      getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d), update: async (k, v) => { settings[k] = v; } }),
      createFileSystemWatcher: (glob) => { const w = { glob, onDidCreate: emitter(), onDidChange: emitter(), onDidDelete: emitter(), dispose() {} }; watchers.push(w); return w; },
      findFiles: async () => [{}],
    }, ev),
  };
  return { vscode, sets, commands, status, ev, folder, watchers, getProvider: () => provider };
}
function loadExtension(fake) {
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? fake : orig.call(this, req, ...rest); };
  try { delete require.cache[require.resolve('../src/extension')]; return require('../src/extension'); } finally { Module._load = orig; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 5000)) { if (fn()) return true; await sleep(20); } return false; }
function doc(m, abs, text, dirty) {
  return {
    uri: m.vscode.Uri.file(abs), isDirty: !!dirty, getText: () => text,
    lineAt: (n) => { const t = text.split('\n')[n] || ''; return { text: t, firstNonWhitespaceCharacterIndex: t.length - t.trimStart().length }; },
  };
}

/** Activates the extension on a temp repo and records every request sent to the engine worker. */
async function setup(files, settings, trusted) {
  const r = tempRepo(files);
  const m = makeVscode(r.dir, settings || {}, trusted);
  const ext = loadExtension(m.vscode);
  ext.activate({ subscriptions: [] });
  const runner = ext._test.getRunner();
  const requests = [];
  const orig = runner.request.bind(runner);
  runner.request = (msg) => { if (msg.type === 'analyze') requests.push({ invalidate: msg.invalidate, git: msg.options.git, stale: msg.options.stale }); return orig(msg); };
  await waitFor(() => m.status.shown);
  return { r, m, ext, requests, done: () => { ext.deactivate(); r.cleanup(); } };
}

const FILES = {
  'package.json': '{"name":"x","scripts":{"build":"x"}}',
  'AGENTS.md': '# Agents\n\nBuild: `npm run build`.\n',
  '.cursor/rules/vue.mdc': '---\ndescription: vue\nglobs: src/**/*.vue\n---\nUse script setup.\n\n```bash\nnpm run nope-in-fence\n```\n',
  'src/a.ts': 'x',
};

test('extension: saving an unrelated file runs nothing; a manifest save re-reads manifests only; an instruction save reuses the cache', async () => {
  const s = await setup(FILES, { useGit: false });
  const { m, requests } = s;
  try {
    assert.ok(m.sets.has(path.join(s.r.dir, '.cursor/rules/vue.mdc')));
    requests.length = 0;
    for (let i = 0; i < 5; i++) m.ev.onDidSaveTextDocument.fire(doc(m, path.join(s.r.dir, 'src/a.ts'), 'x'));
    await sleep(200);
    assert.deepEqual(requests, [], 'a source file save does not run the engine');
    m.ev.onDidSaveTextDocument.fire(doc(m, path.join(s.r.dir, 'package.json'), '{}'));
    await waitFor(() => requests.length === 1);
    assert.equal(requests[0].invalidate, 'manifests');
    m.ev.onDidSaveTextDocument.fire(doc(m, path.join(s.r.dir, 'AGENTS.md'), 'x'));
    await waitFor(() => requests.length === 2);
    assert.equal(requests[1].invalidate, 'none');
    // a created file anywhere re-walks the folder (debounced); node_modules is ignored
    const any = m.watchers.find((w) => w.glob === '**/*');
    any.onDidCreate.fire(m.vscode.Uri.file(path.join(s.r.dir, 'node_modules/x/index.js')));
    await sleep(100);
    assert.equal(requests.length, 2);
  } finally { s.done(); }
});

test('extension: closing a dirty instruction file without saving drops the unsaved diagnostics (CDR-20)', async () => {
  const s = await setup(FILES, { useGit: false });
  const { m } = s;
  try {
    const agents = path.join(s.r.dir, 'AGENTS.md');
    const dirty = doc(m, agents, '# Agents\n\nBuild: `npm run nope-unsaved`.\n', true);
    m.vscode.workspace.textDocuments = [dirty];
    m.ev.onDidChangeTextDocument.fire({ document: dirty, contentChanges: [{}] });
    assert.ok(await waitFor(() => (m.sets.get(agents) || []).some((d) => /nope-unsaved/.test(d.message))));
    m.vscode.workspace.textDocuments = [];
    m.ev.onDidCloseTextDocument.fire(dirty);
    assert.ok(await waitFor(() => !m.sets.has(agents)), 'diagnostics from the unsaved text are gone');
  } finally { s.done(); }
});

test('extension: "disable" quick fix uses a YAML comment in frontmatter and goes above a code fence (CDR-19)', async () => {
  const s = await setup(Object.assign({}, FILES, { 'AGENTS.md': '# Agents\n\n```bash\nnpm run nope-in-agents\n```\n' }), { useGit: false });
  const { m } = s;
  try {
    const mdcAbs = path.join(s.r.dir, '.cursor/rules/vue.mdc');
    const mdcText = FILES['.cursor/rules/vue.mdc'];
    const glob = m.sets.get(mdcAbs).find((d) => d.range.start.line === 2);
    const acts = m.getProvider().provideCodeActions(doc(m, mdcAbs, mdcText), null, { diagnostics: [glob] });
    const dis = acts.find((a) => /^Disable CD002/.test(a.title));
    assert.equal(dis.edit.ops[0][2], '# context-drift-disable-next-line CD002\n');
    assert.equal(dis.edit.ops[0][1].line, 2);
    // the engine honours the YAML form
    const fixed = mdcText.split('\n'); fixed.splice(2, 0, '# context-drift-disable-next-line CD002');
    const ctx = engine.createContext(s.r.dir);
    assert.deepEqual(engine.analyzeText(ctx, '.cursor/rules/vue.mdc', fixed.join('\n')).diagnostics.filter((d) => d.ruleId === 'CD002'), []);

    const agentsAbs = path.join(s.r.dir, 'AGENTS.md');
    const agentsText = '# Agents\n\n```bash\nnpm run nope-in-agents\n```\n';
    const cmd = m.sets.get(agentsAbs).find((d) => d.range.start.line === 3);
    const a2 = m.getProvider().provideCodeActions(doc(m, agentsAbs, agentsText), null, { diagnostics: [cmd] }).find((a) => /^Disable CD001/.test(a.title));
    assert.equal(a2.title, 'Disable CD001 for this code block');
    assert.equal(a2.edit.ops[0][1].line, 2, 'inserted above the opening fence');
    const lines = agentsText.split('\n'); lines.splice(2, 0, a2.edit.ops[0][2].trimEnd());
    assert.deepEqual(engine.analyzeText(ctx, 'AGENTS.md', lines.join('\n')).diagnostics, []);
  } finally { s.done(); }
});

test('extension: untrusted workspace never asks for git; CD006 is off unless gitStaleness is set', async () => {
  const s2 = await setup(FILES, {}, false);
  try {
    s2.requests.length = 0;
    await s2.m.commands.get('contextDrift.checkWorkspace')();
    assert.deepEqual([s2.requests[0].git, s2.requests[0].stale], [false, false]);
  } finally { s2.done(); }
  const s3 = await setup(FILES, { gitStaleness: true }, true);
  try {
    s3.requests.length = 0;
    await s3.m.commands.get('contextDrift.checkWorkspace')();
    assert.deepEqual([s3.requests[0].git, s3.requests[0].stale], [true, true]);
  } finally { s3.done(); }
});

test('git that hangs is abandoned after the timeout, and the check still returns', { skip: process.platform === 'win32' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'context-drift-fakegit-'));
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const r = tempRepo({ 'AGENTS.md': 'See `docs/missing.md`.\n', 'package.json': '{}' });
  fs.mkdirSync(path.join(r.dir, '.git'));
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  try {
    const t0 = Date.now();
    const out = await engine._internal.runGit(r.dir, ['log'], { timeout: 300 });
    assert.equal(out, null);
    assert.ok(Date.now() - t0 < 1500, 'runGit gave up on its timer');
    const t1 = Date.now();
    const res = await engine.analyzeWorkspaceAsync(r.dir, { stale: true });
    assert.ok(Date.now() - t1 < 8000, 'analysis returns within two git timeouts');
    assert.deepEqual(res.diagnostics.map((d) => d.ruleId), ['CD002']);
  } finally {
    process.env.PATH = oldPath;
    try { cp.execFileSync('pkill', ['-f', path.join(bin, 'git')], { stdio: 'ignore' }); } catch (_) { /* none left */ }
    fs.rmSync(bin, { recursive: true, force: true });
    r.cleanup();
  }
});

// CDR2-06: one worker serves all folders. When another folder's check runs over budget, the worker is restarted
// and this folder's pending check is dropped: it must run again, not keep stale diagnostics.
test('extension: a check dropped by a worker restart runs again; the budget timer starts only when the worker starts', async () => {
  const s = await setup(FILES, { useGit: false });
  const { m, requests } = s;
  try {
    const runner = s.ext._test.getRunner();
    const wrapped = runner.request;
    let first = true;
    let timerAtSend;
    runner.request = (msg) => {
      const p = wrapped(msg);
      if (first && msg.type === 'analyze') {
        first = false;
        timerAtSend = [...runner.pending.values()].map((x) => x.timer);
        runner.restart(); // what happens when another folder's request times out
      }
      return p;
    };
    requests.length = 0;
    m.sets.clear();
    m.ev.onDidSaveTextDocument.fire(doc(m, path.join(s.r.dir, 'AGENTS.md'), FILES['AGENTS.md']));
    assert.ok(await waitFor(() => requests.length >= 2 && m.sets.has(path.join(s.r.dir, '.cursor/rules/vue.mdc')), 8000), `re-run after restart (requests: ${requests.length})`);
    assert.deepEqual(timerAtSend, [null], 'no budget timer while the request is queued');
  } finally { s.done(); }
});
