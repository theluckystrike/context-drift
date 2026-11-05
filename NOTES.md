# Context Drift — build notes (2026-11-05)

## Self-run on real local repos (read-only)

Command: `node bin/context-drift.js <repo>`, with git (CD006) on. Candidates came from `find ~ -maxdepth 3 -name AGENTS.md -not -path '*/node_modules/*'` and the same for CLAUDE.md. Five of the repos below are local projects. The four third-party repos are clones under `~/mcp-servers/.scratch-distribution/` and were added as a stress corpus because they have 200+ instruction files.

### Final results (after fixes)

| Repo | Files walked | Instruction files | Time | Findings | Verdict |
| --- | --- | --- | --- | --- | --- |
| ~/product-factory | 14,544 | 1 | 311 ms (git incl.) | 0 | — |
| ~/pf-cloud | 9,822 | 1 | 271 ms | 0 | — |
| ~/100xagenticdev-restored | 172 | 1 | 25 ms | 3 × CD002 | **TP**: CLAUDE.md lists `evals/`, `memory/`, `docs/`; none exist (the restore lost them or they were never created) |
| ~/earlythunder | 380 | 3 | 177 ms | 2 × CD006 | **TP**: AGENTS.md and CLAUDE.md were last changed 2026-04-13 (205 days); there are 477 commits since |
| ~/zovo-payment-release | — | 194 | 438 ms | 194 × CD006 | **TP** by the rule's definition: all files are dated 2026-03-27 with 632 commits since. The volume is noisy; users can raise `staleDays` or ignore CD006 |
| ~/li-pipeline, ~/obsidian-theme-factory-2026-10-14, ~/tgapps-work, ~/earlythunder-cta-deploy, ~/funding-opportunities-20261026-work, ~/sprint-1029-work, ~/sprint-1030-work | — | 1–3 each | 15–230 ms | 0 | — |
| toolhive-catalog (3rd party) | 925 | 8 | 60 ms | 1 × CD004 | **TP**: CLAUDE.md says "Requires Go 1.25+", but go.mod says `go 1.26.0` |
| wshobson-agents (3rd party) | 1,167 | 188 | 153 ms | 22 × CD002 | **TP**: every finding is a skill that references a bundled file that is not shipped (`assets/*.json`, `references/*.md`), or a broken relative link between skills/plugins (`../owasp-top10-checklist/SKILL.md`, `../../protect-mcp/`) |
| acp-fork / composio-acp (3rd party) | 394 | 23 | 52 ms | 1 × CD002 | **TP**: artifacts-builder SKILL.md says to run `scripts/init-artifact.sh`; the fork does not ship `scripts/` |

**False positives remaining on these repos: 0.**

### False positives found and fixed (12 classes, about 140 findings)

| # | Where | Example | Fix | Regression test |
| --- | --- | --- | --- | --- |
| 1 | product-factory, pf-cloud | `community.obsidian.md` (a hostname) reported as a missing file | Bare names that look like hostnames ending in a TLD (`.md`, `.sh`, `.rs`, …) are not files | `FP fix: hostnames …` |
| 2 | product-factory, pf-cloud (×8 incl. worktrees) | `pnpm run test:e2e` from root reported as info because the script lives in a template package | A script defined in any workspace package is no longer reported; the same applies to make targets in sub-Makefiles | `CD001 edge: script defined only in a workspace package …` |
| 3 | pf-cloud | `main.js` (Obsidian build output) reported as a missing file | Skip common build-output names, and bare names matched by any `.gitignore` in the repo | `FP fix: build outputs and gitignored bare names` |
| 4 | product-factory | Every `.wt/*` git worktree was scanned as part of the parent repo (12 duplicate findings, 2 s) | Skip any subdirectory that contains `.git` (nested repo, worktree or submodule). Walk time went from 2,033 ms to 333 ms | `FP fix: nested git worktree …` |
| 5 | mcp-servers clones (31 info) | `[CRIT]`, `list[T]`, `Optional[T]`, `packages[0].identifier`, `LGPL-*`, `**[?]**` treated as globs | A glob must contain `/` or end in a file extension; bracketed words without `/` are never globs; literal `app/[id]/page.tsx` routes are checked as paths | `FP fix: bracketed words …` |
| 6 | wshobson-agents (7) | Generic skill teaching `pnpm changeset` reported as CD003 in an npm repo | SKILL.md: CD001, CD003 and CD004 are off, because skills describe other projects | `FP fix: SKILL.md checks only its bundled files …` |
| 7 | wshobson-agents (~40) | Skill describing a target project (`eval/`, `src/package_name/`, `user_service.py`, `.gitlab-ci.yml`) | SKILL.md: CD002 only for links and `scripts/`, `references/`, `assets/`, `templates/` and `examples/` paths, resolved against the skill directory | same |
| 8 | wshobson-agents (2) | `cd my-monorepo` after `npx create-turbo` | Placeholder words (`my-`, `your-`, `example`) in cd targets; skip `cd` checks after a create/init/clone/mkdir line in the same block | `FP fix: cd into a directory created earlier …` |
| 9 | toolhive skill-creator, mcp-review (5) | "**Examples**: `references/finance.md`", "look for Dependabot (`.github/dependabot.yml`)" | Added `examples`, `look for`, `check for`, `detect`, `whether`, `either` and `any of` to the "not a claim" context words | covered by the SKILL.md test |
| 10 | wshobson-agents (2) | `[Runbook](internal-wiki/deployment-runbook)` in a template | Links without an extension whose first folder does not exist are treated like other slash words, not as path claims | `FP fix: links without extension …` |
| 11 | wshobson-agents (1) | `[Toolkit](https://github.com/…) (`examples/protect-mcp-governed/`)` | A path after an external URL on the same line belongs to that other repo | `FP fix: path next to an external URL …` |
| 12 | found while writing tests | `vercel/next.js` (owner/repo slug) reported as a missing path | Two-segment `x/name.js` whose first folder does not exist is a slug | `owner/repo, branch names …` |

## Performance

- Test `performance: 5,000-file repo`: about 20 ms on this Mac (budget 300 ms). It has 5,000 source files, a 3,000-file node_modules that is never read, and a 100-line AGENTS.md.
- Real repos: 14.5k files in 311 ms including two `git` spawns. CD006 now uses one `git log` for all files instead of one `rev-list` per file. With 194 files the run went from 3.9 s to 0.44 s.

## Design decisions

- The engine skips silently when it cannot be sure: unparseable package.json, Makefiles with pattern rules or unresolvable includes, no manifest at all, `$(...)` in commands, placeholders, or negated / historical / "create this" context. Precision matters more than recall for a tool that people must trust in CI.
- Severities: CD001 strict forms (`npm run`, `pnpm run`, `make`, `just`, `task`, `cargo -p`) are **error**. Heuristic forms (bare `pnpm X` / `yarn X` / `bun X`, `uv run X`, cargo aliases) are **warning**. CI fails only on errors by default (`--fail-on`).
- `--format github` emits `::error` / `::warning` / `::notice` by severity (the lane asked for `::warning`; warnings use exactly that).
- Git hardening: `git -c core.fsmonitor=false log …`, read-only. In VS Code, git does not run in untrusted workspaces (`capabilities.untrustedWorkspaces: limited`).
- `files` was removed from package.json because vsce 3 refuses `files` together with `.vscodeignore`. `.npmignore` mirrors the exclusions for a later npm publish of the CLI.
- The icon was rendered from `icon.svg` with `rsvg-convert` (local, no browser).

## Not done / for the coordinator

- Not published, pushed or posted (as instructed). The repository URL `https://github.com/theluckystrike/context-drift` does not exist yet. README links point there.
- The extension was tested against a mocked `vscode` API (`test/extension.test.js`), not inside a real VS Code window.
- Ideas for later: CD001 for `pdm`/`hatch` scripts, `npm -w <name>` resolution by package name, a Ruby/Rust version check (`.ruby-version`, `rust-toolchain.toml`).
