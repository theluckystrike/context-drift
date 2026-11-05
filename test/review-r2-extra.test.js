'use strict';
// Regression tests for the round-2 review findings that are not plain engine cases (CDR2-03, -04, -05).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const cp = require('child_process');
const { tempRepo, engine } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'context-drift.js');
const MB = 1000 * 1000;
const L = 3990;
const fill = (line) => (line + '\n').repeat(Math.max(1, Math.floor(MB / (line.length + 1))));

// CDR2-03
test('CD002: a ../ path that leaves the opened folder is never reported (monorepo package opened alone)', () => {
  const r = tempRepo({
    'shared/config.ts': 'x',
    'app/package.json': '{"name":"a"}',
    'app/AGENTS.md': 'Shared config is in `../shared/config.ts`.\nSee [cfg](../shared/config.ts) and `../../../../etc/passwd`.\nRun `cd ../shared && npm test`.\n',
  });
  try {
    const res = engine.analyzeWorkspace(path.join(r.dir, 'app'), { git: false });
    assert.deepEqual(res.diagnostics.map((d) => d.message), []);
  } finally { r.cleanup(); }
});
test('CD002: a ../ path that stays inside the folder is still checked', () => {
  const r = tempRepo({ 'package.json': '{"name":"a"}', 'pkg/AGENTS.md': 'See `../docs/gone.md` and `../docs/here.md`.\n', 'docs/here.md': 'x' });
  try {
    const res = engine.analyzeWorkspace(r.dir, { git: false });
    assert.deepEqual(res.diagnostics.map((d) => d.message), ['Path "../docs/gone.md" does not exist in the repo.']);
  } finally { r.cleanup(); }
});

// CDR2-04
test('messages and CLI text output never carry control or bidi characters from the repo', () => {
  const r = tempRepo({
    'CLAUDE.md': 'See `src/\u001b[2Jboom.ts` now.\nRun `npm run a‮b` and `make x\u0007y`.\n',
    'package.json': '{"name":"x","scripts":{"build":"x"}}', 'package-lock.json': '{}', Makefile: 'build:\n\t@true\n', 'src/a.ts': 'x',
  });
  try {
    const res = engine.analyzeWorkspace(r.dir, { git: false });
    assert.ok(res.diagnostics.length >= 2, JSON.stringify(res.diagnostics.map((d) => d.message)));
    for (const d of res.diagnostics) assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(d.message), d.message);
    assert.ok(res.diagnostics.some((d) => d.message.includes('\\u202e')), 'bidi override shown as an escape');
    const out = cp.spawnSync(process.execPath, [BIN, '--no-git', r.dir], { encoding: 'utf8', timeout: 20000 });
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(out.stdout + out.stderr), JSON.stringify(out.stdout));
  } finally { r.cleanup(); }
});
test('CLI text output escapes control characters in file names', () => {
  const r = tempRepo({ 'package.json': '{"name":"x","scripts":{}}', 'package-lock.json': '{}' });
  try {
    const fs = require('fs');
    const dir = path.join(r.dir, 'a\u001b]0;pwned\u0007');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Run `npm run nope`.\n');
    const out = cp.spawnSync(process.execPath, [BIN, '--no-git', r.dir], { encoding: 'utf8', timeout: 20000 });
    assert.match(out.stdout, /CD001/);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(out.stdout + out.stderr), JSON.stringify(out.stdout));
  } finally { r.cleanup(); }
});

// CDR2-05 (the load tests are in redos.test.js, so they do not run in parallel with other timing tests)
test('a make command checks at most 32 targets', () => {
  const r = tempRepo({ 'AGENTS.md': 'Run `make ' + Array.from({ length: 50 }, (_, i) => 't' + i).join(' ') + '`.\n', Makefile: 'build:\n\t@true\n', 'package.json': '{}' });
  try { assert.equal(engine.analyzeWorkspace(r.dir, { git: false }).diagnostics.length, 32); } finally { r.cleanup(); }
});
test('a run over its time budget returns partial results and lists what was not checked', () => {
  const files = { 'package.json': '{"scripts":{"build":"x"}}' };
  for (let i = 0; i < 5; i++) files[`p${i}/AGENTS.md`] = 'Run `npm run nope`.\n';
  const r = tempRepo(files);
  try {
    const res = engine.analyzeWorkspace(r.dir, { git: false, deadline: 1 }); // a deadline in the past
    assert.equal(res.skipped.length, 5, JSON.stringify(res.skipped));
    assert.deepEqual(res.diagnostics, []);
    assert.ok(res.skipped.every((x) => /time budget/.test(x.reason)));
    const full = engine.analyzeWorkspace(r.dir, { git: false });
    assert.equal(full.diagnostics.length, 5);
    assert.deepEqual(full.skipped, []);
  } finally { r.cleanup(); }
});
