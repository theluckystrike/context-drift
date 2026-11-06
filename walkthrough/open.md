# Files Context Drift reads

- `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`
- `.cursorrules`, `.cursor/rules/**/*.mdc`
- `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md`
- `.windsurfrules`, `.windsurf/rules/**/*.md`, `.clinerules`
- `SKILL.md`

It compares each one with `package.json`, the lockfile, `Makefile`, `justfile`, `Taskfile.yml`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `.nvmrc` and the files on disk. Nothing leaves your machine.
