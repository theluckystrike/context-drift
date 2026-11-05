# Changelog

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
