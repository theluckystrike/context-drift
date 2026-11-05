'use strict';
const vscode = require('vscode');
const path = require('path');
const engine = require('./engine');

const SOURCE = 'context-drift';
const DOCS = 'https://github.com/theluckystrike/context-drift#';
const RULE_ANCHOR = {
  CD001: 'cd001-command-drift', CD002: 'cd002-path-drift', CD003: 'cd003-package-manager-drift',
  CD004: 'cd004-version-drift', CD005: 'cd005-cross-file-conflict', CD006: 'cd006-stale-file',
};
const MANIFEST_GLOB = '**/{package.json,Makefile,makefile,GNUmakefile,*.mk,justfile,Justfile,.justfile,Taskfile.yml,Taskfile.yaml,pyproject.toml,requirements*.txt,Cargo.toml,.cargo/config.toml,go.mod,.nvmrc,.node-version,.python-version,.tool-versions,runtime.txt,package-lock.json,npm-shrinkwrap.json,pnpm-lock.yaml,yarn.lock,bun.lock,bun.lockb,.gitignore,.gitmodules}';
const INSTRUCTION_GLOB = '**/{AGENTS.md,CLAUDE.md,CLAUDE.local.md,GEMINI.md,SKILL.md,.cursorrules,.windsurfrules,.clinerules,.github/copilot-instructions.md,.github/instructions/**/*.instructions.md,.cursor/rules/**/*.mdc,.clinerules/**/*.md,.windsurf/rules/**/*.md}';
const MANIFEST_BASENAME = /^(?:package\.json|[Mm]akefile|GNUmakefile|.*\.mk|[Jj]ustfile|\.justfile|[Tt]askfile(?:\.dist)?\.ya?ml|pyproject\.toml|requirements.*\.(?:txt|in)|Cargo\.toml|config\.toml|go\.mod|\.nvmrc|\.node-version|\.python-version|\.tool-versions|runtime\.txt|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.gitignore|\.gitmodules)$/;
const DEBOUNCE_MS = 500;
const FS_DEBOUNCE_MS = 2000;
/** A check that takes longer than this is abandoned (the worker is restarted). */
const RUN_BUDGET_MS = 30 * 1000;
const LEVEL = { none: 0, manifests: 1, files: 2 };

let collection;
let statusItem;
let runner;
const folderState = new Map(); // folder uri string -> state
const timers = new Map();
const actionData = new Map(); // key -> diagnostic payload for code actions

function cfg(folder) { return vscode.workspace.getConfiguration('contextDrift', folder ? folder.uri : undefined); }

function relIn(folder, fsPath) {
  const rel = path.relative(folder.uri.fsPath, fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}
function isInstructionDoc(doc) {
  if (!doc || !doc.uri || doc.uri.scheme !== 'file') return null;
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) return null;
  const rel = relIn(folder, doc.uri.fsPath);
  return rel && engine.classifyInstructionFile(rel) ? folder : null;
}
function isManifestPath(fsPath) { return MANIFEST_BASENAME.test(path.basename(fsPath)); }
/** Paths under node_modules, .git, dist, ... never change what the engine sees. */
function isIgnoredPath(folder, fsPath) {
  const rel = relIn(folder, fsPath);
  return !rel || rel.split('/').some((s) => engine.IGNORED_DIRS.has(s));
}
function key(uri, line, col, code) { return `${uri}|${line}|${col}|${code}`; }

/* ---------------- engine runner (worker thread, in-process fallback) ---------------- */

class EngineRunner {
  constructor() { this.worker = null; this.pending = new Map(); this.seq = 0; this.inProcess = null; this.disposed = false; }
  start() {
    if (this.worker || this.inProcess) return;
    try {
      const { Worker } = require('worker_threads');
      this.worker = new Worker(path.join(__dirname, 'worker.js'));
      this.worker.unref && this.worker.unref();
      this.worker.on('message', (m) => this.onMessage(m));
      this.worker.on('error', (e) => this.fail(String(e && e.message || e)));
      this.worker.on('exit', () => { this.worker = null; this.fail('worker exited'); });
    } catch (_) {
      this.inProcess = require('./worker'); // no worker_threads: run in process (still async git)
    }
  }
  onMessage(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.started) {
      // The budget counts from the moment the worker starts this request, not from the time it was queued
      // behind another folder's check.
      if (!p.timer) p.timer = setTimeout(() => this.timeout(m.id), RUN_BUDGET_MS);
      return;
    }
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    p.resolve(m);
  }
  timeout(id) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.resolve({ ok: false, error: 'timeout', timeout: true });
    this.restart(); // the other folders' requests resolve with 'restarted'; their callers run them again
  }
  fail(reason) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: reason }); }
    this.pending.clear();
  }
  request(msg) {
    if (this.disposed) return Promise.resolve({ ok: false, error: 'disposed' });
    this.start();
    if (this.inProcess) return this.inProcess.handle(msg).catch((e) => ({ ok: false, error: String(e) }));
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, timer: null });
      this.worker.postMessage(Object.assign({ id }, msg));
    });
  }
  restart() {
    const w = this.worker;
    this.worker = null;
    if (w) { w.removeAllListeners('exit'); w.removeAllListeners('message'); w.terminate().catch(() => {}); }
    this.fail(this.disposed ? 'disposed' : 'restarted');
  }
  dispose() { this.disposed = true; this.restart(); }
}

/* ---------------- scheduling ---------------- */

function stateFor(folder) {
  const k = folder.uri.toString();
  let st = folderState.get(k);
  if (!st) { st = { uris: new Set(), count: 0, infos: 0, files: 0, skipped: 0, invalidate: 'files', running: null, rerun: false, timedOut: false }; folderState.set(k, st); }
  return st;
}
function markInvalid(folder, level) {
  const st = stateFor(folder);
  if (LEVEL[level] > LEVEL[st.invalidate]) st.invalidate = level;
}
function schedule(folder, delay, level) {
  markInvalid(folder, level || 'none');
  const k = folder.uri.toString();
  clearTimeout(timers.get(k));
  timers.set(k, setTimeout(() => { timers.delete(k); runFolder(folder); }, delay === undefined ? DEBOUNCE_MS : delay));
}
function scheduleAll(delay, level) { for (const f of vscode.workspace.workspaceFolders || []) schedule(f, delay, level); }

function clearFolder(st) {
  for (const u of st.uris) collection.delete(vscode.Uri.parse(u));
  st.uris = new Set();
  st.count = 0;
  st.infos = 0;
  st.files = 0;
  st.skipped = 0;
}

/** Runs the check for one folder. Never blocks the extension host: the engine and git run in a worker. */
function runFolder(folder) {
  const st = stateFor(folder);
  if (st.running) { st.rerun = true; return st.running; }
  st.running = doRun(folder, st).finally(() => {
    st.running = null;
    if (st.rerun) { st.rerun = false; schedule(folder, 0); }
  });
  return st.running;
}

async function doRun(folder, st) {
  const c = cfg(folder);
  if (!c.get('enable', true) || folder.uri.scheme !== 'file') { clearFolder(st); updateStatus(); return null; }
  const overrides = [];
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== 'file' || !doc.isDirty) continue;
    const rel = relIn(folder, doc.uri.fsPath);
    if (rel && engine.classifyInstructionFile(rel)) overrides.push([doc.uri.fsPath, doc.getText()]);
  }
  const invalidate = st.invalidate;
  st.invalidate = 'none';
  const trusted = vscode.workspace.isTrusted !== false;
  const useGit = trusted && c.get('useGit', true);
  const res = await runner.request({
    type: 'analyze',
    root: folder.uri.fsPath,
    invalidate,
    overrides,
    options: {
      ignoreRules: c.get('ignoreRules', []),
      git: useGit,
      stale: useGit && c.get('gitStaleness', false),
      staleDays: c.get('staleDays', 180),
      staleCommits: c.get('staleCommits', 50),
    },
  });
  if (!res || !res.ok) {
    if (LEVEL[invalidate] > LEVEL[st.invalidate]) st.invalidate = invalidate;
    st.timedOut = !!(res && res.timeout);
    // Another folder's check ran over budget and the shared worker was restarted: this folder's check was
    // dropped, not failed. Run it again (the new worker builds a fresh context).
    if (res && res.error === 'restarted' && !runner.disposed && folderState.has(folder.uri.toString())) {
      st.invalidate = 'files';
      st.rerun = true;
    } else if (res && !res.timeout && res.error !== 'disposed') console.error('[context-drift]', res.error);
    updateStatus();
    return null;
  }
  st.timedOut = false;
  if (!folderState.has(folder.uri.toString())) return null; // folder removed meanwhile
  const byFile = new Map();
  for (const d of res.diagnostics) {
    if (!byFile.has(d.absFile)) byFile.set(d.absFile, []);
    byFile.get(d.absFile).push(d);
  }
  for (const k of actionData.keys()) if (st.uris.has(k.slice(0, k.indexOf('|')))) actionData.delete(k);
  const newUris = new Set();
  for (const [abs, list] of byFile) {
    const uri = vscode.Uri.file(abs);
    newUris.add(uri.toString());
    collection.set(uri, list.map((d) => toDiagnostic(uri, folder, d)));
  }
  for (const u of st.uris) if (!newUris.has(u)) collection.delete(vscode.Uri.parse(u));
  st.uris = newUris;
  st.count = res.diagnostics.filter((d) => d.severity !== 'info').length;
  st.infos = res.diagnostics.length - st.count;
  st.files = res.files.length;
  st.skipped = res.skipped.length;
  updateStatus();
  return res;
}

function toDiagnostic(uri, folder, d) {
  const sev = d.severity === 'error' ? vscode.DiagnosticSeverity.Error : d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
  const range = new vscode.Range(d.line, d.column, d.endLine, Math.max(d.endColumn, d.column + 1));
  const diag = new vscode.Diagnostic(range, d.message, sev);
  diag.source = SOURCE;
  diag.code = { value: d.ruleId, target: vscode.Uri.parse(DOCS + (RULE_ANCHOR[d.ruleId] || 'rules')) };
  if (d.related && d.related.length) {
    diag.relatedInformation = d.related.map((r) => new vscode.DiagnosticRelatedInformation(
      new vscode.Location(vscode.Uri.file(path.join(folder.uri.fsPath, r.file)), new vscode.Range(r.line, r.column, r.line, Math.max(r.endColumn || 0, r.column + 1))), r.message));
  }
  actionData.set(key(uri.toString(), d.line, d.column, d.ruleId), { d, root: folder.uri.fsPath });
  return diag;
}

function updateStatus() {
  let count = 0, infos = 0, files = 0, skipped = 0, timedOut = false;
  for (const st of folderState.values()) { count += st.count || 0; infos += st.infos || 0; files += st.files || 0; skipped += st.skipped || 0; timedOut = timedOut || st.timedOut; }
  if (!files && !timedOut) { statusItem.hide(); return; }
  statusItem.text = timedOut ? '$(clock) Drift: timed out' : count ? `$(warning) Drift: ${count}` : '$(check) Drift: 0';
  statusItem.tooltip = timedOut
    ? 'Context Drift: the check took longer than 30 s and was stopped. Click to try again.'
    : `Context Drift: ${count} problem(s) and ${infos} note(s) in ${files} agent instruction file(s)` +
      (skipped ? `; ${skipped} file(s) not fully checked (too large, long lines or outside the workspace)` : '') + '. Click to re-check the workspace.';
  statusItem.show();
}

/* ---------------- code actions ---------------- */

/** Where a "disable" directive must go for `line`: a YAML comment in frontmatter, above the fence for code blocks. */
function directiveEdit(document, line, ruleId) {
  const text = typeof document.getText === 'function' ? document.getText() : null;
  let at = line;
  let yaml = false;
  if (text !== null) {
    const doc = engine._internal.scanDocument(text);
    if (doc.frontmatter && line > doc.frontmatter.start && line < doc.frontmatter.end) yaml = true;
    else {
      const f = doc.fences.find((x) => line > x.start && line <= x.end);
      if (f) at = f.start;
    }
  }
  const lt = document.lineAt(at);
  const indent = lt.text.slice(0, lt.firstNonWhitespaceCharacterIndex);
  const comment = yaml ? `${indent}# context-drift-disable-next-line ${ruleId}\n` : `${indent}<!-- context-drift-disable-next-line ${ruleId} -->\n`;
  return { position: new vscode.Position(at, 0), text: comment, block: at !== line };
}

class DriftActions {
  provideCodeActions(document, _range, context) {
    const actions = [];
    for (const diag of context.diagnostics) {
      if (diag.source !== SOURCE) continue;
      const code = typeof diag.code === 'object' ? diag.code.value : diag.code;
      const entry = actionData.get(key(document.uri.toString(), diag.range.start.line, diag.range.start.character, code));
      if (!entry) continue;
      const { d, root } = entry;
      if (d.fix) {
        const a = new vscode.CodeAction(d.fix.title, vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit();
        a.edit.replace(document.uri, new vscode.Range(d.fix.line, d.fix.column, d.fix.endLine, d.fix.endColumn), d.fix.newText);
        a.diagnostics = [diag];
        a.isPreferred = true;
        actions.push(a);
      }
      const data = d.data || {};
      if (d.ruleId === 'CD001' && data.manifest) {
        const isPkg = /package\.json$/.test(data.manifest);
        const a = new vscode.CodeAction(isPkg ? `Show scripts in ${data.manifest}` : `Open ${data.manifest}`, vscode.CodeActionKind.QuickFix);
        a.command = { title: a.title, command: 'contextDrift.openManifest', arguments: [path.join(root, data.manifest), isPkg ? '"scripts"' : null] };
        a.diagnostics = [diag];
        actions.push(a);
      }
      if (d.ruleId === 'CD002' && data.kind === 'path' && typeof data.parent === 'string') {
        const a = new vscode.CodeAction(`Reveal "${data.parent || '.'}" (nearest existing folder) in Explorer`, vscode.CodeActionKind.QuickFix);
        a.command = { title: a.title, command: 'contextDrift.revealFolder', arguments: [path.join(root, data.parent)] };
        a.diagnostics = [diag];
        actions.push(a);
      }
      if (/\.(md|mdc)$/i.test(document.uri.fsPath) && d.ruleId !== 'CD006' && data.kind !== 'not-project-root' && data.kind !== 'capped') {
        const e = directiveEdit(document, d.line, d.ruleId);
        const a = new vscode.CodeAction(e.block ? `Disable ${d.ruleId} for this code block` : `Disable ${d.ruleId} for this line`, vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit();
        a.edit.insert(document.uri, e.position, e.text);
        a.diagnostics = [diag];
        actions.push(a);
      }
      const ig = new vscode.CodeAction(`Ignore ${d.ruleId} in this workspace`, vscode.CodeActionKind.QuickFix);
      ig.command = { title: ig.title, command: 'contextDrift.ignoreRule', arguments: [d.ruleId] };
      ig.diagnostics = [diag];
      actions.push(ig);
    }
    return actions;
  }
}

/* ---------------- activation ---------------- */

async function hasInstructionFiles() {
  if (typeof vscode.workspace.findFiles !== 'function') return true;
  try {
    const found = await vscode.workspace.findFiles(INSTRUCTION_GLOB, '**/{node_modules,.git,dist,build,vendor,target,.venv}/**', 1);
    return found.length > 0;
  } catch (_) { return true; }
}

function activate(context) {
  collection = vscode.languages.createDiagnosticCollection(SOURCE);
  statusItem = vscode.window.createStatusBarItem('contextDrift.status', vscode.StatusBarAlignment.Left, 20);
  statusItem.name = 'Context Drift';
  statusItem.command = 'contextDrift.checkWorkspace';
  runner = new EngineRunner();
  context.subscriptions.push(collection, statusItem, { dispose: () => runner && runner.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('contextDrift.checkWorkspace', async () => {
      let total = 0, files = 0;
      const folders = vscode.workspace.workspaceFolders || [];
      for (const f of folders) markInvalid(f, 'files');
      const results = await Promise.all(folders.map((f) => runFolder(f)));
      for (const r of results) if (r) { total += r.diagnostics.length; files += r.files.length; }
      if (!files) {
        vscode.window.showInformationMessage('Context Drift: no agent instruction files (AGENTS.md, CLAUDE.md, ...) found in this workspace.');
        return;
      }
      const pick = await vscode.window.showInformationMessage(`Context Drift: ${total} finding(s) in ${files} instruction file(s).`, total ? 'Show Problems' : undefined);
      if (pick === 'Show Problems') Promise.resolve(vscode.commands.executeCommand('workbench.actions.view.problems')).catch(() => {});
    }),
    vscode.commands.registerCommand('contextDrift.openManifest', async (file, needle) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const editor = await vscode.window.showTextDocument(doc);
      if (needle) {
        const idx = doc.getText().indexOf(needle);
        if (idx >= 0) {
          const pos = doc.positionAt(idx);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
        }
      }
    }),
    vscode.commands.registerCommand('contextDrift.revealFolder', (dir) => vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(dir))),
    vscode.commands.registerCommand('contextDrift.ignoreRule', async (ruleId) => {
      const c = vscode.workspace.getConfiguration('contextDrift');
      const cur = c.get('ignoreRules', []);
      if (!cur.includes(ruleId)) await c.update('ignoreRules', cur.concat([ruleId]), vscode.ConfigurationTarget.Workspace);
    }),
    vscode.languages.registerCodeActionsProvider([{ scheme: 'file', pattern: INSTRUCTION_GLOB }], new DriftActions(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
  );

  const on = (ev, fn) => { if (typeof ev === 'function') context.subscriptions.push(ev(fn)); };
  const ws = vscode.workspace;
  on(ws.onDidOpenTextDocument, (doc) => { const f = isInstructionDoc(doc); if (f) schedule(f, 50, 'none'); });
  on(ws.onDidChangeTextDocument, (e) => { const f = isInstructionDoc(e.document); if (f && e.contentChanges.length) schedule(f, DEBOUNCE_MS, 'none'); });
  // Saves: re-check only for instruction files and manifests; any other save changes nothing the engine reads.
  on(ws.onDidSaveTextDocument, (doc) => {
    const f = isInstructionDoc(doc);
    if (f) { schedule(f, 50, 'none'); return; }
    const folder = doc && doc.uri && doc.uri.scheme === 'file' ? ws.getWorkspaceFolder(doc.uri) : null;
    if (folder && isManifestPath(doc.uri.fsPath)) schedule(folder, 50, 'manifests');
  });
  // Closing a dirty instruction file without saving: drop the diagnostics computed from the unsaved text.
  on(ws.onDidCloseTextDocument, (doc) => { const f = isInstructionDoc(doc); if (f) schedule(f, 50, 'none'); });
  const filesChanged = (e) => {
    const uris = [].concat(e && e.files ? e.files : []).map((x) => (x && x.newUri) || x);
    for (const f of ws.workspaceFolders || []) if (!uris.length || uris.some((u) => u && u.fsPath && relIn(f, u.fsPath) !== null)) schedule(f, DEBOUNCE_MS, 'files');
  };
  on(ws.onDidCreateFiles, filesChanged);
  on(ws.onDidDeleteFiles, filesChanged);
  on(ws.onDidRenameFiles, filesChanged);
  on(ws.onDidChangeConfiguration, (e) => { if (e.affectsConfiguration('contextDrift')) scheduleAll(0, 'none'); });
  on(ws.onDidChangeWorkspaceFolders, (e) => {
    for (const f of e.removed) {
      const st = folderState.get(f.uri.toString());
      if (st) clearFolder(st);
      folderState.delete(f.uri.toString());
      if (runner) runner.request({ type: 'forget', root: f.uri.fsPath });
    }
    for (const f of e.added) schedule(f, 0, 'files');
    updateStatus();
  });
  on(ws.onDidGrantWorkspaceTrust, () => scheduleAll(0, 'none'));

  const watch = (glob, onChange, onCreateDelete) => {
    const w = ws.createFileSystemWatcher(glob);
    const wrap = (level, delay) => (uri) => {
      const f = ws.getWorkspaceFolder(uri);
      if (f && !isIgnoredPath(f, uri.fsPath)) schedule(f, delay, level);
    };
    if (onChange) w.onDidChange(wrap(onChange, DEBOUNCE_MS));
    w.onDidCreate(wrap(onCreateDelete, DEBOUNCE_MS));
    w.onDidDelete(wrap(onCreateDelete, DEBOUNCE_MS));
    context.subscriptions.push(w);
  };
  watch(MANIFEST_GLOB, 'manifests', 'files');
  watch(INSTRUCTION_GLOB, 'none', 'files');
  // any other created or deleted file can make a referenced path appear or disappear: re-walk, debounced
  const any = ws.createFileSystemWatcher('**/*', false, true, false);
  const onAny = (uri) => { const f = ws.getWorkspaceFolder(uri); if (f && !isIgnoredPath(f, uri.fsPath)) schedule(f, FS_DEBOUNCE_MS, 'files'); };
  any.onDidCreate(onAny);
  any.onDidDelete(onAny);
  context.subscriptions.push(any);

  hasInstructionFiles().then((yes) => { if (yes) scheduleAll(0, 'files'); }, () => scheduleAll(0, 'files'));
}

function deactivate() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  folderState.clear();
  actionData.clear();
  if (runner) { runner.dispose(); runner = null; }
}

module.exports = { activate, deactivate, _test: { getRunner: () => runner, folderState } };
