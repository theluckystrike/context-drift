# Context Drift for AGENTS.md & CLAUDE.md

**Your CLAUDE.md says `make test` and Node 18. Your repo says otherwise.**

Agent instruction files state facts about your repo: which commands to run, where files live, which package manager and runtime to use. Code moves on and these files don't. Then the agent runs a script that no longer exists, opens a file that moved, or installs with the wrong package manager.

Context Drift compares what your instruction files say with what is actually in the repo. It shows each mismatch in the editor, with the exact range and a quick fix where one is cheap.

It reads `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, `.windsurfrules`, `.clinerules`, and `SKILL.md`.

## Before / after

`AGENTS.md` in a repo that moved from pnpm to npm, renamed its deploy target, moved `main.ts`, and upgraded Node. This is the real output on [`test/fixtures/readme-example`](test/fixtures/readme-example):

```markdown
- Requires Node 18.
- Install with `pnpm install`.
- Build: `npm run buidl`. Deploy: `make deploy`.
- Entry point: `src/server/main.ts`
```

```text
$ npx context-drift
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
**error** (heuristic forms: **warning**)

- `npm run X`, `npm test`, `npm start`, `pnpm X`, `yarn X` and `bun run X` where `X` is not in `scripts`. It checks the nearest `package.json` and the root one. With `--filter`, `-r`, `-w` or `--workspace` it checks every workspace package. If the script exists only in another workspace package, it reports nothing.
- `make X` with no target `X` in the Makefile, including `include`d files, `-C dir` and `-f file`.
- `just X` with no recipe or alias `X`, and `task X` with no task `X` in the Taskfile.
- `cargo -p crate` and `cargo --bin name` for crates and binaries that do not exist. `cargo X` when the repo defines `[alias]` but not `X`.
- `uv run X` and `poetry run X` when `X` is not in `[project.scripts]` or `[tool.poetry.scripts]` and is not a declared dependency.
- It understands `cd dir && …`, environment prefixes (`FOO=1 …`), `$ ` prompts, and `console` blocks, where only prompt lines are commands.
- It never flags built-ins (`npm install`, `pnpm add`, `bun test`, `cargo build`, …), placeholders (`npm run <script>`), or negated text ("don't run `npm run eject`").
- If the instruction file is a skill (`SKILL.md`), this rule is off. Skills usually describe other projects.

### CD002 path drift
**warning** (globs: **info**)

- Backticked relative paths (`src/foo.ts`, `./docs/x.md`, `folder/`) and markdown links that do not exist.
- It suggests a fix when exactly one file with the same name exists elsewhere, which is usually a moved file.
- Globs that match nothing (`src/**/*.vue`) are reported as info, including Cursor `.mdc` `globs:` and Copilot `applyTo:` patterns that never apply.
- It ignores the following:
  - URLs, `~/` and absolute paths.
  - Placeholders (`<name>`, `path/to/`, `my-app`).
  - Gitignored and build-output paths.
  - `owner/repo` slugs.
  - Code fences.
  - Anything under an "Example" heading.
  - Files the text asks you to *create*.
- In `SKILL.md` it checks only the skill's own bundle: links and `scripts/`, `references/` and `assets/` paths.

### CD003 package-manager drift
**warning**

- The file says `pnpm`, `yarn`, `bun` or `npm`, in a command or in prose ("we use yarn"), but `packageManager` or the lockfile says another.
- The quick fix replaces the command, for example `npm run dev` → `pnpm run dev`.
- Global installs (`npm i -g`) are fine.

### CD004 version drift
**warning**

- "Node 18", "Python 3.11+", "Go 1.22", `nvm use 18` and `pyenv local 3.10` are checked against:
  - `.nvmrc` and `.node-version`
  - `engines.node` and `volta.node`
  - `.python-version` and `runtime.txt`
  - `requires-python` and Poetry's `python`
  - `go.mod` (`go` and `toolchain`)
  - `.tool-versions`
- It understands ranges (`>=18 <21`, `^20`, `~=3.11`) and version matrices ("Node 18, 20 and 22").
- Historical text ("dropped Python 3.8") is ignored.

### CD005 cross-file conflict
**info**

- `AGENTS.md` says `make test` and `CLAUDE.md` says `npm test`.
- Two instruction files in the same scope give different commands for the same verb: test, build, lint, format, dev or typecheck.
- Files in subfolders are a separate scope.

### CD006 stale file
**info**

- The instruction file's last commit is older than 180 days, and the repo has 50 or more commits since then.
- It uses `git log`, read-only. It is skipped silently when there is no git and in untrusted workspaces.

### Suppressing a finding

```markdown
<!-- context-drift-disable-next-line CD002 -->
- `generated/schema.ts` appears after `npm run codegen`.

<!-- context-drift-disable CD006 -->   (whole file)
```

## What it does not do: use agnix for linting

Context Drift does not lint the *format* of instruction files: frontmatter, rule schemas, hook and MCP config, and so on. Use [agnix](https://github.com/agent-sh/agnix) for that. It has hundreds of lint rules for Claude Code, Codex, Cursor, Copilot and more. The two tools are complementary: agnix checks that the file is well-formed, and Context Drift checks that it is still *true*. Run both.

## Editor

- Diagnostics appear when you open, edit (debounced) or save an instruction file. They also refresh when `package.json`, a Makefile, a lockfile, `.nvmrc` and similar files change.
- Command: **Context Drift: Check Workspace**.
- Status bar: `Drift: N` (warnings and errors). Click it to re-check.
- Quick fixes:
  - replace with the suggested script, target or path;
  - replace the package manager;
  - **Show scripts** in `package.json` or open the Makefile;
  - **Reveal the referenced file's folder**;
  - disable for this line;
  - ignore a rule in this workspace.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `contextDrift.enable` | `true` | Turn the checks on or off. |
| `contextDrift.ignoreRules` | `[]` | Rule ids to skip, for example `["CD005", "CD006"]`. |
| `contextDrift.gitStaleness` | `true` | Allow `git log` for CD006. Always off in untrusted workspaces. |
| `contextDrift.staleDays` | `180` | CD006 age threshold, in days. |
| `contextDrift.staleCommits` | `50` | CD006 commit threshold. |

## CLI

```bash
npx context-drift                 # check the current repo
npx context-drift path/to/repo    # or a repo / a single instruction file
npx context-drift --json          # machine-readable
npx context-drift --format github # GitHub Actions annotations
npx context-drift --fail-on warning --ignore CD006
```

Exit codes:
- `0`: no findings at the `--fail-on` level (default: `error`).
- `1`: there are findings at that level.
- `2`: usage error.

### GitHub Action

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
        with: { fetch-depth: 0 }   # full history for CD006; use --no-git with a shallow clone
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npx -y context-drift --format github
```

`--format github` prints `::error`, `::warning` and `::notice` workflow commands, so findings show up inline on the PR diff.

## Speed and safety

- Zero runtime dependencies. One small CommonJS engine is shared by the extension and the CLI.
- Fast. A 5,000-file repo takes about 20 ms on an M-series Mac. It never reads `node_modules`, `.git`, `dist`, `build`, `vendor`, `target` or `.venv`, and it skips nested git repos and worktrees.
- Robust:
  - Binary, huge (over 1 MB), CRLF, BOM, Unicode and broken (`package.json` with comments) files never crash it.
  - It skips what it cannot verify instead of guessing.

## Privacy

Context Drift runs locally. It makes **no network requests** and has **no telemetry**. It reads files in your workspace, and in trusted workspaces it runs `git log` read-only. Nothing leaves your machine.

## License

MIT © 2026 Zovo
