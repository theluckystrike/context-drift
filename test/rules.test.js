'use strict';
// Expected values below were written by hand from the fixture files in test/fixtures/.
// Positions are 0-based (line, column, endColumn).
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, tuples, at } = require('./helpers');

const npm = run('npm-basic');
const mono = run('pnpm-monorepo');
const mk = run('make-just');
const py = run('python');
const gc = run('go-cargo');
const cf = run('conflict');

/* ---------------- CD001 command drift ---------------- */

test('CD001 TP: npm run with a typo is an error with a suggestion and fix', () => {
  const [d] = at(npm, 'AGENTS.md', 3, 'CD001');
  assert.equal(d.severity, 'error');
  assert.deepEqual([d.column, d.endColumn], [11, 16]);
  assert.match(d.message, /"buidl".*Did you mean "build"/);
  assert.equal(d.fix.newText, 'build');
});

test('CD001 TP: npm run of an unknown script', () => {
  const [d] = at(npm, 'AGENTS.md', 4, 'CD001');
  assert.deepEqual([d.severity, d.column, d.endColumn], ['error', 11, 17]);
  assert.match(d.message, /"deploy"/);
});

test('CD001 TN: npm run build / npm test / npm install exist or are built-ins', () => {
  assert.equal(at(npm, 'AGENTS.md', 2).length, 0);
  assert.equal(at(npm, 'AGENTS.md', 5).length, 0);
  assert.equal(at(npm, 'AGENTS.md', 7).length, 0);
});

test('CD001 edge: npm start without a start script and without server.js', () => {
  const [d] = at(npm, 'AGENTS.md', 6, 'CD001');
  assert.deepEqual([d.severity, d.column, d.endColumn], ['error', 7, 12]);
  assert.equal(d.fix, undefined);
});

test('CD001 edge: negated mention ("Don\'t run `npm run eject`") is ignored', () => {
  assert.equal(at(npm, 'AGENTS.md', 11).length, 0);
});

test('CD001 TP: command inside a bash fence; json fence is ignored', () => {
  assert.equal(at(npm, 'AGENTS.md', 23).length, 0, 'npm run lint exists');
  const [d] = at(npm, 'AGENTS.md', 24, 'CD001');
  assert.deepEqual([d.column, d.endColumn], [8, 19]);
  assert.equal(at(npm, 'AGENTS.md', 28).length, 0, 'json code block is not a command');
});

test('CD001 TN: pnpm nearest package.json script, root script, and dependency binaries', () => {
  const f = 'packages/web/AGENTS.md';
  assert.equal(at(mono, f, 1).length, 0); // pnpm dev (packages/web)
  assert.equal(at(mono, f, 2).length, 0); // pnpm build (root)
  assert.equal(at(mono, f, 3).length, 0); // pnpm vite (devDependency bin)
  assert.equal(at(mono, f, 8).length, 0); // pnpm docgen (@acme/docgen)
});

test('CD001 TP: bare `pnpm docs:gen` is a warning (heuristic form)', () => {
  const [d] = at(mono, 'packages/web/AGENTS.md', 4, 'CD001');
  assert.deepEqual([d.severity, d.column, d.endColumn], ['warning', 8, 16]);
});

test('CD001 edge: --filter searches all workspace packages', () => {
  assert.equal(at(mono, 'packages/web/AGENTS.md', 6).length, 0);
});

test('CD001 TP: `pnpm -r run e2e` missing in every package is an error', () => {
  const [d] = at(mono, 'packages/web/AGENTS.md', 7, 'CD001');
  assert.deepEqual([d.severity, d.column, d.endColumn], ['error', 15, 18]);
});

test('CD001 edge: script defined only in a workspace package is not reported from the root', () => {
  assert.equal(at(mono, 'AGENTS.md', 1).length, 0);
});

test('CD001 edge: `cd packages/web && pnpm dev` resolves the cd directory', () => {
  assert.equal(at(mono, 'AGENTS.md', 2).length, 0);
});

test('CD001 TN: make targets, included makefiles, -C dir and VAR=value args', () => {
  for (const line of [1, 2, 4, 5]) assert.equal(at(mk, 'AGENTS.md', line).length, 0, `line ${line}`);
});

test('CD001 TP: make target missing from Makefile', () => {
  const [d] = at(mk, 'AGENTS.md', 3, 'CD001');
  assert.deepEqual([d.severity, d.column, d.endColumn], ['error', 8, 14]);
});

test('CD001 TP: make typo gets a suggestion fix', () => {
  const [d] = at(mk, 'AGENTS.md', 11, 'CD001');
  assert.deepEqual([d.column, d.endColumn, d.fix.newText], [8, 11, 'lint']);
});

test('CD001 TN: just recipe with default parameter and alias', () => {
  assert.equal(at(mk, 'AGENTS.md', 6).length, 0);
  assert.equal(at(mk, 'AGENTS.md', 7).length, 0);
});

test('CD001 TP: just recipe missing', () => {
  const [d] = at(mk, 'AGENTS.md', 8, 'CD001');
  assert.deepEqual([d.column, d.endColumn], [8, 12]);
});

test('CD001 TP/TN: Taskfile tasks', () => {
  assert.equal(at(mk, 'AGENTS.md', 9).length, 0);
  const [d] = at(mk, 'AGENTS.md', 10, 'CD001');
  assert.deepEqual([d.column, d.endColumn], [8, 15]);
});

test('CD001 TN: uv run of [project.scripts], dependency group bins and python -m', () => {
  for (const line of [1, 2, 4, 9]) assert.equal(at(py, 'CLAUDE.md', line).length, 0, `line ${line}`);
});

test('CD001 TP: uv run of an unknown script is a warning', () => {
  const [d] = at(py, 'CLAUDE.md', 3, 'CD001');
  assert.deepEqual([d.severity, d.column, d.endColumn], ['warning', 10, 20]);
});

test('CD001 TP/TN: cargo -p crate names', () => {
  assert.equal(at(gc, 'AGENTS.md', 3).length, 0);
  const [d] = at(gc, 'AGENTS.md', 4, 'CD001');
  assert.deepEqual([d.severity, d.column, d.endColumn], ['error', 17, 21]);
  assert.match(d.message, /Did you mean "cli"/);
});

test('CD001: cargo alias exists; unknown subcommand warns when the repo defines aliases', () => {
  assert.equal(at(gc, 'AGENTS.md', 5).length, 0);
  assert.equal(at(gc, 'AGENTS.md', 7).length, 0, 'cargo nextest is a known plugin');
  const [d] = at(gc, 'AGENTS.md', 6, 'CD001');
  assert.deepEqual([d.severity, d.column, d.endColumn], ['warning', 9, 14]);
});

test('CD001: cargo --bin target names', () => {
  assert.equal(at(gc, 'AGENTS.md', 8).length, 0);
  const [d] = at(gc, 'AGENTS.md', 9, 'CD001');
  assert.deepEqual([d.column, d.endColumn], [19, 24]);
});

/* ---------------- CD002 path drift ---------------- */

test('CD002 TN: existing path in code and in a markdown link', () => {
  assert.equal(at(npm, 'AGENTS.md', 12).length, 0);
  assert.equal(at(npm, 'AGENTS.md', 16).length, 0);
});

test('CD002 TP: missing file in inline code', () => {
  const [d] = at(npm, 'AGENTS.md', 13, 'CD002');
  assert.deepEqual([d.severity, d.column, d.endColumn], ['warning', 3, 17]);
  assert.equal(d.data.parent, 'src');
});

test('CD002 TP: missing directory with trailing slash', () => {
  const [d] = at(npm, 'AGENTS.md', 14, 'CD002');
  assert.deepEqual([d.column, d.endColumn], [3, 8]);
  assert.match(d.message, /^Directory/);
});

test('CD002 TP: missing markdown link target', () => {
  const [d] = at(npm, 'AGENTS.md', 15, 'CD002');
  assert.deepEqual([d.column, d.endColumn], [10, 25]);
});

test('CD002 edge: URLs and <placeholders> are ignored', () => {
  assert.equal(at(npm, 'AGENTS.md', 17).length, 0);
  assert.equal(at(npm, 'AGENTS.md', 18).length, 0);
});

test('CD002 edge: glob that matches nothing is info; matching glob is silent', () => {
  const [d] = at(npm, 'AGENTS.md', 19, 'CD002');
  assert.deepEqual([d.severity, d.column, d.endColumn], ['info', 3, 19]);
  assert.equal(at(npm, 'AGENTS.md', 20).length, 0);
});

test('CD002 TP: Cursor .mdc frontmatter glob that matches nothing', () => {
  assert.deepEqual(tuples(npm, '.cursor/rules/vue.mdc'), ['CD002 info 2:7-19']);
});

test('CD002 TP: cd into a directory that does not exist', () => {
  const [d] = at(mono, 'AGENTS.md', 3, 'CD002');
  assert.deepEqual([d.column, d.endColumn], [6, 18]);
});

/* ---------------- CD003 package manager drift ---------------- */

test('CD003 TP: pnpm used in an npm (package-lock.json) repo', () => {
  const [d] = at(npm, 'AGENTS.md', 8, 'CD003');
  assert.deepEqual([d.severity, d.column, d.endColumn], ['warning', 3, 7]);
  assert.match(d.message, /package-lock\.json/);
  assert.equal(d.fix.newText, 'npm');
});

test('CD003 TP: npm in a pnpm workspace (packageManager field) with fix', () => {
  const [d] = at(mono, 'packages/web/AGENTS.md', 5, 'CD003');
  assert.deepEqual([d.column, d.endColumn, d.fix.newText], [3, 6, 'pnpm']);
});

test('CD003 TN: "Use pnpm, not npm." in a pnpm repo', () => {
  assert.equal(at(mono, 'AGENTS.md', 4).length, 0);
});

test('CD003 TP: prose "We use yarn" in a pnpm repo', () => {
  const [d] = at(mono, 'AGENTS.md', 5, 'CD003');
  assert.deepEqual([d.column, d.endColumn], [9, 13]);
});

/* ---------------- CD004 version drift ---------------- */

test('CD004 TP: Node 18 vs .nvmrc 20.11.0', () => {
  const [d] = at(npm, 'AGENTS.md', 9, 'CD004');
  assert.deepEqual([d.severity, d.column, d.endColumn], ['warning', 11, 18]);
  assert.match(d.message, /\.nvmrc says 20\.11\.0/);
});

test('CD004 TN: "Node 20+" is satisfied by .nvmrc 20.11.0', () => {
  assert.equal(at(npm, 'AGENTS.md', 10).length, 0);
});

test('CD004 TP: Python 3.10 vs .python-version and requires-python', () => {
  const [d] = at(py, 'CLAUDE.md', 5, 'CD004');
  assert.deepEqual([d.column, d.endColumn], [23, 34]);
  assert.match(d.message, /\.python-version says 3\.12\.1/);
  assert.match(d.message, /requires-python says >=3\.11/);
});

test('CD004 TN: Python 3.12 and Python 3.11+ match; "dropped Python 3.9" is history', () => {
  assert.equal(at(py, 'CLAUDE.md', 6).length, 0);
  assert.equal(at(py, 'CLAUDE.md', 7).length, 0);
  assert.equal(at(py, 'CLAUDE.md', 8).length, 0);
});

test('CD004 TP/TN: Go 1.21 vs go.mod 1.22; "Go 1.22 or later" ok', () => {
  const [d] = at(gc, 'AGENTS.md', 1, 'CD004');
  assert.deepEqual([d.column, d.endColumn], [13, 20]);
  assert.equal(at(gc, 'AGENTS.md', 2).length, 0);
});

/* ---------------- CD005 cross-file conflict ---------------- */

test('CD005 TP: AGENTS.md says make test, CLAUDE.md says npm test', () => {
  assert.deepEqual(tuples(cf, 'AGENTS.md'), ['CD005 info 1:9-18']);
  assert.deepEqual(tuples(cf, 'CLAUDE.md'), ['CD005 info 1:9-17']);
  const [d] = at(cf, 'AGENTS.md', 1, 'CD005');
  assert.equal(d.related[0].file, 'CLAUDE.md');
});

test('CD005 TP: copilot-instructions.md is in the root scope', () => {
  assert.deepEqual(tuples(cf, '.github/copilot-instructions.md'), ['CD005 info 0:5-14']);
});

test('CD005 TN: same lint command everywhere; nested AGENTS.md is a different scope', () => {
  assert.equal(at(cf, 'AGENTS.md', 2).length, 0);
  assert.equal(at(cf, 'CLAUDE.md', 2).length, 0);
  assert.deepEqual(tuples(cf, 'sub/AGENTS.md'), []);
});

/* ---------------- totals (no unexpected diagnostics) ---------------- */

test('fixture totals: no extra diagnostics anywhere', () => {
  assert.equal(npm.diagnostics.length, 11);
  assert.equal(mono.diagnostics.length, 5);
  assert.equal(mk.diagnostics.length, 4);
  assert.equal(py.diagnostics.length, 2);
  assert.equal(gc.diagnostics.length, 4);
  assert.equal(cf.diagnostics.length, 3);
});

test('ignoreRules removes a rule', () => {
  const r = run('npm-basic', { ignoreRules: ['CD001', 'cd002'] });
  assert.ok(r.diagnostics.every((d) => d.ruleId !== 'CD001' && d.ruleId !== 'CD002'));
  assert.equal(r.diagnostics.length, 2);
});

test('README before/after example is exactly what the engine reports', () => {
  const r = run('readme-example');
  assert.deepEqual(tuples(r, 'AGENTS.md'), [
    'CD004 warning 0:11-18',
    'CD003 warning 1:16-20',
    'CD001 error 2:18-23',
    'CD001 error 2:40-46',
    'CD002 warning 3:16-34',
  ]);
});
