'use strict';
// CD007 (import drift), CD008 (Codex size limit) and the instruction files added in 0.2.0.
// Expected values were written by hand from the temp repos below. Positions are 0-based.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempRepo, tuples, engine } = require('./helpers');

function analyze(files, opts) {
  const r = tempRepo(files);
  try {
    return engine.analyzeWorkspace(r.dir, Object.assign({ git: false }, opts || {}));
  } finally {
    r.cleanup();
  }
}

const CLAUDE = [
  '# Project', //                                                                  0
  '', //                                                                           1
  'See @README.md for the overview and @docs/git-instructions.md.', //             2
  'Style: @docs/stlye.md, team @alice, pkg @types/node, mail a@b.md.', //          3
  '- Personal: @~/.claude/me.md and @/etc/team.md', //                             4
  '- Code: `@docs/missing.md`', //                                                 5
  '', //                                                                           6
  '```', //                                                                        7
  '@docs/in-fence.md', //                                                          8
  '```', //                                                                        9
  'Also @./AGENTS.md and @../outside.md and @notes/todo.md', //                    10
  '@docs/gone.md', //                                                              11
  '<!-- @docs/commented.md -->', //                                                12
  'Rules: @docs/rules/*.md and @{{file}}.md and @https://x.y/a.md', //             13
].join('\n') + '\n';

const BASE = {
  'README.md': '# hi\n',
  'docs/style.md': 'x\n',
  'docs/git-instructions.md': 'y\n',
  '.gitignore': 'notes/\n',
  'package.json': '{"scripts":{"test":"node t.js"}}',
};

test('CD007: missing @imports in CLAUDE.md are reported with a range, a hint and a fix', () => {
  const r = analyze(Object.assign({}, BASE, { 'CLAUDE.md': CLAUDE }));
  const cd7 = r.diagnostics.filter((d) => d.file === 'CLAUDE.md' && d.ruleId === 'CD007');
  assert.deepEqual(cd7.map((d) => `${d.line}:${d.column}-${d.endColumn}`), ['3:8-21', '10:6-17', '11:1-13']);
  const [typo, rel, gone] = cd7;
  assert.equal(typo.severity, 'warning');
  assert.match(typo.message, /Import "@docs\/stlye\.md" points to "docs\/stlye\.md", which does not exist\. Claude Code skips a missing import/);
  assert.match(typo.message, /Did you mean "@docs\/style\.md"\?/);
  assert.equal(typo.fix.newText, 'docs/style.md');
  assert.deepEqual([typo.fix.column, typo.fix.endColumn], [8, 21]);
  assert.match(rel.message, /"@\.\/AGENTS\.md" points to "AGENTS\.md"/);
  assert.equal(rel.fix, undefined);
  assert.equal(gone.data.resolved, 'docs/gone.md');
});

test('CD007: not reported for handles, scoped packages, emails, home and absolute paths, code, comments, globs, URLs, gitignored files', () => {
  const r = analyze(Object.assign({}, BASE, { 'CLAUDE.md': CLAUDE }));
  const lines = r.diagnostics.filter((d) => d.ruleId === 'CD007').map((d) => d.line);
  for (const l of [2, 4, 5, 8, 12, 13]) assert.equal(lines.includes(l), false, `line ${l}`);
  // only the 3 above on lines 3, 10 and 11; "@notes/todo.md" is gitignored and "@../outside.md" leaves the repo
  assert.equal(lines.length, 3);
});

test('CD007: an existing @AGENTS.md import is fine; paths resolve from the importing file', () => {
  const r = analyze({
    'AGENTS.md': '# Agents\n',
    'CLAUDE.md': '@AGENTS.md\n',
    'pkg/CLAUDE.md': '@../AGENTS.md\n@guide.md\n@../pkg/guide.md\n',
    'pkg/guide.md': 'g\n',
  });
  assert.deepEqual(r.diagnostics.filter((d) => d.ruleId === 'CD007'), []);
});

test('CD007: a renamed import target gets the one file with that name as the fix', () => {
  const r = analyze({ 'docs/agents/testing.md': 't\n', 'CLAUDE.md': 'Testing: @docs/testing.md\n' });
  const [d] = r.diagnostics.filter((x) => x.ruleId === 'CD007');
  assert.equal(d.fix.newText, 'docs/agents/testing.md');
});

test('CD007: GEMINI.md imports name Gemini CLI; AGENTS.md "@" text is not an import', () => {
  const r = analyze({ 'GEMINI.md': 'Use @docs/old.md\n', 'AGENTS.md': 'Use @docs/old.md\n' });
  const d = r.diagnostics.filter((x) => x.ruleId === 'CD007');
  assert.equal(d.length, 1);
  assert.equal(d[0].file, 'GEMINI.md');
  assert.match(d[0].message, /Gemini CLI skips/);
});

test('CD007: a disable directive and ignoreRules both silence it', () => {
  const files = { 'CLAUDE.md': '<!-- context-drift-disable-next-line CD007 -->\n@docs/a.md\n@docs/b.md\n' };
  const r = analyze(files);
  assert.deepEqual(r.diagnostics.filter((d) => d.ruleId === 'CD007').map((d) => d.line), [2]);
  const r2 = analyze(files, { ignoreRules: ['CD007'] });
  assert.equal(r2.diagnostics.filter((d) => d.ruleId === 'CD007').length, 0);
});

test('importTarget: what counts as an import path', () => {
  const t = engine._internal.importTarget;
  assert.equal(t('docs/a.md').path, 'docs/a.md');
  assert.equal(t('docs/a.md.').shown, 'docs/a.md');
  assert.equal(t('docs/my\\ notes.md').path, 'docs/my notes.md');
  assert.equal(t('./Makefile').path, './Makefile');
  for (const x of ['alice', 'types/node', 'vue/cli-service', 'Component', '~/x.md', '/etc/x.md', 'C:/x.md', 'https://a.b/c.md', 'a@b.md', 'x/*.md', '{{f}}.md', 'v1.2', 'user.name']) {
    assert.equal(t(x), null, x);
  }
});

function bigAgents(n) {
  const lines = ['# Agents', ''];
  for (let i = 0; i < n; i++) lines.push(`- Rule ${i}: run \`npm test\` before you push, and keep the change small and focused.`);
  return lines.join('\n') + '\n';
}

test('CD008: an AGENTS.md over 32 KiB is reported at the line where Codex stops', () => {
  const text = bigAgents(500);
  const r = analyze({ 'AGENTS.md': text, 'package.json': '{"scripts":{"test":"x"}}' });
  const [d] = r.diagnostics.filter((x) => x.ruleId === 'CD008');
  assert.ok(d, 'reported');
  // the reported line is the first one that does not fit in 32,768 bytes
  const lines = text.split('\n');
  const before = lines.slice(0, d.line).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  assert.ok(before <= 32768 && before + Buffer.byteLength(lines[d.line]) + 1 > 32768);
  assert.equal(d.severity, 'warning');
  assert.match(d.message, /This file is 40\.4 KiB\. Codex loads at most 32 KiB/);
  assert.equal(d.data.bytes, Buffer.byteLength(text));
});

test('CD008: not reported at 32 KiB or less, for CLAUDE.md, or when ignored; AGENTS.override.md counts', () => {
  const small = bigAgents(380);
  assert.ok(Buffer.byteLength(small) <= 32768);
  assert.equal(analyze({ 'AGENTS.md': small }).diagnostics.filter((d) => d.ruleId === 'CD008').length, 0);
  assert.equal(analyze({ 'CLAUDE.md': bigAgents(500) }).diagnostics.filter((d) => d.ruleId === 'CD008').length, 0);
  assert.equal(analyze({ 'AGENTS.md': bigAgents(500) }, { ignoreRules: ['CD008'] }).diagnostics.filter((d) => d.ruleId === 'CD008').length, 0);
  assert.equal(analyze({ 'AGENTS.override.md': bigAgents(500) }).diagnostics.filter((d) => d.ruleId === 'CD008').length, 1);
});

test('new instruction files: AGENTS.override.md, AGENTS.local.md, AGENT.md, .claude/rules, .devin/rules, .kiro/steering', () => {
  const k = engine.classifyInstructionFile;
  assert.equal(k('AGENTS.override.md'), 'AGENTS.override.md');
  assert.equal(k('sub/AGENTS.local.md'), 'AGENTS.local.md');
  assert.equal(k('AGENT.md'), 'AGENT.md');
  assert.equal(k('.claude/rules/testing.md'), 'claude-rule');
  assert.equal(k('pkg/.claude/rules/api/style.md'), 'claude-rule');
  assert.equal(k('.devin/rules/style.md'), 'devin-rule');
  assert.equal(k('.kiro/steering/tech.md'), 'kiro-steering');
  assert.equal(k('.claude/agents/reviewer.md'), null);
  assert.equal(k('.kiro/specs/x.md'), null);
  const r = analyze({
    'package.json': '{"scripts":{"build":"x"}}',
    'AGENTS.override.md': 'Run `npm run buidl`.\n',
    '.claude/rules/testing.md': 'Run `npm run tset`.\n',
    '.kiro/steering/tech.md': 'Entry: `src/missing/main.ts`\n',
    '.devin/rules/style.md': 'Run `npm run lnt`.\n',
  });
  assert.deepEqual(tuples(r, 'AGENTS.override.md'), ['CD001 error 0:13-18']);
  assert.deepEqual(tuples(r, '.claude/rules/testing.md'), ['CD001 error 0:13-17']);
  assert.deepEqual(tuples(r, '.devin/rules/style.md'), ['CD001 error 0:13-16']);
  assert.deepEqual(r.diagnostics.filter((d) => d.file === '.kiro/steering/tech.md').map((d) => d.ruleId), ['CD002']);
});
