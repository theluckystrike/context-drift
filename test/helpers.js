'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const engine = require('../src/engine');

const FIX = path.join(__dirname, 'fixtures');

function run(name, opts) {
  return engine.analyzeWorkspace(path.join(FIX, name), Object.assign({ git: false }, opts || {}));
}
/** diagnostics for one file, as compact tuples "RULE severity line:col-endCol" (0-based) */
function tuples(result, file) {
  return result.diagnostics.filter((d) => d.file === file).map((d) => `${d.ruleId} ${d.severity} ${d.line}:${d.column}-${d.endColumn}`);
}
function at(result, file, line, ruleId) {
  return result.diagnostics.filter((d) => d.file === file && d.line === line && (!ruleId || d.ruleId === ruleId));
}
/** Creates a temp repo from {relPath: content}. Returns {dir, cleanup}. */
function tempRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-drift-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
module.exports = { FIX, run, tuples, at, tempRepo, engine };
