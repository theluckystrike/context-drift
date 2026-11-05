'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const { tempRepo, engine, FIX } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'context-drift.js');
const NOW = Date.UTC(2026, 10, 5); // 2026-11-05

function hasGit() { try { cp.execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } }

/** Builds a git repo: AGENTS.md committed at fileDate, then `n` empty commits at laterDate. */
function gitRepo(fileDate, n, laterDate) {
  const r = tempRepo({ 'AGENTS.md': '# Old guide\n- run the tests\n' });
  const g = (args, date) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: r.dir, stdio: 'ignore', env: Object.assign({}, process.env, date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
  });
  g(['init', '-q']);
  g(['add', 'AGENTS.md']);
  g(['commit', '-q', '-m', 'guide'], fileDate);
  for (let i = 0; i < n; i++) g(['commit', '-q', '--allow-empty', '-m', 'c' + i], laterDate);
  return r;
}

test('CD006 TP: file 400+ days old with 55 commits since (opt-in with stale:true, async git)', { skip: !hasGit() }, async () => {
  const r = gitRepo('2025-09-01T12:00:00Z', 55, '2026-10-01T12:00:00Z');
  try {
    const res = await engine.analyzeWorkspaceAsync(r.dir, { now: NOW, stale: true });
    assert.equal(res.diagnostics.length, 1);
    const d = res.diagnostics[0];
    assert.deepEqual([d.ruleId, d.severity, d.line, d.column, d.endColumn], ['CD006', 'info', 0, 0, 11]);
    assert.match(d.message, /429 days ago \(2025-09-01\); the repo has 55 commits since/);
  } finally { r.cleanup(); }
});

test('CD006 is off by default, and the sync API never runs git', { skip: !hasGit() }, async () => {
  const r = gitRepo('2025-09-01T12:00:00Z', 55, '2026-10-01T12:00:00Z');
  try {
    assert.deepEqual((await engine.analyzeWorkspaceAsync(r.dir, { now: NOW })).diagnostics, []);
    assert.deepEqual(engine.analyzeWorkspace(r.dir, { now: NOW, stale: true }).diagnostics, []);
  } finally { r.cleanup(); }
});

test('CD006 TN: old file but only 10 commits since', { skip: !hasGit() }, async () => {
  const r = gitRepo('2025-09-01T12:00:00Z', 10, '2026-10-01T12:00:00Z');
  try { assert.deepEqual((await engine.analyzeWorkspaceAsync(r.dir, { now: NOW, stale: true })).diagnostics, []); } finally { r.cleanup(); }
});

test('CD006 edge: recent file, and git:false / no git repo skip silently', { skip: !hasGit() }, async () => {
  const r = gitRepo('2026-10-01T12:00:00Z', 60, '2026-10-02T12:00:00Z');
  try {
    assert.deepEqual((await engine.analyzeWorkspaceAsync(r.dir, { now: NOW, stale: true })).diagnostics, []);
    assert.deepEqual((await engine.analyzeWorkspaceAsync(r.dir, { now: NOW, stale: true, git: false, staleDays: 1 })).diagnostics, []);
  } finally { r.cleanup(); }
  const plain = tempRepo({ 'AGENTS.md': '# x\n' });
  try { assert.deepEqual((await engine.analyzeWorkspaceAsync(plain.dir, { now: NOW, stale: true })).diagnostics, []); } finally { plain.cleanup(); }
});

test('git runs with a timeout: a hung git resolves to null within the budget', async () => {
  const t0 = Date.now();
  // `git cat-file --batch` waits for stdin forever; the runner must give up on its timer
  const out = await engine._internal.runGit(__dirname, ['cat-file', '--batch'], { timeout: 300, input: undefined });
  assert.ok(out === null || typeof out === 'string');
  assert.ok(Date.now() - t0 < 2000);
});

test('git check-ignore and ls-files drop ignored and tracked-but-absent paths', { skip: !hasGit() }, async () => {
  const r = gitRepo('2026-10-01T12:00:00Z', 0, '2026-10-01T12:00:00Z');
  try {
    fs.writeFileSync(path.join(r.dir, 'package.json'), '{"name":"x"}');
    fs.writeFileSync(path.join(r.dir, '.git', 'info', 'exclude'), 'secret-out/\n');
    fs.mkdirSync(path.join(r.dir, 'docs'));
    fs.writeFileSync(path.join(r.dir, 'docs', 'kept.md'), 'x');
    cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'add', '.'], { cwd: r.dir, stdio: 'ignore' });
    cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'x'], { cwd: r.dir, stdio: 'ignore' });
    fs.rmSync(path.join(r.dir, 'docs', 'kept.md')); // tracked in the index, missing on disk (like a sparse checkout)
    fs.writeFileSync(path.join(r.dir, 'AGENTS.md'), 'See `docs/kept.md`, `secret-out/x.json` and `docs/gone.md`.\n');
    const res = await engine.analyzeWorkspaceAsync(r.dir, { now: NOW });
    assert.deepEqual(res.diagnostics.map((d) => d.message), ['Path "docs/gone.md" does not exist in the repo.']);
  } finally { r.cleanup(); }
});

/* ---------------- CLI ---------------- */

function cli(args, cwd) {
  return cp.spawnSync(process.execPath, [CLI, ...args], { cwd: cwd || FIX, encoding: 'utf8', timeout: 30000 });
}

test('CLI: exit 1 when errors exist; text output is file:line:col', () => {
  const r = cli(['--no-git', 'npm-basic']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^npm-basic\/AGENTS\.md:4:12: error CD001 /m);
  assert.match(r.stdout, /3 error\(s\), 6 warning\(s\), 2 info/);
});

test('CLI: exit 0 when only info findings exist', () => {
  assert.equal(cli(['--no-git', 'conflict']).status, 0);
});

test('CLI: --json is valid JSON with 1-based positions', () => {
  const r = cli(['--json', '--no-git', 'make-just']);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.counts, { error: 2, warning: 2, info: 0 });
  assert.deepEqual(j.diagnostics.map((d) => `${d.ruleId}@${d.line}:${d.column}`), ['CD001@4:9', 'CD001@9:9', 'CD001@11:9', 'CD001@12:9']);
});

test('CLI: --format github emits workflow annotations', () => {
  const r = cli(['--format', 'github', '--no-git', 'python']);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], '::warning file=python/CLAUDE.md,line=4,col=11,endLine=4,endColumn=21,title=Context Drift CD001::`uv run serve-docs`%3A "serve-docs" is not a script in pyproject.toml ([project.scripts]/[tool.poetry.scripts]) and not a declared dependency.'.replace('%3A', ':'));
  assert.ok(lines[1].startsWith('::warning file=python/CLAUDE.md,line=6,col=24,'));
  assert.equal(r.status, 0);
});

test('CLI: --fail-on warning, --ignore and --fail-on never', () => {
  assert.equal(cli(['--no-git', '--fail-on', 'warning', 'python']).status, 1);
  assert.equal(cli(['--no-git', '--fail-on=never', 'npm-basic']).status, 0);
  const r = cli(['--no-git', '--json', '--ignore', 'CD001,CD003', 'npm-basic']);
  assert.ok(JSON.parse(r.stdout).diagnostics.every((d) => d.ruleId !== 'CD001' && d.ruleId !== 'CD003'));
});

test('CLI: single file argument and usage errors', () => {
  const r = cli(['--no-git', '--json', 'go-cargo/AGENTS.md']);
  assert.equal(JSON.parse(r.stdout).diagnostics.length, 4);
  assert.equal(cli(['--bogus']).status, 2);
  assert.equal(cli(['no/such/dir']).status, 2);
  assert.match(cli(['--version']).stdout, /^\d+\.\d+\.\d+\n$/);
});

/* ---------------- performance ---------------- */

test('performance: 5,000-file repo (plus a big node_modules) under budget', () => {
  const files = { 'package.json': JSON.stringify({ scripts: { build: 'x', test: 'y' } }), 'package-lock.json': '{}' };
  for (let d = 0; d < 50; d++) for (let f = 0; f < 100; f++) files[`src/mod${d}/file${f}.ts`] = '';
  for (let i = 0; i < 3000; i++) files[`node_modules/pkg${i % 30}/f${i}.js`] = '';
  const lines = ['# Guide'];
  for (let i = 0; i < 100; i++) lines.push(`- \`npm run build\`, \`src/mod${i % 50}/file${i}.ts\`, \`src/mod${i % 50}/gone${i}.ts\`, Node 20`);
  files['AGENTS.md'] = lines.join('\n');
  const r = tempRepo(files);
  try {
    engine.analyzeWorkspace(r.dir, { git: false }); // warm the fs cache
    const t0 = process.hrtime.bigint();
    const res = engine.analyzeWorkspace(r.dir, { git: false });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(res.files.length, 1);
    assert.equal(res.diagnostics.filter((d) => d.ruleId === 'CD002').length, 100);
    process.stdout.write(`# perf: ${ms.toFixed(1)} ms for ${Object.keys(files).length - 3000} files\n`);
    assert.ok(ms < 300, `took ${ms} ms`);
  } finally { r.cleanup(); }
});
