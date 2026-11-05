# Context Drift for AGENTS.md & CLAUDE.md

**Your CLAUDE.md says `make test` and Node 18. Your repo says otherwise.**

Agent instruction files state facts about your repo: which commands to run, where files live, which package manager and runtime to use. Code moves on and these files don't. Then the agent runs a script that no longer exists, opens a file that moved, or installs with the wrong package manager.

Context Drift compares what your instruction files say with what is actually in the repo. It shows each mismatch in the editor, with the exact range and a quick fix where one is cheap.

It reads `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/**/*.mdc`, `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md`, `.windsurfrules`, `.windsurf/rules/**/*.md`, `.clinerules` (file or folder), and `SKILL.md`.

It is built for precision: when a statement cannot be checked for sure, it says nothing. On the repositories measured for this release, about 9 in 10 reported findings were true (see [Precision](#precision)).

## Before / after

`AGENTS.md` in a repo that moved from pnpm to npm, renamed its deploy target, moved `main.ts`, and upgraded Node. This is the real output on [`test/fixtures/readme-example`](test/fixtures/readme-example):

```markdown
- Requires Node 18.
- Install with `pnpm install`.
- Build: `npm run buidl`. Deploy: `make deploy`.
- Entry point: `src/server/main.ts`
```

```text
$ npx -y github:theluckystrike/context-drift
AGENTS.md:1:12: warning CD004 Version claim "Node 18" does not match the repo: .nvmrc says 20.11.0.
AGENTS.md:2:17: warning CD003 `pnpm` is used here, but the repo uses npm (package-lock.json).
AGENTS.md:3:19: error CD001 Script "buidl" is not defined in package.json. Did you mean "build"?
AGENTS.md:3:41: error CD001 `make deploy`: no target "deploy" in Makefile.
AGENTS.md:4:17: warning CD002 Path "src/server/main.ts" does not exist in the repo. Did you mean "src/main.ts"?
context-drift: 1 instruction file(s) checked in 9 ms: 2 error(s), 3 warning(s), 0 info
```

After the quick fixes (and picking `deploy-prod` from the Makefile):

```markdown
- Requires Node 20.
- Install with `npm install`.
- Build: `npm run build`. Deploy: `make deploy-prod`.
- Entry point: `src/main.ts`
```

## What it checks

Each finding has a stable rule id, a severity, and an exact range.

### CD001 command drift
**error** for `npm run X`, `pnpm run X` and `make X` checked against the manifest in the right folder. **warning** for every other form (`npm test`, bare `pnpm X` / `yarn X` / `bun run X`, workspace-wide `--filter`/`-r`, `just`, `task`, `cargo`, `uv run`, a Makefile found only in a parent folder).

- `npm run X`, `npm test`, `npm start`, `pnpm X`, `yarn X` and `bun run X` where `X` is not in `scripts`. It checks the nearest `package.json` and the root one. With `--filter`, `-r`, `-w` or `--workspace` it checks every workspace package. If the script exists in another workspace package, or in a `package.json` above the opened folder (up to the git root), it reports nothing. Binaries from dependencies count (`yarn vue-cli-service` from `@vue/cli-service`).
- `make X` with no target `X` in the Makefile, including `include`d files, `-C dir` and `-f file`. Makefiles that generate targets (`$(eval ...)`, pattern rules) and targets defined in a Makefile further down the tree are not reported.
- `just X` with no recipe or alias `X`, and `task X` with no task `X` in the Taskfile.
- `cargo -p crate` and `cargo --bin name` for crates and binaries that do not exist. `cargo X` when the repo defines `[alias]` but not `X`.
- `uv run X` and `poetry run X` when `X` is not in `[project.scripts]` or `[tool.poetry.scripts]` and is not a declared dependency.
- It understands `cd dir && …`, environment prefixes (`FOO=1 …`), and `$ ` prompts. In `console` blocks, and in shell blocks that use `$ ` prompts, only prompt lines are commands; the rest is output. `make test    Run the tests` listings stop at the description.
- It does not flag built-ins (`npm install`, `pnpm add`, `bun test`, `cargo build`, …) or placeholders (`npm run <script>`).
- It skips negated or historical text. The words *no, not, never, don't, avoid, instead of, deprecated, removed, old* (and similar) in the same sentence, or on the previous line of the same paragraph, turn the check off: "There is no root `pnpm dev`", "don't run `npm run eject`".
- It skips commands that the text says run somewhere else: "inside its package directory", "from the workspace root", "from the library".
- In a sparse checkout it skips workspace-wide forms, because the packages may not be checked out.
- If the instruction file is a skill (`SKILL.md`), this rule is off. Skills usually describe other projects.

### CD002 path drift
**warning** (globs: **info**)

- Backticked relative paths (`src/foo.ts`, `./docs/x.md`, `folder/`, `.\scripts\build.ps1`) and markdown links that do not exist.
- Module-style paths without an extension count as present when a file with a usual extension or an `index` file exists (`src/utils/format` → `src/utils/format.ts`, `pages/api/hello`). `./utils` in `packages/x/AGENTS.md` may also mean `packages/x/src/utils`.
- It suggests a fix when exactly one file with the same name exists elsewhere, which is usually a moved file.
- Globs that match nothing (`src/**/*.vue`) are reported as info, including Cursor `.mdc` `globs:` and Copilot `applyTo:` patterns that never apply. A glob whose last part has no extension (`packages/*/src`) also matches folders. At most 200 globs per file are checked.
- It ignores the following:
  - URLs, `~/` and absolute paths, and paths right after an external URL or an `owner/repo` name (they live in that other repo).
  - Placeholders (`<name>`, `path/to/`, `my-app`, `your_tool.py`, `mycommand.go`).
  - Gitignored paths and globs: each `.gitignore` in the repo and `.git/info/exclude` are matched against the whole path, wildcards included. When git is allowed, `git check-ignore` has the last word.
  - Build output and scratch folders (`dist`, `build`, `out`, `cjs`, `generated`, …) and tool state folders such as `.scratchpad/`.
  - Paths inside git submodules.
  - Code fences.
  - Anything under an "Example" heading.
  - Text that names, creates, generates or stores a file rather than claiming it exists ("a file named `X`", "make sure `X/` exists", "regenerate `X`", "stored in `X`").
- In a sparse checkout, a missing path is reported only when `git ls-files` confirms it is not in the repo. Without git, missing paths are not reported there.
- If the folder is not a git repository root, has no manifest, and most referenced paths are missing, it reports one info "Not a project root" instead of a list of missing paths. That is the usual case for an instruction file copied somewhere else.
- In `SKILL.md` it checks only the skill's own bundle: links and `scripts/`, `references/`, `assets/` and similar paths, resolved against the skill folder and the plugin root.

### CD003 package-manager drift
**warning**

- The file says `pnpm`, `yarn`, `bun` or `npm`, in a command or in prose ("we use yarn"), but `packageManager` or the lockfile says another.
- The quick fix replaces the command, for example `npm run dev` → `pnpm run dev`.
- Global installs (`npm i -g`) are fine.

### CD004 version drift
**warning**

- In prose, "Node" must be capitalized (or written `Node.js`, `nodejs`, "node version"), so "node 7 of the cluster" is not a version claim.
- A package-level instruction file is compared with its nearest `package.json`, not with the workspace root.
- "Node 18", "Python 3.11+", "Go 1.22", `nvm use 18` and `pyenv local 3.10` are checked against:
  - `.nvmrc` and `.node-version`
  - `engines.node` and `volta.node`
  - `.python-version` and `runtime.txt`
  - `requires-python` and Poetry's `python`
  - `go.mod` (`go` and `toolchain`)
  - `.tool-versions`
- It understands ranges (`>=18 <21`, `^20`, `~=3.11`) and version matrices ("Node 18, 20 and 22").
- Historical, feature and CI text is ignored: "dropped Python 3.8", "added in Go 1.23", "Node 18 is too old", "CI runs Python 3.14".

### CD005 cross-file conflict
**info**

- `AGENTS.md` says `make test` and `CLAUDE.md` says `npm test`.
- Two instruction files in the same scope give different commands for the same verb: test, build, lint, format, dev or typecheck.
- Files in subfolders are a separate scope, and commands that run in different folders (`npm test` vs `cd api && pytest`) do not conflict.

### CD006 stale file
**info**, **off by default**

- Turn it on with `--stale` (CLI) or `contextDrift.gitStaleness` (editor).
- The instruction file's last commit is older than 180 days, and the repo has 50 or more commits since then.
- It uses `git log`, read-only, with a 3 s timeout per call. It is skipped silently when there is no git and in untrusted workspaces.

### Suppressing a finding

```markdown
<!-- context-drift-disable-next-line CD002 -->
- `generated/schema.ts` appears after `npm run codegen`.

<!-- context-drift-disable-next-line CD001 -->   (above a code fence: the whole block)
```bash
npm run legacy-task
```

<!-- context-drift-disable CD006 -->   (whole file)
```

- Directives count only as real HTML comments. Text in a code span that shows the syntax does not turn anything off.
- In YAML frontmatter (Cursor `.mdc`), use a YAML comment: `# context-drift-disable-next-line CD002`. The quick fix picks the right form.

## What it does not do: use agnix for linting

Context Drift does not lint the *format* of instruction files: frontmatter, rule schemas, hook and MCP config, and so on. Use [agnix](https://github.com/agent-sh/agnix) for that. It has hundreds of lint rules for Claude Code, Codex, Cursor, Copilot and more. The two tools are complementary: agnix checks that the file is well-formed, and Context Drift checks that it is still *true*. Run both.

## Editor

- Diagnostics appear when you open, edit (debounced) or save an instruction file. They also refresh when `package.json`, a Makefile, a lockfile, `.nvmrc` and similar files change, and when files are created or deleted. Saving any other file does nothing.
- The checks and git run in a worker thread, never on the extension host. The repository view is cached: an instruction-file edit reuses it, a manifest change re-reads only the manifests, and only created or deleted files make it walk the folder again. A check that takes longer than 30 s is stopped.
- Command: **Context Drift: Check Workspace**.
- Status bar: `Drift: N` (warnings and errors). Click it to re-check.
- Quick fixes:
  - replace with the suggested script, target or path;
  - replace the package manager;
  - **Show scripts** in `package.json` or open the Makefile;
  - **Reveal the referenced file's folder**;
  - disable for this line (or code block);
  - ignore a rule in this workspace.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `contextDrift.enable` | `true` | Turn the checks on or off. |
| `contextDrift.ignoreRules` | `[]` | Rule ids to skip, for example `["CD005", "CD006"]`. |
| `contextDrift.useGit` | `true` | Use read-only `git check-ignore` and `git ls-files` to skip ignored paths and files a sparse checkout leaves out. 3 s timeout per call. Always off in untrusted workspaces. |
| `contextDrift.gitStaleness` | `false` | Turn on CD006 (`git log`, read-only). Always off in untrusted workspaces. |
| `contextDrift.staleDays` | `180` | CD006 age threshold, in days. |
| `contextDrift.staleCommits` | `50` | CD006 commit threshold. |

## CLI

The CLI is not published to the npm registry. Run it from GitHub with `npx`, or from a clone:

```bash
npx -y github:theluckystrike/context-drift                    # check the current repo
npx -y github:theluckystrike/context-drift path/to/repo       # or a repo / a single instruction file
npx -y github:theluckystrike/context-drift --json             # machine-readable
npx -y github:theluckystrike/context-drift --format github    # GitHub Actions annotations
npx -y github:theluckystrike/context-drift --fail-on warning --ignore CD005

# or: git clone https://github.com/theluckystrike/context-drift && node context-drift/bin/context-drift.js .
```

Do not run `npx context-drift` without the `github:` prefix: there is no npm package by that name, and someone else could publish one.

Options: `--json`, `--format text|json|github`, `--fail-on error|warning|info|never`, `--ignore <ids>`, `--stale` (turn on CD006), `--no-git` (never run git), `--stale-days`, `--stale-commits`, `-q`. Files that are not checked (over 1 MB, a symlink that leaves the folder, lines over 4,000 characters) are listed on stderr.

Exit codes:
- `0`: no findings at the `--fail-on` level (default: `error`).
- `1`: there are findings at that level.
- `2`: usage error.

### GitHub Action

Pin a tag, so a later change in the repo cannot change your CI:

```yaml
name: context-drift
on:
  pull_request:
    paths: ["**/*.md", "**/.cursorrules", "**/*.mdc", "package.json", "Makefile", "justfile", "pyproject.toml", "go.mod", ".nvmrc"]
concurrency: { group: context-drift-${{ github.ref }}, cancel-in-progress: true }
jobs:
  drift:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npx -y github:theluckystrike/context-drift#v0.1.1 --format github
```

`--format github` prints `::error`, `::warning` and `::notice` workflow commands, so findings show up inline on the PR diff. Add `--stale` and `fetch-depth: 0` on the checkout step if you want CD006.

## Speed and safety

- Zero runtime dependencies. One small CommonJS engine is shared by the extension and the CLI.
- Fast. A 5,000-file repo takes about 20 ms on an M-series Mac. It never reads `node_modules`, `.git`, `dist`, `build`, `vendor`, `target` or `.venv`, and it skips nested git repos and worktrees.
- Safe on hostile repos. Globs from the repo are never turned into regular expressions; a linear-time matcher is used instead. Every line regex is linear. Inputs are capped: 1 MB per file, 4,000 characters per line, 200 globs and 20,000 code spans per file. A test times each adversarial input from the review at 1 MB, and each must finish in under 50 ms.
- git runs only asynchronously, read-only, with `--no-optional-locks`, `core.fsmonitor=false` and a 3 s timeout per call; a hung git is killed.
- Robust: binary, huge, CRLF, BOM, Unicode and broken (`package.json` with comments) files never crash it.

## Precision

Measured for 0.1.1 on the same material as the independent review of 0.1.0 (details in `NOTES.md` in the repository):

- **Real source repositories** from the review (a webdriverio checkout, promptbook, a small CLI repo): 4 findings, all true. 0.1.0 reported 4 true and 14 false findings there.
- **184 local folders with 3,629 instruction files** (git off, as in the review):
  - CD001: 6 findings, 1 false (0.1.0: 31 findings, 26 false).
  - CD004: 3 findings, none false (0.1.0: 8, 5 false).
  - CD005: none (0.1.0: 4, all false).
  - CD002: 224 warnings (0.1.0: 921). In a random sample of 40, 4 were false. Another 21 are technically true: they sit in folders that hold a copy of an instruction file without the source.
  - Overall, about 1 finding in 10 is false.
- **The 48 adversarial cases** from the review: all 48 pass (0.1.0: 24 false positives, 1 false negative).

## Privacy

Context Drift runs locally. It makes **no network requests** and has **no telemetry**. It reads files inside your workspace only: a symlinked instruction file or manifest that points outside the workspace is skipped. In trusted workspaces it may run read-only git (`check-ignore`, `ls-files`, and `log` when CD006 is on). Nothing leaves your machine.

## License

MIT © 2026 Zovo
