'use strict';
// Loads src/extension.js against a minimal fake `vscode` module.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const { FIX } = require('./helpers');

function makeVscode(root, settings, opts) {
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
  if (opts && opts.getDiagnostics) vscode.languages.getDiagnostics = (u) => opts.getDiagnostics(sets.get(u.fsPath) || []);
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
  assert.deepEqual(titles, ['Replace with "build"', 'Show scripts in package.json', 'Disable CD001 for this line', 'Ignore CD001 in this workspace', 'Apply all 2 Context Drift fixes in this file']);
  ext.deactivate();
});

test('extension: "Apply all" replaces every fix in the file, using only the markers in the published list', async () => {
  const root = path.join(FIX, 'readme-example');
  const file = path.join(root, 'AGENTS.md');
  const lineAt = () => ({ text: '', firstNonWhitespaceCharacterIndex: 0 });
  // 1. Without languages.getDiagnostics: every stored fix is used.
  let m = makeVscode(root, {});
  let ext = loadExtension(m.vscode);
  ext.activate({ subscriptions: [] });
  await m.commands.get('contextDrift.checkWorkspace')();
  let diags = m.sets.get(file);
  let doc = { uri: m.vscode.Uri.file(file), lineAt };
  let typo = diags.find((d) => d.code.value === 'CD001' && d.range.start.line === 2 && d.range.start.character === 18);
  let all = m.getProvider().provideCodeActions(doc, null, { diagnostics: [typo] }).find((a) => /^Apply all/.test(a.title));
  assert.equal(all.title, 'Apply all 3 Context Drift fixes in this file');
  assert.deepEqual(all.edit.ops.map((o) => [o[1].start.line, o[1].start.character, o[2]]), [[1, 16, 'npm'], [2, 18, 'build'], [3, 16, 'src/main.ts']]);
  ext.deactivate();

  // 2. With languages.getDiagnostics: a fix whose marker isn't in the published list at its checked position is dropped.
  m = makeVscode(root, {}, { getDiagnostics: (list) => list.map((d) => (d.range.start.line === 1 ? Object.assign({}, d, { range: new m.vscode.Range(1, 20, 1, 24) }) : d)) });
  ext = loadExtension(m.vscode);
  ext.activate({ subscriptions: [] });
  await m.commands.get('contextDrift.checkWorkspace')();
  diags = m.sets.get(file);
  doc = { uri: m.vscode.Uri.file(file), lineAt };
  typo = diags.find((d) => d.code.value === 'CD001' && d.range.start.line === 2 && d.range.start.character === 18);
  all = m.getProvider().provideCodeActions(doc, null, { diagnostics: [typo] }).find((a) => /^Apply all/.test(a.title));
  assert.equal(all.title, 'Apply all 2 Context Drift fixes in this file');
  assert.deepEqual(all.edit.ops.map((o) => o[2]), ['build', 'src/main.ts']);
  assert.equal(all.diagnostics.length, 2);
  ext.deactivate();
});

test('extension: no "Apply all" after the document changed since the check (version check)', async () => {
  const root = path.join(FIX, 'readme-example');
  const file = path.join(root, 'AGENTS.md');
  const lineAt = () => ({ text: '', firstNonWhitespaceCharacterIndex: 0 });
  const m = makeVscode(root, {});
  const uri = m.vscode.Uri.file(file);
  // The file is open and saved at version 3 when the check runs.
  m.vscode.workspace.textDocuments = [{ uri, version: 3, isDirty: false, getText: () => { throw new Error('saved text is read from disk'); } }];
  const ext = loadExtension(m.vscode);
  ext.activate({ subscriptions: [] });
  await m.commands.get('contextDrift.checkWorkspace')();
  const typo = m.sets.get(file).find((d) => d.code.value === 'CD001' && d.range.start.line === 2 && d.range.start.character === 18);
  const applyAll = (doc) => m.getProvider().provideCodeActions(doc, null, { diagnostics: [typo] }).filter((a) => /^Apply all/.test(a.title));
  const single = (doc) => m.getProvider().provideCodeActions(doc, null, { diagnostics: [typo] }).filter((a) => a.title === 'Replace with "build"');
  assert.equal(applyAll({ uri, lineAt, version: 3, isDirty: false }).length, 1);
  // One keystroke later (version 4), before the re-check: no "Apply all". The single fix for the marker stays.
  assert.equal(applyAll({ uri, lineAt, version: 4, isDirty: true }).length, 0);
  assert.equal(single({ uri, lineAt, version: 4, isDirty: true }).length, 1);
  // The re-check reads version 4: "Apply all" is back.
  m.vscode.workspace.textDocuments = [{ uri, version: 4, isDirty: false, getText: () => '' }];
  await m.commands.get('contextDrift.checkWorkspace')();
  assert.equal(applyAll({ uri, lineAt, version: 4, isDirty: false }).length, 1);
  ext.deactivate();
});

test('extension: no "Apply all" for a file that was closed at check time and has unsaved edits now', async () => {
  const root = path.join(FIX, 'readme-example');
  const file = path.join(root, 'AGENTS.md');
  const lineAt = () => ({ text: '', firstNonWhitespaceCharacterIndex: 0 });
  const m = makeVscode(root, {});
  const ext = loadExtension(m.vscode);
  ext.activate({ subscriptions: [] });
  await m.commands.get('contextDrift.checkWorkspace')();
  const uri = m.vscode.Uri.file(file);
  const typo = m.sets.get(file).find((d) => d.code.value === 'CD001' && d.range.start.line === 2 && d.range.start.character === 18);
  const applyAll = (doc) => m.getProvider().provideCodeActions(doc, null, { diagnostics: [typo] }).filter((a) => /^Apply all/.test(a.title));
  assert.equal(applyAll({ uri, lineAt, version: 1, isDirty: false }).length, 1);
  assert.equal(applyAll({ uri, lineAt, version: 2, isDirty: true }).length, 0);
  ext.deactivate();
});

test('extension: no "Apply all" when the file has one fix or none', async () => {
  const root = path.join(FIX, 'readme-example');
  const file = path.join(root, 'AGENTS.md');
  const m = makeVscode(root, {}, { getDiagnostics: (list) => list.filter((d) => !(d.code.value === 'CD003' || d.code.value === 'CD002')) });
  const ext = loadExtension(m.vscode);
  ext.activate({ subscriptions: [] });
  await m.commands.get('contextDrift.checkWorkspace')();
  const diags = m.sets.get(file);
  const doc = { uri: m.vscode.Uri.file(file), lineAt: () => ({ text: '', firstNonWhitespaceCharacterIndex: 0 }) };
  const typo = diags.find((d) => d.code.value === 'CD001' && d.range.start.character === 18);
  const titles = m.getProvider().provideCodeActions(doc, null, { diagnostics: [typo] }).map((a) => a.title);
  assert.equal(titles.some((t) => /^Apply all/.test(t)), false);
  ext.deactivate();
});

test('package.json: walkthrough steps point at files that ship and commands that exist', () => {
  const fs = require('fs');
  const pkgRoot = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  assert.ok(pkg.keywords.length <= 30);
  const ids = new Set(pkg.contributes.commands.map((c) => c.command));
  const src = fs.readFileSync(path.join(pkgRoot, 'src', 'extension.js'), 'utf8');
  for (const id of ids) assert.ok(src.includes(`'${id}'`), id + ' is registered');
  const [wt] = pkg.contributes.walkthroughs;
  assert.equal(wt.id, 'contextDrift.start');
  assert.ok(src.includes(`#${wt.id}`));
  for (const step of wt.steps) {
    const media = step.media.markdown || step.media.image;
    assert.ok(fs.existsSync(path.join(pkgRoot, media)), media);
    for (const m of step.description.matchAll(/command:(contextDrift\.[A-Za-z]+)/g)) assert.ok(ids.has(m[1]), m[1]);
  }
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
