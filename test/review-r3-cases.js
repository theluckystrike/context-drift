// The round-3 independent review's cases, copied unchanged from gate/out-context-drift-r3/scratch/r3cases-def.js.
module.exports = (PKG) => {
const NPM = { 'package-lock.json': '{}' };
const P = (s) => Object.assign({ 'package.json': PKG(s || { build: 'x', lint: 'x' }) }, NPM);
const MK = 'build:\n\t@true\n';
return [
// ---- clause-scoped negation (CDR2-01 follow-up) ----
{ name: 'N01-dont-comma-after', files: { 'AGENTS.md': "Don't run `npm run eject`, it is irreversible.\n", ...P() }, expect: [] },
{ name: 'N02-instead-of-use', files: { 'AGENTS.md': 'Instead of `npm run old`, use `npm run neww`.\n', ...P() }, expect: ['CD001:neww'] },
{ name: 'N03-never-edit-comma-run', files: { 'AGENTS.md': 'Never edit generated files, run `npm run codegen` instead.\n', ...P() }, expect: ['CD001:codegen'] },
{ name: 'N04-do-not-skip', files: { 'AGENTS.md': 'Do not skip `npm run typecheck`.\n', ...P() }, expect: ['CD001:typecheck'] },
{ name: 'N05-dont-without-after', files: { 'AGENTS.md': "Don't run `npm run deploy` without approval.\n", ...P() }, expect: [] },
{ name: 'N06-unless-after', files: { 'AGENTS.md': "Don't run `npm run legacy` unless you know why.\n", ...P() }, expect: [] },
{ name: 'N07-but-pivot', files: { 'AGENTS.md': 'Do not commit yet, but run `npm run lnt` first.\n', ...P() }, expect: ['CD001:lnt'] },
{ name: 'N08-no-need', files: { 'AGENTS.md': "There's no need to run `npm run setup` anymore.\n", ...P() }, expect: [] },
{ name: 'N09-list-prev-item-neg', files: { 'AGENTS.md': '- No Docker\n- Run `npm run up`\n', ...P() }, expect: ['CD001:up'] },
{ name: 'N10-not-alternative', files: { 'AGENTS.md': 'Use `npm run build` (not `npm run compile`).\n', ...P() }, expect: [] },
{ name: 'N11-unlike-two', files: { 'AGENTS.md': 'Unlike `npm run foo`, `npm run bar` runs everything.\n', ...P() }, expect: ['CD001:bar'] },
{ name: 'N12-and-run', files: { 'AGENTS.md': 'Do not push to main and run `npm run lnt` before merging.\n', ...P() }, expect: ['CD001:lnt'] },
{ name: 'N13-never-forget-but-real-neg', files: { 'AGENTS.md': 'Never forget that `npm run old-build` was removed.\n', ...P() }, expect: [] },
{ name: 'N14-dont-ignore-flip-neg-after', files: { 'AGENTS.md': "Don't skip CI; never use `npm run yolo`.\n", ...P() }, expect: [] },
{ name: 'N15-without-plain-neg', files: { 'AGENTS.md': 'Works without `npm run prepare` now.\n', ...P() }, expect: [] },
{ name: 'N16-skip-flip-false', files: { 'AGENTS.md': 'Do not skip tests by calling `npm run skip-tests`.\n', ...P() }, expect: [] },
{ name: 'N17-after-subject-removed', files: { 'AGENTS.md': 'Run `npm run bild`; the old `make all` target is gone.\n', ...P(), 'Makefile': MK }, expect: ['CD001:bild'] },
{ name: 'N18-no-colon-list', files: { 'AGENTS.md': 'Do not: run `npm run danger`.\n', ...P() }, expect: [] },
// ---- create-word window (CDR2-02 follow-up) ----
{ name: 'C01-add-tests-when-change', files: { 'AGENTS.md': 'Add tests when you change `src/core.ts`.\n', ...P(), 'src/index.ts': 'x' }, expect: ['CD002:src/core.ts'] },
{ name: 'C02-write-tests-for', files: { 'AGENTS.md': 'Write tests for every change in `src/parser.ts`.\n', ...P(), 'src/index.ts': 'x' }, expect: ['CD002:src/parser.ts'] },
{ name: 'C03-you-may-edit', files: { 'AGENTS.md': 'You may edit `src/config.ts` freely.\n', ...P(), 'src/index.ts': 'x' }, expect: ['CD002:src/config.ts'] },
{ name: 'C04-add-test-file', files: { 'AGENTS.md': 'Add a test in `test/new-thing.test.js`.\n', ...P(), 'src/index.ts': 'x' }, expect: [] },
{ name: 'C05-new-far', files: { 'AGENTS.md': 'For new code, the router lives in `src/router.ts`.\n', ...P(), 'src/index.ts': 'x' }, expect: ['CD002:src/router.ts'] },
{ name: 'C06-output-near', files: { 'AGENTS.md': 'Build output goes into `out2/bundle.js`.\n', ...P(), 'src/index.ts': 'x' }, expect: [] },
// ---- ../ paths (CDR2-03) ----
{ name: 'P01-sub-dotdot-inside-missing', files: { 'packages/web/AGENTS.md': 'Shared types: `../api/src/types.ts`.\n', ...P(), 'packages/api/src/index.ts': 'x', 'packages/web/package.json': PKG({ build: 'x' }) }, expect: ['CD002:types.ts'] },
{ name: 'P02-sub-dotdot-inside-exists', files: { 'packages/web/AGENTS.md': 'Shared types: `../api/src/index.ts`.\n', ...P(), 'packages/api/src/index.ts': 'x', 'packages/web/package.json': PKG({ build: 'x' }) }, expect: [] },
{ name: 'P03-mid-dotdot-escape', files: { 'AGENTS.md': 'See `src/../../etc/passwd` and [h](src/../../../etc/hosts).\n', ...P() }, expect: [] },
{ name: 'P04-mid-dotdot-inside', files: { 'AGENTS.md': 'See `src/../lib/missing.ts`.\n', ...P(), 'lib/x.ts': 'x' }, expect: ['CD002:missing.ts'] },
{ name: 'P05-backslash-escape', files: { 'AGENTS.md': 'Run `..\\..\\scripts\\x.ps1` and `.\\..\\..\\a\\b.ps1`.\n', ...P() }, expect: [] },
{ name: 'P06-pct-encoded-escape', files: { 'AGENTS.md': 'See [x](%2e%2e/%2e%2e/etc/passwd) and [y](..%2F..%2Fetc%2Fhosts).\n', ...P() }, expect: [] },
{ name: 'P07-cd-dotdot', files: { 'AGENTS.md': 'Run `cd ../other && npm run nope`.\n', ...P() }, expect: [] },
{ name: 'P08-cd-inside-then-make', files: { 'AGENTS.md': 'Run `cd tools && make gen`.\n', ...P(), 'tools/Makefile': MK }, expect: ['CD001:gen'] },
// ---- escaping (CDR2-04) ----
{ name: 'X01-esc-in-link', files: { 'AGENTS.md': 'See [x](src/\u001b[2Jboom.ts).\n', ...P(), 'src/i.ts': 'x' }, expect: ['CD002:\\u001b'] },
{ name: 'X02-c1-csi-script', files: { 'AGENTS.md': 'Run `npm run a\u009b2Jb`.\n', ...P() }, expect: ['CD001:\\u009b'] },
{ name: 'X03-esc-in-suggestion', files: { 'AGENTS.md': 'Run `npm run bulid`.\n', ...P({ 'buil\u001b]0;x\u0007d': 'x' }) }, expect: ['CD001:bulid'] },
{ name: 'X04-esc-in-make-target', files: { 'AGENTS.md': 'Run `make dep\u001b[31mloy`.\n', ...P(), 'Makefile': MK }, expect: ['CD001:\\u001b'] },
// ---- cycles / structure ----
{ name: 'Y01-make-include-cycle', files: { 'AGENTS.md': 'Run `make deploy`.\n', ...P(), 'Makefile': 'include a.mk\nbuild:\n\t@true\n', 'a.mk': 'include Makefile\nfoo:\n\t@true\n' }, expect: ['CD001:deploy'] },
{ name: 'Y02-just-import-cycle', files: { 'AGENTS.md': 'Run `just deploy`.\n', 'justfile': "import 'b.just'\nbuild:\n    echo\n", 'b.just': "import 'justfile'\nx:\n    echo\n" }, expect: ['CD001:deploy'] },
{ name: 'Y03-task-include-cycle', files: { 'AGENTS.md': 'Run `task deploy`.\n', 'Taskfile.yml': 'version: "3"\nincludes:\n  me: ./Taskfile.yml\ntasks:\n  build:\n    cmds: [echo]\n' }, expect: ['CD001:deploy'] },
{ name: 'Y04-workspace-glob-star', files: { 'AGENTS.md': 'Run `npm run dev --workspaces`.\n', 'package.json': PKG({}, { workspaces: ['**'] }), ...NPM, 'a/package.json': PKG({ dev: 'x' }) }, expect: [] },
{ name: 'Y05-pkg-json-array', files: { 'AGENTS.md': 'Run `npm run x`.\n', 'package.json': '[1,2,3]', ...NPM }, expect: [] },
{ name: 'Y06-scripts-null', files: { 'AGENTS.md': 'Run `npm run x`.\n', 'package.json': '{"scripts":null}', ...NPM }, expect: ['CD001:'] },
{ name: 'Y07-nvmrc-garbage', files: { 'AGENTS.md': 'Requires Node 18.\n', 'package.json': PKG(), '.nvmrc': '\u001b[2J;rm -rf /\n' }, expect: [] },
{ name: 'Y08-version-claim-esc', files: { 'AGENTS.md': 'Requires Node 18.\n', 'package.json': PKG({}, { engines: { node: '>=20 \u001b[2J' } }) }, expect: ['CD004:\\u001b'] },
];
};
