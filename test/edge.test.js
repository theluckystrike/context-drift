'use strict';
// Robustness and heuristics. Fixture text is inline; expected values written by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { tempRepo, engine } = require('./helpers');

const PKG = JSON.stringify({ scripts: { a: 'x' } });
function check(files, opts) {
  const r = tempRepo(files);
  try { return engine.analyzeWorkspace(r.dir, Object.assign({ git: false }, opts || {})); } finally { r.cleanup(); }
}
const brief = (res) => res.diagnostics.map((d) => `${d.file} ${d.ruleId} ${d.line}:${d.column}-${d.endColumn}`);

test('CRLF line endings keep correct positions', () => {
  const res = check({ 'package.json': PKG, 'AGENTS.md': '# T\r\n- `npm run nope`\r\n' });
  assert.deepEqual(brief(res), ['AGENTS.md CD001 1:11-15']);
});

test('BOM + emoji: columns are UTF-16 code units', () => {
  const res = check({ 'package.json': PKG, 'AGENTS.md': '﻿🚀 Run `npm run nope`\n' });
  assert.deepEqual(brief(res), ['AGENTS.md CD001 0:16-20']);
});

test('binary instruction file is skipped without crashing', () => {
  const res = check({ 'package.json': PKG, '.cursorrules': Buffer.from([0, 1, 2, 0x6e, 0x70, 0x6d, 0, 0xff, 0xfe]) });
  assert.deepEqual(res.diagnostics, []);
});

test('huge instruction file (2 MB) is skipped without crashing', () => {
  const res = check({ 'package.json': PKG, 'AGENTS.md': '- `npm run nope`\n'.repeat(130000) });
  assert.deepEqual(res.diagnostics, []);
});

test('missing root directory returns an empty result', () => {
  const res = engine.analyzeWorkspace(path.join(__dirname, 'does-not-exist-' + Date.now()), { git: false });
  assert.deepEqual(res.files, []);
  assert.deepEqual(res.diagnostics, []);
});

test('invalid package.json disables script checks (no false positive)', () => {
  const res = check({ 'package.json': '{ "scripts": { "a": "x", } // broken', 'AGENTS.md': '- `npm run anything`\n' });
  assert.deepEqual(res.diagnostics, []);
});

test('unterminated code fence: lines are still treated as the fence body', () => {
  const res = check({ 'package.json': PKG, 'AGENTS.md': '```bash\nnpm run nope\n' });
  assert.deepEqual(brief(res), ['AGENTS.md CD001 1:8-12']);
});

test('console fence: only prompt lines are commands', () => {
  const res = check({ 'package.json': PKG, 'AGENTS.md': '```console\n$ npm run nope\nnpm run output-line\n```\n' });
  assert.deepEqual(brief(res), ['AGENTS.md CD001 1:10-14']);
});

test('disable-next-line and file-level disable directives', () => {
  const res = check({
    'package.json': PKG,
    'AGENTS.md': '<!-- context-drift-disable-next-line CD001 -->\n- `npm run nope`\n- `npm run nope2`\n',
    'CLAUDE.md': '<!-- context-drift-disable CD002 -->\n- `src/nothing.ts`\n',
  });
  assert.deepEqual(brief(res), ['AGENTS.md CD001 2:11-16']);
});

test('placeholders in commands are ignored', () => {
  const res = check({ 'package.json': PKG, 'AGENTS.md': '- `npm run <script>`\n- `make $(TARGET)`\n- `just {{recipe}}`\n' });
  assert.deepEqual(res.diagnostics, []);
});

test('node_modules, dist and .git are never scanned', () => {
  const res = check({
    'package.json': PKG,
    'node_modules/x/AGENTS.md': '- `npm run nope`\n',
    'dist/AGENTS.md': '- `npm run nope`\n',
    '.git/AGENTS.md': '- `npm run nope`\n',
  });
  assert.deepEqual(res.files, []);
});

test('gitignored and generated paths are not reported', () => {
  const res = check({ '.gitignore': 'generated/\n*.log\n', 'AGENTS.md': '- `generated/api.ts`\n- `logs/app.log`\n- `dist/index.js`\n' });
  assert.deepEqual(res.diagnostics, []);
});

test('paths under an "Example" heading are not reported', () => {
  const res = check({ 'AGENTS.md': '## Example\n- `src/nothing.ts`\n' });
  assert.deepEqual(res.diagnostics, []);
});

test('files the text asks to create are not reported', () => {
  const res = check({ 'src/a.ts': '', 'AGENTS.md': 'Create `src/new-file.ts` for each feature.\n' });
  assert.deepEqual(res.diagnostics, []);
});

test('moved file: suggests the unique file with the same name', () => {
  const res = check({ 'src/util.ts': '', 'AGENTS.md': '- `lib/util.ts`\n' });
  assert.equal(res.diagnostics.length, 1);
  assert.match(res.diagnostics[0].message, /Did you mean "src\/util\.ts"/);
  assert.equal(res.diagnostics[0].fix.newText, 'src/util.ts');
});

test('abbreviated path that matches a deeper file is accepted', () => {
  const res = check({ 'src/components/Button.tsx': '', 'AGENTS.md': '- `components/Button.tsx`\n' });
  assert.deepEqual(res.diagnostics, []);
});

test('owner/repo, branch names, MIME types and product names are not paths', () => {
  const res = check({ 'src/a.ts': '', 'AGENTS.md': '- `vercel/next.js`\n- `feat/login`\n- `text/html`\n- `Node.js`\n- `origin/main`\n' });
  assert.deepEqual(res.diagnostics, []);
});

test('version ranges: Node 18, 20 and 22 matrix is consistent with engines >=18', () => {
  const res = check({ 'package.json': JSON.stringify({ engines: { node: '>=18' } }), 'AGENTS.md': 'Supports Node 18, 20 and 22.\nNode 16 is fine too.\n' });
  assert.deepEqual(brief(res), ['AGENTS.md CD004 1:0-7']);
});

test('semver helpers (unit)', () => {
  const { satisfiesRange, parseVer, claimFitsRange } = engine._internal;
  assert.equal(satisfiesRange([20, 11, 0], '^20.0.0'), true);
  assert.equal(satisfiesRange([18, 0, 0], '>=18 <21'), true);
  assert.equal(satisfiesRange([21, 0, 0], '>=18 <21'), false);
  assert.equal(satisfiesRange([3, 12, 0], '~=3.11'), true);
  assert.equal(satisfiesRange([16, 1, 0], '18.x || 20.x'), false);
  assert.deepEqual(parseVer('v20.11.0'), [20, 11, 0]);
  assert.equal(claimFitsRange([3, 10], '>=3.10.4'), true);
  assert.equal(claimFitsRange([3, 9], '>=3.10'), false);
});

test('tokenizer keeps columns and splits on && and |', () => {
  const segs = engine._internal.tokenizeShell('FOO=1 npm run "a b" && make x | tee', 10);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs[0].toks.map((t) => [t.v, t.s, t.e]), [['FOO=1', 10, 15], ['npm', 16, 19], ['run', 20, 23], ['a b', 24, 29]]);
});

test('a CLAUDE.md that only imports @AGENTS.md produces nothing', () => {
  const res = check({ 'AGENTS.md': '# A\n', 'CLAUDE.md': '@AGENTS.md\n' });
  assert.deepEqual(res.diagnostics, []);
});

test('overrides: unsaved editor text is analyzed instead of disk text', () => {
  const r = tempRepo({ 'package.json': PKG, 'AGENTS.md': '- `npm run a`\n' });
  try {
    const overrides = new Map([[path.join(r.dir, 'AGENTS.md'), '- `npm run zzz`\n']]);
    const res = engine.analyzeWorkspace(r.dir, { git: false, overrides });
    assert.deepEqual(brief(res), ['AGENTS.md CD001 0:11-14']);
  } finally { r.cleanup(); }
});

test('instruction file classification', () => {
  const c = engine.classifyInstructionFile;
  assert.equal(c('AGENTS.md'), 'AGENTS.md');
  assert.equal(c('a/b/CLAUDE.local.md'), 'CLAUDE.local.md');
  assert.equal(c('.cursor/rules/x.mdc'), 'cursor-rule');
  assert.equal(c('.github/copilot-instructions.md'), 'copilot-instructions');
  assert.equal(c('.github/instructions/ts.instructions.md'), 'copilot-scoped');
  assert.equal(c('.clinerules'), '.clinerules');
  assert.equal(c('docs/README.md'), null);
  assert.equal(fs.existsSync(__filename), true);
});

/* ---- regressions for false positives found on real repos (see NOTES.md) ---- */

test('FP fix: nested git worktree / submodule directories are their own roots', () => {
  const res = check({ 'sub/.git': 'gitdir: ../.git/worktrees/sub\n', 'sub/AGENTS.md': '- `src/missing.ts`\n', 'AGENTS.md': '# root\n' });
  assert.deepEqual(res.files, ['AGENTS.md']);
});

test('FP fix: bracketed words are not globs; literal [id] routes are paths', () => {
  const res = check({ 'app/[id]/page.tsx': '', 'AGENTS.md': '- `[CRIT]`\n- `list[T]`\n- `packages[0].identifier`\n- `LGPL-*`\n- `app/[id]/page.tsx`\n' });
  assert.deepEqual(res.diagnostics, []);
});

test('FP fix: hostnames ending in a file-like TLD are not files', () => {
  const res = check({ 'AGENTS.md': 'Use the forum and `community.obsidian.md`.\n' });
  assert.deepEqual(res.diagnostics, []);
});

test('FP fix: SKILL.md checks only its bundled files, not generic commands or project paths', () => {
  const res = check({
    'package-lock.json': '{}', 'package.json': PKG,
    '.claude/skills/x/SKILL.md': '- `pnpm install`\n- `src/app.ts`\n- See `references/api.md`\n- Node 12\n',
    '.claude/skills/x/references/other.md': 'x', // the skill ships a references/ folder, so its bundle paths are checked
  });
  assert.deepEqual(brief(res), ['.claude/skills/x/SKILL.md CD002 2:7-24']);
});

test('FP fix: cd into a directory created earlier in the same code block', () => {
  const res = check({ 'AGENTS.md': '```bash\nnpx create-next-app web-app\ncd web-app\n```\n' });
  assert.deepEqual(res.diagnostics, []);
});

test('FP fix: path next to an external URL belongs to that other repo', () => {
  const res = check({ 'AGENTS.md': '- [Toolkit](https://github.com/x/y) (`examples/demo/`)\n' });
  assert.deepEqual(res.diagnostics, []);
});

test('FP fix: build outputs and gitignored bare names', () => {
  const res = check({ 'sub/.gitignore': 'out.bin\n', 'AGENTS.md': 'Check each host in `main.js` and `out.bin`.\n' });
  assert.deepEqual(res.diagnostics, []);
});

test('FP fix: links without extension under a missing top folder (wiki links) are skipped', () => {
  const res = check({ 'AGENTS.md': '- [Runbook](internal-wiki/deployment-runbook)\n- [Gone](docs/gone.md)\n' });
  assert.deepEqual(brief(res), ['AGENTS.md CD002 1:9-21']);
});
