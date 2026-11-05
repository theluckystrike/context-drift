'use strict';
// Regression tests for the false-positive classes found in the 0.1.0 review (CDR-05..CDR-17, CDR-21)
// and in the corpus sweep. Each case: files of a tiny repo, and the findings that SHOULD be reported
// ("RULE:substring"). Anything else is a false positive.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempRepo, engine } = require('./helpers');

const PKG = (scripts, extra) => JSON.stringify(Object.assign({ name: 'x', scripts: scripts || {} }, extra || {}));

const CASES = [
  // CDR-11 Windows paths
  ['backslash relative path', { 'AGENTS.md': 'Run `.\\scripts\\build.ps1` and open `src\\index.ts`.\n', 'scripts/build.ps1': 'x', 'src/index.ts': 'x', 'package.json': PKG() }, []],
  ['backslash path that is missing is still reported', { 'AGENTS.md': 'Open `src\\gone.ts`.\n', 'src/index.ts': 'x', 'package.json': PKG() }, ['CD002:src/gone.ts']],
  // CDR-09 fences
  ['bash block with prompts: output lines are not commands', { 'AGENTS.md': '```bash\n$ make help\nmake test    Run the tests\n```\n', Makefile: 'help:\n\t@true\n', 'package.json': PKG() }, []],
  ['listing "make dev - start dev server"', { 'AGENTS.md': '```\nmake dev - start dev server\nmake test    run tests\n```\n', Makefile: 'dev:\n\t@true\ntest:\n\t@true\n', 'package.json': PKG() }, []],
  ['console ">" lines are npm output', { 'AGENTS.md': '```console\n$ npm run build\n> npm run nope-from-output\n```\n', 'package.json': PKG({ build: 'x' }) }, []],
  // CDR-15 CD005 per directory
  ['CD005: different sub-projects do not conflict', { 'AGENTS.md': 'Test the web app with `npm test`.\n', 'CLAUDE.md': 'Test the API with `cd api && pytest`.\n', 'package.json': PKG({ test: 'x' }), 'api/pyproject.toml': '[project]\nname="api"\n' }, []],
  // CDR-14 bins
  ['yarn bin from a scoped package', { 'AGENTS.md': 'Serve with `yarn vue-cli-service serve`.\n', 'package.json': PKG({}, { devDependencies: { '@vue/cli-service': '5' } }), 'yarn.lock': '' }, []],
  ['uv run pip-compile from pip-tools', { 'AGENTS.md': 'Lock with `uv run pip-compile requirements.in`.\n', 'pyproject.toml': '[project]\nname = "app"\ndependencies = ["pip-tools>=7"]\n' }, []],
  // CDR-05 negation
  ['negation on the previous line of a list item', { 'AGENTS.md': '- Do not import other packages via relative\n  `../../other-package/src` paths, and never\n  run `npm run eject`.\n', 'package.json': PKG({ build: 'x' }) }, []],
  ['the word "no"', { 'AGENTS.md': 'There is no root `pnpm dev`; there is no `make openapi` target either.\n', 'package.json': PKG({ build: 'x' }), 'pnpm-lock.yaml': '', Makefile: 'build:\n\t@true\n' }, []],
  ['a new list item is not negated by the previous one', { 'AGENTS.md': "- Don't use yarn\n- Run `npm run nope`\n", 'package.json': PKG({ build: 'x' }) }, ['CD001:nope']],
  // CDR-13 prose
  ['"a file named X"', { 'AGENTS.md': 'A stub is a file named `COLDSTORE.txt` in an empty folder.\n', 'package.json': PKG() }, []],
  ['"for example" far back in the sentence', { 'AGENTS.md': 'Tests check file names match exports, for example if you export a class named "OpenAiAgent" from a file, the file should be named `OpenAiAgent.ts`.\n', 'package.json': PKG() }, []],
  ['"make sure X exists"', { 'AGENTS.md': 'Make sure a `.scratchpad/` folder exists at the repo root.\n', 'package.json': PKG() }, []],
  ['placeholder with underscore', { 'AGENTS.md': '1. `tools/your_tool.py`:\n', 'tools/base.py': 'x', 'package.json': PKG() }, []],
  ['"we stopped using npm"', { 'AGENTS.md': 'We stopped using npm last year.\n', 'package.json': PKG(), 'pnpm-lock.yaml': '' }, []],
  ['generated artifacts folder', { 'AGENTS.md': '- `design/` and `outputs/`: design assets and generated artifacts.\n', 'design/a.png': 'x', 'package.json': PKG() }, []],
  ['runtime file "(state dir)"', { 'AGENTS.md': '| `last_session.yml` (state dir) | playback |\n', 'package.json': PKG() }, []],
  ['per-module convention name', { 'AGENTS.md': '- `data.ts` — parameterized reads.\n', 'package.json': PKG() }, []],
  ['pytest node id', { 'AGENTS.md': 'See `tests/test_a.py::test_one`.\n', 'tests/test_a.py': 'x', 'package.json': PKG() }, []],
  ['anchor in an inline path', { 'sub/AGENTS.md': 'Follow `../AGENTS.md#workflow`.\n', 'AGENTS.md': '# x\n', 'package.json': PKG() }, []],
  ['path in another repo named just before it', { 'AGENTS.md': 'The formula in `acme/homebrew-tap` (`Formula/tool.rb`) is rendered.\n', 'package.json': PKG() }, []],
  ['tool state dot-folder', { 'AGENTS.md': 'Custom commands live in `.mytool/commands/test.md`.\n', 'package.json': PKG() }, []],
  ['a missing committed dot-folder is still drift', { 'AGENTS.md': 'Workflows live in `.github/workflows/ci.yml`.\n', 'package.json': PKG() }, ['CD002:.github/workflows/ci.yml']],
  ['import specifier', { 'pkg/AGENTS.md': 'All functions call `fetcher()` from `../fetcher`.\n', 'pkg/src/a.ts': 'x', 'package.json': PKG() }, []],
  ['git submodule path', { 'AGENTS.md': 'Docs live in `webui/wiki/content/docs/`.\n', '.gitmodules': '[submodule "webui"]\n\tpath = webui\n\turl = https://example.invalid/webui.git\n', 'webui/x.txt': 'x', 'package.json': PKG() }, []],
  // CDR-07 module paths
  ['extensionless module path', { 'AGENTS.md': 'Import helpers from `src/utils/format`.\n', 'src/utils/format.ts': 'x', 'package.json': PKG() }, []],
  ['Next.js route', { 'AGENTS.md': 'The `pages/api/hello` endpoint returns JSON.\n', 'pages/api/hello.ts': 'x', 'package.json': PKG() }, []],
  ['"./utils" under the package src/', { 'packages/runner/AGENTS.md': 'Helpers are in `./utils`.\n', 'packages/runner/src/utils.ts': 'x', 'package.json': PKG() }, []],
  // CDR-08 / CDR-06 globs
  ['directory glob', { 'AGENTS.md': 'Source lives in `packages/*/src`.\n', 'packages/a/src/index.ts': 'x', 'package.json': PKG() }, []],
  ['gitignored build glob (rule with **)', { 'AGENTS.md': 'Tests use compiled `packages/*/cjs`.\n', '.gitignore': 'packages/**/cjs/\n', 'packages/a/src/index.ts': 'x', 'package.json': PKG() }, []],
  ['gitignored glob (basename rule)', { 'AGENTS.md': 'Output in `packages/*/build` and `website/docs/_*.md`.\n', '.gitignore': 'build\nwebsite/docs/_*.md\n', 'packages/a/src/index.ts': 'x', 'website/docs/a.md': 'x', 'package.json': PKG() }, []],
  ['glob that really matches nothing', { 'AGENTS.md': 'Specs: `src/**/*.spec.ts`.\n', 'src/a.ts': 'x', 'package.json': PKG() }, ['CD002:src/**/*.spec.ts']],
  // CDR-12 versions
  ['"Node 18 is too old"', { 'AGENTS.md': 'Node 18 is too old for this repo; use Node 22.\n', '.nvmrc': '22\n', 'package.json': PKG() }, []],
  ['"node 7 of the cluster"', { 'AGENTS.md': 'The scheduler always runs on node 7 of the cluster.\n', '.nvmrc': '22\n', 'package.json': PKG() }, []],
  ['"added in Go 1.23"', { 'AGENTS.md': 'Helpers use `sync.Map.Clear` (added in Go 1.23) and range-over-int (Go 1.22).\n', 'go.mod': 'module x\n\ngo 1.26\n' }, []],
  ['"CI runs Python 3.14"', { 'AGENTS.md': 'CI runs Python 3.14, matching the Docker image.\n', '.python-version': '3.13\n', 'pyproject.toml': '[project]\nname="x"\n' }, []],
  ['package-level engines vs the root', { 'packages/client/AGENTS.md': 'Engines: Node >=22.19.0 (repo root requires >=24).\n', 'packages/client/package.json': PKG({}, { engines: { node: '>=22.19.0' } }), 'package.json': PKG({}, { engines: { node: '>=24' } }) }, []],
  ['true Node drift', { 'AGENTS.md': 'Requires Node 18.\n', '.nvmrc': '20.11.0\n', 'package.json': PKG() }, ['CD004:Node 18']],
  // CD003
  ['consumer install of the published package', { 'packages/lib/CLAUDE.md': 'Users install it with `npm install @acme/lib`.\n', 'packages/lib/package.json': JSON.stringify({ name: '@acme/lib' }), 'package.json': JSON.stringify({ name: 'root', packageManager: 'pnpm@9' }) }, []],
  // CDR-10 make
  ['$(eval) targets', { 'AGENTS.md': 'Run `make build-api`.\n', Makefile: 'SERVICES := api web\ndefine svc\nbuild-$(1):\n\t@echo $(1)\nendef\n$(foreach s,$(SERVICES),$(eval $(call svc,$(s))))\n', 'package.json': PKG() }, []],
  ['target defined in a sub-Makefile', { 'docs/AGENTS.md': 'Run `make html` for the reference docs.\n', 'docs/Makefile': 'serve:\n\t@true\n', 'docs/sphinx/Makefile': 'html:\n\t@true\n', 'package.json': PKG() }, []],
  // workspace / elsewhere
  ['"inside its package directory"', { 'AGENTS.md': 'Each playground can be started with `pnpm dev` inside its package directory.\n', 'package.json': PKG({ build: 'x' }), 'pnpm-lock.yaml': '' }, []],
  ['"from the workspace root"', { 'AGENTS.md': 'Run `make win-rehearse` from the workspace root before the tag.\n', 'package.json': PKG() }, []],
  ['"yarn install/build/lint" list', { 'AGENTS.md': 'Frontend: `yarn install/build/lint`.\n', 'package.json': PKG({ build: 'x' }), 'yarn.lock': '' }, []],
  // CDR-17 skills
  ['skill path from the plugin root', { 'skills/browse/SKILL.md': "Import `scripts/client.mjs` from this plugin's root directory.\n", 'scripts/client.mjs': 'x' }, []],
  ['skill path that is really missing', { 'skills/browse/SKILL.md': 'Run `scripts/missing.sh`.\n', 'scripts/client.mjs': 'x' }, ['CD002:scripts/missing.sh']],
  ['skill without a scripts/ folder talks about another project', { 'skills/dom/SKILL.md': '`SELECTORS` in `scripts/perf/lib/cdp.mjs` holds the hooks.\n', 'package.json': PKG() }, []],
  ['skill path that exists at the project root', { 'tools/skills/t/SKILL.md': 'See `examples/tests/app.yaml`.\n', 'tools/skills/t/examples/x.md': 'x', 'examples/tests/app.yaml': 'x' }, []],
  ['applyTo with a brace list is one glob', { '.github/instructions/web.instructions.md': '---\napplyTo: "src/**/*.py,web/src/**/*.{ts,tsx}"\n---\nx\n', 'src/a.py': 'x', 'web/src/a.tsx': 'x', 'package.json': PKG() }, []],
  ['nvm alias lts/*', { 'AGENTS.md': 'The image tracks the `lts/*` alias.\n', 'package.json': PKG() }, []],
  ['paths listed after a home folder', { 'AGENTS.md': 'Data persists under `~/.geo/` (`prospects.json`, `audits/`, `proposals/`).\n', 'package.json': PKG() }, []],
  ['"e.g." before a file name', { 'AGENTS.md': '- **Scripts:** kebab-case.sh (e.g., `analyze-performance.sh`)\n', 'package.json': PKG() }, []],
  ['"the library\'s copy"', { 'AGENTS.md': "The library's copy uses relative paths (`../link.ts`).\n", 'src/a.ts': 'x', 'package.json': PKG() }, []],
  // CDR-21 directives
  ['directive inside a code span is documentation, not a directive', { 'AGENTS.md': 'Suppress with `<!-- context-drift-disable -->` if needed.\nBuild: `npm run nope`.\n', 'package.json': PKG({ build: 'x' }) }, ['CD001:nope']],
  ['real directive comment still works', { 'AGENTS.md': '<!-- context-drift-disable-next-line CD001 -->\nBuild: `npm run nope`.\n', 'package.json': PKG({ build: 'x' }) }, []],
  ['directive above a fence covers the block', { 'AGENTS.md': '<!-- context-drift-disable-next-line CD001 -->\n```bash\nnpm run nope\nnpm run nope2\n```\n', 'package.json': PKG({ build: 'x' }) }, []],
  // copied folder
  ['folder with no git and no manifest whose paths are mostly missing', { 'AGENTS.md': 'See `src/a.ts`, `src/b.ts`, `docs/c.md` and `lib/d.ts`.\n', 'notes.txt': 'x' }, ['CD002:Not a project root']],
  ['few missing paths in a folder without a manifest are still reported', { 'AGENTS.md': 'Entry: `src/server/main.ts`.\n', 'src/main.ts': 'x' }, ['CD002:src/server/main.ts']],
];

for (const [name, files, expect] of CASES) {
  test(`FP regression: ${name}`, () => {
    const r = tempRepo(files);
    try {
      const res = engine.analyzeWorkspace(r.dir, { git: false });
      const got = res.diagnostics.map((d) => `${d.ruleId} ${d.message}`);
      const unexpected = res.diagnostics.filter((d) => !expect.some((e) => { const [rule, sub] = e.split(/:(.*)/); return d.ruleId === rule && d.message.includes(sub); }));
      const missing = expect.filter((e) => { const [rule, sub] = e.split(/:(.*)/); return !res.diagnostics.some((d) => d.ruleId === rule && d.message.includes(sub)); });
      assert.deepEqual({ unexpected: unexpected.map((d) => d.message), missing }, { unexpected: [], missing: [] }, got.join('\n'));
    } finally { r.cleanup(); }
  });
}

test('sparse checkout: path and workspace-wide findings are dropped without git; scripts in an on-disk package.json are still checked', () => {
  const fs = require('fs');
  const path = require('path');
  const r = tempRepo({
    'AGENTS.md': 'Run `pnpm --filter @x/api dev`, `pnpm run nope`, and see `apps/api/README.md`.\n',
    'package.json': PKG({ build: 'x' }), 'pnpm-lock.yaml': '',
    '.git/info/sparse-checkout': '/*\n!/apps/\n', '.git/config': '[core]\n\tsparseCheckout = true\n', '.git/HEAD': 'ref: refs/heads/main\n',
  });
  try {
    const res = engine.analyzeWorkspace(r.dir, { git: false });
    assert.equal(res.context.sparse, true);
    assert.deepEqual(res.diagnostics.map((d) => `${d.ruleId} ${d.severity} ${d.message.slice(0, 22)}`), ['CD001 error Script "nope" is not d']);
    void fs; void path;
  } finally { r.cleanup(); }
});

test('severity: error only for npm/pnpm run and make with the manifest at the right level', () => {
  const r = tempRepo({
    'AGENTS.md': '`npm run nope`, `npm test`, `make nope`, `just nope`, `yarn nope3`\n',
    'sub/AGENTS.md': '`make nope2`\n',
    'package.json': PKG({ build: 'x' }), 'package-lock.json': '{}', Makefile: 'build:\n\t@true\n', justfile: 'build:\n  echo\n',
    '.git/HEAD': 'ref: refs/heads/main\n', // its own repo root: no package.json above it is consulted
  });
  try {
    const res = engine.analyzeWorkspace(r.dir, { git: false });
    const got = res.diagnostics.filter((d) => d.ruleId === 'CD001').map((d) => `${d.file} ${d.severity} ${d.message.split(/[:.]/)[0]}`);
    assert.deepEqual(got, [
      'AGENTS.md error Script "nope" is not defined in package',
      'AGENTS.md warning Script "test" is not defined in package',
      'AGENTS.md error `make nope`',
      'AGENTS.md warning `just nope`',
      'AGENTS.md warning Script "nope3" is not defined in package',
      'sub/AGENTS.md warning `make nope2`',
    ]);
  } finally { r.cleanup(); }
});

test('workspace opened at a subfolder: a script in a package.json above it, up to the git root, is accepted', () => {
  const r = tempRepo({ '.git/HEAD': 'ref: refs/heads/main\n', 'package.json': PKG({ 'test:e2e': 'x' }), 'apps/web/package.json': PKG({ build: 'x' }), 'apps/web/AGENTS.md': 'Run `npm run test:e2e` and `npm run nope`.\n' });
  try {
    const res = engine.analyzeWorkspace(require('path').join(r.dir, 'apps/web'), { git: false });
    assert.deepEqual(res.diagnostics.map((d) => d.message.slice(0, 20)), ['Script "nope" is not']);
  } finally { r.cleanup(); }
});
