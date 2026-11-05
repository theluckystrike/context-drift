'use strict';
// Loads src/extension.js against a minimal fake `vscode` module.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const { FIX } = require('./helpers');

function makeVscode(root, settings) {
  const sets = new Map();
  const commands = new Map();
  let provider = null;
  const status = { shown: false, text: '', show() { this.shown = true; }, hide() { this.shown = false; } };
  class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
  class Uri { constructor(p) { this.fsPath = p; this.scheme = 'file'; } toString() { return 'file://' + this.fsPath; } static file(p) { return new Uri(p); } static parse(s) { return new Uri(s.replace(/^file:\/\//, '')); } }
  class WorkspaceEdit { constructor() { this.ops = []; } replace(u, r, t) { this.ops.push(['replace', r, t]); } insert(u, p, t) { this.ops.push(['insert', p, t]); } }
  const folder = { uri: Uri.file(root), name: 'f', index: 0 };
  const noop = () => ({ dispose() {} });
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
      createDiagnosticCollection: () => ({ set: (u, d) => sets.set(u.fsPath, d), delete: (u) => sets.delete(u.fsPath), dispose() {} }),
      registerCodeActionsProvider: (sel, p) => { provider = p; return { dispose() {} }; },
    },
    window: { createStatusBarItem: () => status, showInformationMessage: async () => undefined },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, executeCommand: async () => {} },
    workspace: {
      workspaceFolders: [folder], isTrusted: true, textDocuments: [],
      getWorkspaceFolder: () => folder,
      getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d), update: async () => {} }),
      onDidOpenTextDocument: noop, onDidChangeTextDocument: noop, onDidSaveTextDocument: noop, onDidCreateFiles: noop,
      onDidDeleteFiles: noop, onDidRenameFiles: noop, onDidChangeConfiguration: noop, onDidChangeWorkspaceFolders: noop, onDidGrantWorkspaceTrust: noop,
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
    },
  };
  return { vscode, sets, commands, status, getProvider: () => provider };
}

function loadExtension(fake) {
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? fake : orig.call(this, req, ...rest); };
  try {
    delete require.cache[require.resolve('../src/extension')];
    return require('../src/extension');
  } finally { Module._load = orig; }
}

test('extension: check command publishes diagnostics, status bar and quick fixes', async () => {
  const root = path.join(FIX, 'npm-basic');
  const m = makeVscode(root, { gitStaleness: false });
  const ext = loadExtension(m.vscode);
  const ctx = { subscriptions: [] };
  ext.activate(ctx);
  await m.commands.get('contextDrift.checkWorkspace')();
  const diags = m.sets.get(path.join(root, 'AGENTS.md'));
  assert.equal(diags.length, 10);
  assert.equal(m.status.text, '$(warning) Drift: 9');
  assert.equal(m.status.shown, true);
  const typo = diags.find((d) => d.range.start.line === 3);
  assert.deepEqual([typo.code.value, typo.source, typo.severity], ['CD001', 'context-drift', 0]);
  const doc = { uri: m.vscode.Uri.file(path.join(root, 'AGENTS.md')), lineAt: () => ({ text: '- `npm run buidl`', firstNonWhitespaceCharacterIndex: 0 }) };
  const titles = m.getProvider().provideCodeActions(doc, null, { diagnostics: [typo] }).map((a) => a.title);
  assert.deepEqual(titles, ['Replace with "build"', 'Show scripts in package.json', 'Disable CD001 for this line', 'Ignore CD001 in this workspace']);
  ext.deactivate();
});

test('extension: contextDrift.enable=false clears everything', async () => {
  const root = path.join(FIX, 'npm-basic');
  const m = makeVscode(root, { enable: false });
  const ext = loadExtension(m.vscode);
  ext.activate({ subscriptions: [] });
  await m.commands.get('contextDrift.checkWorkspace')();
  assert.equal(m.sets.size, 0);
  assert.equal(m.status.shown, false);
  ext.deactivate();
});
