'use strict';
// The round-3 independent review's cases (44 in review-r3-cases.js, 7 flip probes in review-r3-flip-cases.js),
// copied unchanged. Each case lists the findings that SHOULD be reported ("RULE:substring"); anything else is
// a false positive. Known deviations are listed in KNOWN below, each with its reason (see FIX3.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { tempRepo, engine } = require('./helpers');

const PKG = (scripts, extra) => JSON.stringify(Object.assign({ name: 'x', scripts: scripts || {} }, extra || {}), null, 2);
const CASES = [...require('./review-r3-cases.js')(PKG), ...require('./review-r3-flip-cases.js')(PKG)];
const BIN = path.join(__dirname, '..', 'bin', 'context-drift.js');

const KNOWN = {
  // `foo` and `bar` are placeholder names and are never checked (README, "Placeholders"). The negation part of
  // the case is fixed: the same sentence with real script names is tested below.
  'N11-unlike-two': [],
  // "add", "write" and "may" anywhere in a sentence still hide a path (accepted trade in the round-3 review).
  'C01-add-tests-when-change': [], 'C02-write-tests-for': [], 'C03-you-may-edit': [],
  // A target with control characters is not read as a make target (harmless false negative).
  'X04-esc-in-make-target': [],
  // Include/import cycles: no hang and no crash; the target set is treated as unknown, so nothing is reported.
  'Y01-make-include-cycle': [], 'Y02-just-import-cycle': [], 'Y03-task-include-cycle': [],
  // "scripts": null is not a scripts table; nothing is claimed about it.
  'Y06-scripts-null': [],
};

const match = (e, d) => { const i = e.indexOf(':'); return d.ruleId === e.slice(0, i) && d.message.includes(e.slice(i + 1)); };
function check(name, files, expect) {
  const r = tempRepo(files);
  try {
    const res = engine.analyzeWorkspace(r.dir, { git: false, debug: true });
    const got = JSON.stringify(res.diagnostics.map((d) => `${d.ruleId} ${d.message}`));
    const unexpected = res.diagnostics.filter((d) => !expect.some((e) => match(e, d)));
    const missing = expect.filter((e) => !res.diagnostics.some((d) => match(e, d)));
    assert.deepEqual(unexpected.map((d) => `${d.ruleId} ${d.message}`), [], `${name}: false positives; got ${got}`);
    assert.deepEqual(missing, [], `${name}: false negatives; got ${got}`);
  } finally { r.cleanup(); }
}

for (const c of CASES) {
  test(`review r3: ${c.name}`, () => check(c.name, c.files, KNOWN[c.name] || c.expect));
}

// CDR3-01 and CDR3-02 beyond the review's own cases
const P = () => ({ 'package.json': PKG({ build: 'x', lint: 'x' }), 'package-lock.json': '{}' });
const MORE = [
  ['N11 with real names', 'Unlike `npm run old`, `npm run full` runs everything.\n', ['CD001:full']],
  ['bare negation + aside', 'Do not, under any circumstances, run `npm run nuke`.\n', []],
  ['never, ever', 'Never, ever, run `npm run nuke`.\n', []],
  ['short negated verb + and', 'Never build and run `npm run start1` on CI.\n', []],
  ['negated list after comma', 'Do not use `npm run a1`, `npm run b1` or `npm run c1`.\n', []],
  ['avoid list with and', 'Avoid `npm run a1`, `npm run b1` and `npm run c1`.\n', []],
  ['skip the X step', 'Never skip the `npm run tc` step.\n', ['CD001:tc']],
  ['without first running', 'Never commit without first running `npm run lnt3`.\n', ['CD001:lnt3']],
  ['skipping by means of', 'Do not skip linting by running `npm run nolint`.\n', []],
  ['forget that', 'Never forget that `npm run gone1` is only for CI.\n', []],
];
for (const [name, text, expect] of MORE) {
  test(`negation scope: ${name}`, () => check(name, Object.assign({ 'AGENTS.md': text }, P()), expect));
}

// CDR3-03
test('CLI text output escapes a newline in a folder name, so it cannot print a forged line', { skip: process.platform === 'win32' }, () => {
  const r = tempRepo({ 'package.json': '{"name":"x","scripts":{}}', 'package-lock.json': '{}' });
  try {
    const dir = path.join(r.dir, 'a\n::error file=FORGED.md,line=1::forged\tx');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Run `npm run nope`.\n');
    const out = cp.spawnSync(process.execPath, [BIN, '--no-git', r.dir], { encoding: 'utf8', timeout: 20000 });
    assert.match(out.stdout, /CD001/);
    const lines = out.stdout.split('\n');
    assert.ok(!lines.some((l) => l.startsWith('::')), JSON.stringify(out.stdout));
    assert.ok(out.stdout.includes('a\\u000a::error file=FORGED.md,line=1::forged\\u0009x/AGENTS.md:1:'), JSON.stringify(out.stdout));
    assert.ok(!(out.stdout + out.stderr).includes('\t'), 'no raw tab');
    const gh = cp.spawnSync(process.execPath, [BIN, '--no-git', '--format', 'github', r.dir], { encoding: 'utf8', timeout: 20000 });
    assert.ok(!gh.stdout.split('\n').some((l) => l.startsWith('::error file=FORGED')), JSON.stringify(gh.stdout));
    assert.match(gh.stdout, /a%0A%3A%3Aerror file=FORGED\.md%2Cline=1%3A%3Aforged/);
  } finally { r.cleanup(); }
});
