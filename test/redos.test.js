'use strict';
// Every adversarial input from the 0.1.0 review (CDR-01, CDR-02), scaled to about 1 MB.
// Lines are kept just under the 4,000-character cap so the parsers and regexes really run on them.
// Each case must finish in under 250 ms of CPU time (best of 5 runs). The quadratic versions took 5 s and more,
// so 250 ms still catches them with room for a busy machine (the slowest case takes 25-50 ms). CPU time, not wall time, so that
// `node --test` running files in parallel on a busy machine does not fail the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempRepo, engine } = require('./helpers');

const MB = 1000 * 1000;
const LINE = 3990;
/** Repeats `line` (plus "\n") until the text is about 1 MB. */
function fill(line) { return (line + '\n').repeat(Math.max(1, Math.floor(MB / (line.length + 1)))); }
function inc(n) { let s = ''; for (let k = 1; s.length < n; k++) s += '`'.repeat(k) + ' '; return s.slice(0, n); }

const CASES = {
  // CDR-01: globs from inline code, .mdc frontmatter and .gitignore against long file names
  'inline glob *a*a*a… vs a 200-char file name': { 'AGENTS.md': fill('Files: `src/' + '*a'.repeat(40) + '*.ts` and more'), ['src/' + 'a'.repeat(200)]: 'x' },
  'inline glob **/**/… vs a 40-deep path': { 'AGENTS.md': fill('Files: `' + '**/'.repeat(80) + 'zz.ts`'), ['d/'.repeat(40) + 'f.md']: 'x' },
  '.gitignore *a*a*a…*b vs a long missing path': { '.gitignore': fill('*a'.repeat(200) + '*b'), 'AGENTS.md': fill('See `docs/' + 'a'.repeat(120) + '.md`.') },
  '.mdc globs: src/*a*a*a…': { '.cursor/rules/x.mdc': '---\nglobs: src/' + '*a'.repeat(1900) + '*.ts\n---\n' + fill('body text'), ['src/' + 'a'.repeat(200)]: 'x' },
  'Taskfile wildcard task names': { 'Taskfile.yml': 'tasks:\n' + fill('  ' + '*a'.repeat(1900) + '*b:'), 'AGENTS.md': 'Run `task ' + 'a'.repeat(200) + '`.\n' },
  // CDR-02: line regexes
  'Node version + space run': { 'AGENTS.md': fill('Node 18' + ' '.repeat(LINE) + 'x'), '.nvmrc': '20\n' },
  'node version + space run': { 'AGENTS.md': fill('node version' + ' '.repeat(LINE) + 'x'), '.nvmrc': '20\n' },
  'Python version + space run': { 'AGENTS.md': fill('Python 3.11' + ' '.repeat(LINE) + 'x'), '.python-version': '3.12\n' },
  'Go version + space run': { 'AGENTS.md': fill('Go' + ' '.repeat(LINE) + 'x'), 'go.mod': 'module x\ngo 1.22\n' },
  'link label of "[" only': { 'AGENTS.md': fill('['.repeat(LINE)) },
  'link target + space run': { 'AGENTS.md': fill('[a](b' + ' '.repeat(LINE) + 'x') },
  'growing backtick runs': { 'AGENTS.md': fill(inc(LINE)) },
  'HTML comments inside code spans': { 'AGENTS.md': fill('`<!--` '.repeat(Math.floor(LINE / 7))) },
  'directive text repeated': { 'AGENTS.md': fill('context-drift-disable'.repeat(Math.floor(LINE / 21))) },
  'negation words before a command': { 'AGENTS.md': fill('no '.repeat(1300) + '`npm run x`'), 'package.json': '{"scripts":{"build":"x"}}' },
  'pyproject key + space run': { 'pyproject.toml': '[project]\n' + fill('a' + ' '.repeat(LINE) + 'b'), 'AGENTS.md': 'Run `uv run lintcheck`.\n' },
  'pyproject array with # runs': { 'pyproject.toml': '[project]\ndependencies = [\n' + fill('"a" ' + '#'.repeat(LINE)) + ']\n', 'AGENTS.md': 'Run `uv run lintcheck`.\n' },
  'justfile recipe + space run': { 'justfile': fill('a' + ' '.repeat(LINE) + 'b'), 'AGENTS.md': 'Run `just deploy`.\n' },
  'Makefile target + space run': { 'Makefile': fill('a' + ' '.repeat(LINE) + 'b'), 'AGENTS.md': 'Run `make test`.\n' },
  'Taskfile key + space run': { 'Taskfile.yml': 'tasks:\n' + fill(' a' + ' '.repeat(LINE) + 'b'), 'AGENTS.md': 'Run `task deploy`.\n' },
  'one 1 MB line (skipped by the line cap)': { 'AGENTS.md': 'Node 18' + ' '.repeat(MB) + 'x\n', '.nvmrc': '20\n' },
};

function best(dir) {
  let min = Infinity;
  let res;
  for (let k = 0; k < 5; k++) {
    const c0 = process.cpuUsage();
    res = engine.analyzeWorkspace(dir, { git: false });
    const c = process.cpuUsage(c0);
    const ms = (c.user + c.system) / 1000;
    if (ms < min) min = ms;
  }
  return { ms: min, res };
}

test('warm up the engine', () => {
  const r = tempRepo({ 'AGENTS.md': 'Run `npm run build`, see `src/a.ts` and `src/*.ts`. Node 20.\n', 'package.json': '{"scripts":{"build":"x"}}', 'src/a.ts': 'x' });
  try { best(r.dir); } finally { r.cleanup(); }
});

for (const [name, files] of Object.entries(CASES)) {
  test(`ReDoS: ${name} runs in < 250 ms on ~1 MB`, () => {
    const r = tempRepo(files);
    try {
      const { ms } = best(r.dir);
      assert.ok(ms < 250, `${name}: ${ms.toFixed(1)} ms`);
    } finally { r.cleanup(); }
  });
}

test('glob matcher: linear on pathological patterns and correct on normal ones', () => {
  const { compileGlob, globMatch } = engine._internal;
  const g = compileGlob('src/' + '*a'.repeat(60) + '*.ts');
  const t0 = Date.now();
  assert.equal(globMatch(g, 'src/' + 'a'.repeat(250)), false);
  assert.ok(Date.now() - t0 < 50);
  const ok = (glob, p) => globMatch(compileGlob(glob), p);
  assert.equal(ok('src/**/*.vue', 'src/a/b/c.vue'), true);
  assert.equal(ok('src/**/*.vue', 'src/c.vue'), true);
  assert.equal(ok('src/*.vue', 'src/a/c.vue'), false);
  assert.equal(ok('**/*.{ts,tsx}', 'a/b.tsx'), true);
  assert.equal(ok('packages/*/src', 'packages/a/src'), true);
  assert.equal(ok('file?.[jt]s', 'file1.ts'), true);
  assert.equal(ok('file?.[!jt]s', 'file1.ts'), false);
  assert.equal(compileGlob('x'.repeat(600)), null, 'too long: not checked');
  assert.equal(compileGlob('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}'), null, 'too many brace expansions: not checked');
});

test('over 200 globs in one file: the rest are not checked (no flood, bounded time)', () => {
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(`- \`src/missing${i}/*.ts\``);
  const r = tempRepo({ 'AGENTS.md': lines.join('\n') + '\n', 'src/a.ts': 'x', 'package.json': '{}' });
  try {
    const res = engine.analyzeWorkspace(r.dir, { git: false });
    assert.equal(res.diagnostics.length, 200);
  } finally { r.cleanup(); }
});

test('lines over 4,000 characters are reported as not checked', () => {
  const r = tempRepo({ 'AGENTS.md': 'ok line\n' + 'x'.repeat(5000) + ' `npm run nope`\n', 'package.json': '{"scripts":{}}' });
  try {
    const res = engine.analyzeWorkspace(r.dir, { git: false });
    assert.deepEqual(res.diagnostics, []);
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0].reason, /1 line\(s\) longer than 4000 characters/);
    assert.deepEqual(res.files, ['AGENTS.md']);
  } finally { r.cleanup(); }
});

test('CLI: a file over 1 MB is reported as skipped on stderr and not counted as checked (CDR-23)', () => {
  const cp = require('child_process');
  const path = require('path');
  const r = tempRepo({ 'AGENTS.md': 'Run `npm run nope`.\n'.repeat(80000), 'package.json': '{"scripts":{}}' });
  try {
    const out = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'context-drift.js'), '--no-git', '.'], { cwd: r.dir, encoding: 'utf8', timeout: 30000 });
    assert.match(out.stderr, /skipped AGENTS\.md: larger than 1 MB/);
    assert.match(out.stdout, /0 instruction file\(s\) checked/);
    const one = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'context-drift.js'), '--no-git', 'AGENTS.md'], { cwd: r.dir, encoding: 'utf8', timeout: 30000 });
    assert.match(one.stderr, /skipped AGENTS\.md: larger than 1 MB/);
    assert.match(one.stdout, /0 instruction file\(s\) checked/);
  } finally { r.cleanup(); }
});

test('symlinked instruction file pointing outside the workspace is not read (CDR-18)', () => {
  const fs = require('fs');
  const path = require('path');
  const outside = tempRepo({ 'secret-notes.md': 'PRIVATE: run `npm run leaked-secret-token-abc123`\n' });
  const r = tempRepo({ 'package.json': '{"scripts":{"build":"x"}}' });
  try {
    fs.symlinkSync(path.join(outside.dir, 'secret-notes.md'), path.join(r.dir, 'AGENTS.md'));
    const res = engine.analyzeWorkspace(r.dir, { git: false });
    assert.deepEqual(res.diagnostics, []);
    assert.deepEqual(res.files, []);
    assert.match(res.skipped[0].reason, /outside the workspace/);
  } finally { r.cleanup(); outside.cleanup(); }
});

// ---- round-2 review (CDR2-05): more 1 MB shapes, and the 2,000-finding cap must stop the work, not only the output
const L = LINE;
const R2_SHAPES = {
  'make-cmd-long': () => '`make ' + 'a '.repeat(L / 2 - 6) + '`',
  'link-nest': () => '[a]('.repeat(Math.floor(L / 4)),
  'version-spam': () => 'Node 18 '.repeat(Math.floor(L / 8)),
  'python-spam': () => 'Python 3.11 or '.repeat(Math.floor(L / 15)),
  'many-spans-npm': () => '`npm run q` '.repeat(Math.floor(L / 12)),
  'many-spans-paths': () => '`a/b.ts` '.repeat(Math.floor(L / 9)),
  'neg-words': () => 'not '.repeat(L / 4 - 2) + '`a/b.ts`',
  'create-words': () => 'new '.repeat(L / 4 - 2) + '`a/b.ts`',
};
for (const [name, line] of Object.entries(R2_SHAPES)) {
  test(`review r2 load shape "${name}" at ~1 MB stays well under a second`, () => {
    const r = tempRepo({ 'AGENTS.md': fill(line()), 'Makefile': 'build:\n\t@true\n', 'package.json': '{"scripts":{"build":"x"}}', '.nvmrc': '20\n', '.python-version': '3.12\n' });
    try {
      let best = Infinity;
      for (let k = 0; k < 3; k++) { const c0 = process.cpuUsage(); engine.analyzeWorkspace(r.dir, { git: false }); const c = process.cpuUsage(c0); best = Math.min(best, (c.user + c.system) / 1000); }
      assert.ok(best < 300, `${name}: ${best.toFixed(0)} ms`); // was 5,092 ms for make-cmd-long and 1,028 ms for link-nest
    } finally { r.cleanup(); }
  });
}
test('7 files of 1 MB `make a a …` finish in a few seconds (was 40 s)', () => {
  const files = { Makefile: 'build:\n\t@true\n', 'package.json': '{}' };
  const body = fill('`make ' + 'a '.repeat(L / 2 - 6) + '`');
  for (const d of ['', 'a/', 'b/', 'c/', 'd/', 'e/', 'f/']) files[d + 'AGENTS.md'] = body;
  const r = tempRepo(files);
  try {
    const t0 = Date.now();
    const res = engine.analyzeWorkspace(r.dir, { git: false });
    assert.equal(res.files.length, 7);
    assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  } finally { r.cleanup(); }
});
