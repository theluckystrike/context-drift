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
const MANIFEST_GLOB = '**/{package.json,Makefile,makefile,GNUmakefile,*.mk,justfile,Justfile,.justfile,Taskfile.yml,Taskfile.yaml,pyproject.toml,requirements*.txt,Cargo.toml,.cargo/config.toml,go.mod,.nvmrc,.node-version,.python-version,.tool-versions,runtime.txt,package-lock.json,npm-shrinkwrap.json,pnpm-lock.yaml,yarn.lock,bun.lock,bun.lockb,.gitignore}';
const INSTRUCTION_GLOB = '**/{AGENTS.md,CLAUDE.md,CLAUDE.local.md,GEMINI.md,SKILL.md,.cursorrules,.windsurfrules,.clinerules,.github/copilot-instructions.md,.github/instructions/*.instructions.md,.cursor/rules/**/*.mdc,.clinerules/**/*.md,.windsurf/rules/**/*.md}';
const CONTEXT_TTL_MS = 60 * 1000;
const DEBOUNCE_MS = 500;

let collection;
let statusItem;
const folderState = new Map(); // folder uri string -> { ctx, uris:Set<string>, count, files }
const timers = new Map();
const actionData = new Map(); // key -> diagnostic payload for code actions

function cfg(folder) { return vscode.workspace.getConfiguration('contextDrift', folder ? folder.uri : undefined); }

function relIn(folder, fsPath) {
  const rel = path.relative(folder.uri.fsPath, fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}
function isInstructionDoc(doc) {
  if (doc.uri.scheme !== 'file') return null;
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) return null;
  const rel = relIn(folder, doc.uri.fsPath);
  return rel && engine.classifyInstructionFile(rel) ? folder : null;
}
function key(uri, line, col, code) { return `${uri}|${line}|${col}|${code}`; }

function invalidate(folder) {
  const st = folderState.get(folder.uri.toString());
  if (st) st.ctx = null;
}
function invalidateAll() { for (const st of folderState.values()) st.ctx = null; }

function schedule(folder, delay) {
  const k = folder.uri.toString();
  clearTimeout(timers.get(k));
  timers.set(k, setTimeout(() => { timers.delete(k); runFolder(folder); }, delay === undefined ? DEBOUNCE_MS : delay));
}
function scheduleAll(delay) { for (const f of vscode.workspace.workspaceFolders || []) schedule(f, delay); }

function clearFolder(st) {
  for (const u of st.uris) collection.delete(vscode.Uri.parse(u));
  st.uris = new Set();
  st.count = 0;
  st.files = 0;
}

function runFolder(folder) {
  const k = folder.uri.toString();
  let st = folderState.get(k);
  if (!st) { st = { ctx: null, uris: new Set(), count: 0, files: 0 }; folderState.set(k, st); }
  const c = cfg(folder);
  if (!c.get('enable', true) || folder.uri.scheme !== 'file') { clearFolder(st); updateStatus(); return null; }
  try {
    if (!st.ctx || Date.now() - st.ctx.builtAt > CONTEXT_TTL_MS) st.ctx = engine.createContext(folder.uri.fsPath);
    const overrides = new Map();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file' || !doc.isDirty) continue;
      const rel = relIn(folder, doc.uri.fsPath);
      if (rel && engine.classifyInstructionFile(rel)) overrides.set(doc.uri.fsPath, doc.getText());
    }
    const result = engine.analyzeWorkspace(folder.uri.fsPath, {
      context: st.ctx,
      overrides,
      ignoreRules: c.get('ignoreRules', []),
      git: c.get('gitStaleness', true) && vscode.workspace.isTrusted,
      staleDays: c.get('staleDays', 180),
      staleCommits: c.get('staleCommits', 50),
    });
    const byFile = new Map();
    for (const d of result.diagnostics) {
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
    st.count = result.diagnostics.filter((d) => d.severity !== 'info').length;
    st.infos = result.diagnostics.length - st.count;
    st.files = result.files.length;
    updateStatus();
    return result;
  } catch (e) {
    console.error('[context-drift]', e);
    return null;
  }
}

function toDiagnostic(uri, folder, d) {
  const sev = d.severity === 'error' ? vscode.DiagnosticSeverity.Error : d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
  const range = new vscode.Range(d.line, d.column, d.endLine, Math.max(d.endColumn, d.column + 1));
  const diag = new vscode.Diagnostic(range, d.message, sev);
  diag.source = SOURCE;
  diag.code = { value: d.ruleId, target: vscode.Uri.parse(DOCS + (RULE_ANCHOR[d.ruleId] || 'rules')) };
  if (d.ruleId === 'CD006') diag.tags = [];
  if (d.related && d.related.length) {
    diag.relatedInformation = d.related.map((r) => new vscode.DiagnosticRelatedInformation(
      new vscode.Location(vscode.Uri.file(path.join(folder.uri.fsPath, r.file)), new vscode.Range(r.line, r.column, r.line, Math.max(r.endColumn || 0, r.column + 1))), r.message));
  }
  actionData.set(key(uri.toString(), d.line, d.column, d.ruleId), { d, root: folder.uri.fsPath });
  return diag;
}

function updateStatus() {
  let count = 0, infos = 0, files = 0;
  for (const st of folderState.values()) { count += st.count || 0; infos += st.infos || 0; files += st.files || 0; }
  if (!files) { statusItem.hide(); return; }
  statusItem.text = count ? `$(warning) Drift: ${count}` : '$(check) Drift: 0';
  statusItem.tooltip = `Context Drift: ${count} problem(s) and ${infos} note(s) in ${files} agent instruction file(s). Click to re-check the workspace.`;
  statusItem.show();
}

/* ---------------- code actions ---------------- */

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
      if (/\.(md|mdc)$/i.test(document.uri.fsPath) && d.ruleId !== 'CD006') {
        const line = document.lineAt(d.line);
        const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
        const a = new vscode.CodeAction(`Disable ${d.ruleId} for this line`, vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit();
        a.edit.insert(document.uri, new vscode.Position(d.line, 0), `${indent}<!-- context-drift-disable-next-line ${d.ruleId} -->\n`);
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

function activate(context) {
  collection = vscode.languages.createDiagnosticCollection(SOURCE);
  statusItem = vscode.window.createStatusBarItem('contextDrift.status', vscode.StatusBarAlignment.Left, 20);
  statusItem.name = 'Context Drift';
  statusItem.command = 'contextDrift.checkWorkspace';
  context.subscriptions.push(collection, statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('contextDrift.checkWorkspace', async () => {
      invalidateAll();
      let total = 0, files = 0;
      for (const f of vscode.workspace.workspaceFolders || []) {
        const r = runFolder(f);
        if (r) { total += r.diagnostics.length; files += r.files.length; }
      }
      if (!files) {
        vscode.window.showInformationMessage('Context Drift: no agent instruction files (AGENTS.md, CLAUDE.md, ...) found in this workspace.');
        return;
      }
      const pick = await vscode.window.showInformationMessage(`Context Drift: ${total} finding(s) in ${files} instruction file(s).`, total ? 'Show Problems' : undefined);
      if (pick === 'Show Problems') vscode.commands.executeCommand('workbench.actions.view.problems');
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

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => { const f = isInstructionDoc(doc); if (f) schedule(f, 50); }),
    vscode.workspace.onDidChangeTextDocument((e) => { const f = isInstructionDoc(e.document); if (f && e.contentChanges.length) schedule(f); }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const f = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!f) return;
      if (!isInstructionDoc(doc)) invalidate(f);
      schedule(f, 50);
    }),
    vscode.workspace.onDidCreateFiles(() => { invalidateAll(); scheduleAll(); }),
    vscode.workspace.onDidDeleteFiles(() => { invalidateAll(); scheduleAll(); }),
    vscode.workspace.onDidRenameFiles(() => { invalidateAll(); scheduleAll(); }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('contextDrift')) scheduleAll(0); }),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const f of e.removed) { const st = folderState.get(f.uri.toString()); if (st) clearFolder(st); folderState.delete(f.uri.toString()); }
      for (const f of e.added) schedule(f, 0);
      updateStatus();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => scheduleAll(0)),
  );

  for (const glob of [MANIFEST_GLOB, INSTRUCTION_GLOB]) {
    const w = vscode.workspace.createFileSystemWatcher(glob);
    const onFs = (uri) => { const f = vscode.workspace.getWorkspaceFolder(uri); if (f) { invalidate(f); schedule(f); } };
    w.onDidCreate(onFs); w.onDidChange(onFs); w.onDidDelete(onFs);
    context.subscriptions.push(w);
  }

  scheduleAll(0);
}

function deactivate() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  folderState.clear();
  actionData.clear();
}

module.exports = { activate, deactivate };
