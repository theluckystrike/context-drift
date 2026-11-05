# Changelog

## 0.1.1 (2026-11-05)

Safety, speed and precision fixes from an independent review.

### Safety
- Globs from the repository (inline code, `.mdc` `globs:`, `.gitignore`, Taskfiles) are no longer turned into regular expressions. A linear-time glob matcher replaces them. A 100-byte glob could hang 0.1.0.
- Every line regex is linear: version claims, links, Makefile, justfile, Taskfile and TOML lines. Inputs are capped at 1 MB per file, 4,000 characters per line, 200 globs and 20,000 code spans per file. A new test times each adversarial input from the review at 1 MB (under 50 ms each).
- The extension runs the engine and git in a worker thread, never on the extension host. A check that takes longer than 30 s is stopped.
- git runs only asynchronously, with a 3 s timeout per call, `--no-optional-locks`, `core.fsmonitor=false` and `log.showSignature=false`. A hung git is killed.
- A symlinked instruction file or manifest that points outside the workspace is not read.

### Editor
- Saving a file re-checks only when it is an instruction file or a manifest. The repository view is cached: instruction edits reuse it, manifest changes re-read only manifests, created or deleted files re-walk the folder.
- Closing a dirty instruction file without saving drops the diagnostics of the unsaved text.
- "Disable for this line" writes a YAML comment inside frontmatter (Cursor `.mdc`), and goes above the fence for code blocks ("Disable for this code block").
- Activates for nested `.cursor/rules/**`, `.clinerules/**`, `.windsurf/rules/**`, `.github/instructions/**`, and when a Markdown file opens.
- New setting `contextDrift.useGit`. `contextDrift.gitStaleness` now defaults to `false`.

### Rules
- CD001 is an error only for `npm run X`, `pnpm run X` and `make X` checked against the manifest in the right folder. Every other form is a warning.
- CD006 is off by default (`--stale`, `contextDrift.gitStaleness`).
- False positives fixed: sparse checkouts, gitignored and build-output globs, directory globs, extensionless module paths, Windows paths, negation on the previous line and the word "no", "a file named X" and similar prose, placeholders such as `your_tool.py`, prompt-less output lines in shell blocks, `make` target listings, `$(eval)` Makefiles, targets in sub-Makefiles, scripts in a `package.json` above the opened folder, binaries named differently from their package, CD004 history and CI text, package-level `engines`, CD005 commands that run in different folders, skill paths relative to the plugin root, git submodules, runtime state files, import aliases and package export subpaths, and folders that only hold a copied instruction file (one "Not a project root" note instead).
- Directives count only as real HTML comments (or YAML comments in frontmatter), not inside code spans.

### CLI
- The README now documents the real install path: `npx -y github:theluckystrike/context-drift` or `node bin/context-drift.js`. There is no npm package.
- Files that are not checked (over 1 MB, symlinks that leave the folder, very long lines) are listed on stderr and are not counted as checked.
- New `--stale`; `--no-git` now turns off every git call.

## 0.1.0 (2026-11-05)

First release.

- CD001 command drift: npm/pnpm/yarn/bun scripts (nearest and root `package.json`, workspaces), `make` targets (with `include`, `-C`, `-f`), `just` recipes and aliases, Taskfile tasks, `cargo -p`/`--bin`/aliases, and `uv run`/`poetry run` scripts.
- CD002 path drift: backticked paths and markdown links. Moved files get a "Did you mean" fix. Globs and Cursor `globs:` / Copilot `applyTo:` patterns that match nothing are reported as info.
- CD003 package-manager drift: commands and prose are checked against `packageManager` and the lockfile, with a replace quick fix.
- CD004 version drift: Node, Python and Go claims are checked against `.nvmrc`, `.node-version`, `engines`, `volta`, `.python-version`, `requires-python`, `go.mod` and `.tool-versions`.
- CD005 cross-file conflict: different test/build/lint/format/dev/typecheck commands in instruction files of the same scope.
- CD006 stale file: older than 180 days, with 50+ commits since (git, read-only).
- VS Code: diagnostics on open, edit and save; **Context Drift: Check Workspace**; status bar count; quick fixes; `contextDrift.*` settings.
- CLI `context-drift`: `--json`, `--format github`, `--fail-on`, `--ignore` and `--no-git`.
- Inline suppression: `<!-- context-drift-disable-next-line CD00x -->` and `<!-- context-drift-disable CD00x -->`.
