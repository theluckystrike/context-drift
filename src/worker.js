'use strict';
/*
 * Runs the engine off the VS Code extension host. One worker serves all workspace folders and keeps a
 * cached repository context per folder:
 *   invalidate 'none'      -> reuse the file list and the parsed manifests (an instruction file changed)
 *   invalidate 'manifests' -> reuse the file list, re-read package.json, Makefile, lockfiles, ... (a manifest changed)
 *   invalidate 'files'     -> walk the folder again (files were created, deleted or renamed)
 * git runs only here, asynchronously, with a 3 s timeout per call.
 */
const { parentPort } = require('worker_threads');
const engine = require('./engine');

const contexts = new Map(); // root -> ctx
const MAX_CONTEXT_AGE_MS = 10 * 60 * 1000;

function contextFor(root, invalidate) {
  let ctx = contexts.get(root);
  if (ctx && (invalidate === 'files' || Date.now() - ctx.builtAt > MAX_CONTEXT_AGE_MS)) ctx = null;
  if (ctx && invalidate === 'manifests') engine.invalidateManifests(ctx);
  if (!ctx) { ctx = engine.createContext(root); contexts.set(root, ctx); }
  return ctx;
}

function plain(d) {
  // structured clone drops nothing important, but keep the payload small and explicit
  return {
    ruleId: d.ruleId, severity: d.severity, file: d.file, absFile: d.absFile, line: d.line, column: d.column,
    endLine: d.endLine, endColumn: d.endColumn, message: d.message, fix: d.fix, related: d.related, data: d.data,
  };
}

async function handle(msg) {
  if (msg.type === 'forget') { contexts.delete(msg.root); return { ok: true }; }
  const ctx = contextFor(msg.root, msg.invalidate);
  const r = await engine.analyzeWorkspaceAsync(msg.root, {
    context: ctx,
    overrides: new Map(msg.overrides || []),
    ignoreRules: msg.options.ignoreRules,
    git: msg.options.git,
    stale: msg.options.stale,
    staleDays: msg.options.staleDays,
    staleCommits: msg.options.staleCommits,
  });
  return { ok: true, files: r.files, skipped: r.skipped, diagnostics: r.diagnostics.map(plain), elapsedMs: r.elapsedMs };
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    handle(msg).then(
      (res) => parentPort.postMessage(Object.assign({ id: msg.id }, res)),
      (e) => parentPort.postMessage({ id: msg.id, ok: false, error: String(e && e.stack || e) }),
    );
  });
}

module.exports = { handle };
