# Changelog

## 0.2.2 (2026-11-07)

- CD008 points at the right line in AGENTS.md files with Windows (CRLF) line endings. It counted 1 byte for each line ending instead of 2, so in a 39 KiB file it pointed about 25 lines too far down.
- `context-drift --version` prints the current version again (it still said 0.2.0).

## 0.2.1 (2026-11-07)

- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.

## 0.2.0 (2026-11-07)

- New rule CD007 (import drift). An `@path` import in `CLAUDE.md`, `CLAUDE.local.md` or `GEMINI.md` that points to a missing file is a warning. Claude Code and Gemini CLI skip a missing import without a warning, so those instructions never load. A quick fix offers the file with the same name when the repo has exactly one.
- New rule CD008 (Codex size limit). An `AGENTS.md` or `AGENTS.override.md` over 32 KiB is a warning on the line where Codex stops reading (`project_doc_max_bytes`).
- Context Drift now also checks `AGENTS.override.md` (Codex), `AGENTS.local.md` and `AGENT.md`, `.claude/rules/**/*.md` (Claude Code), `.devin/rules/**/*.md` (Devin Desktop, formerly Windsurf) and `.kiro/steering/**/*.md` (Kiro).
- Both new rules can be turned off with `contextDrift.ignoreRules`, `--ignore` or a disable comment, like the others.

## 0.1.11 (2026-11-07)

- The support line in the hover has a "Rate" link next to Sponsor and More free viewers. It opens the review page of this extension on the Marketplace. Nothing pops up and nothing asks you for a rating.

## 0.1.10 (2026-11-07)

- The "More free viewers" list and the README list now show the 15 Zovo extensions on the Marketplace under their current names, and 12 that are coming soon.
- Extensions for related files now come first, starting with Agent Skills & Claude Skills (Skill Shelf) and Claude Code Usage & Codex Usage Cost Meter.

## 0.1.9 (2026-11-06)

- The Marketplace page now starts with a screenshot of a real VS Code window with AGENTS.md findings in the Problems panel, and a short GIF of "Apply all" fixing 3 of them. Both were made from generated sample files. The images load from the GitHub repo and are not packed into the extension, so the download size stays the same.

## 0.1.8 (2026-11-06)

- The status bar tooltip ends with one small line with two links, "Sponsor" (GitHub Sponsors) and "More free viewers". The walkthrough gets a last step with the same two links. The new setting `contextDrift.showSupportLinks` (default `true`) hides both. There is no popup, and nothing is sent anywhere.
- New commands "Context Drift: Support the developer" and "Context Drift: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions.

## 0.1.7 (2026-11-06)

- Context Drift asks one time for a Marketplace rating. It counts each success (a check of your agent instruction files (one per folder per session)). After 5 of them, and no sooner than 2 days after the first, it shows a small message with "Rate it", "Later" and "Don't ask again". "Later" waits for 20 more, at most two more times. It never shows in your first session, more than once per session, when the window is not focused, or in a remote or untrusted workspace.
- New setting `contextDrift.askForRating` (default `true`) turns it off. Nothing is sent anywhere; "Rate it" only opens the review page in your browser.

## 0.1.6 (2026-11-06)

- Listing only, no change to the extension. The display name is now "AGENTS.md & CLAUDE.md Linter (Context Drift)" and the description is one sentence, so the listing uses the words people search for (agents.md (7), context drift (4)).
- The 30 keywords start with the most searched terms.
- The README ends with links to the other Zovo extensions.

## 0.1.5 (2026-11-06)

### Editor
- New quick fix "Apply all N Context Drift fixes in this file". It shows when a file has two or more one-click fixes (script, path or package manager) and applies them in one edit. It shows only while the file is unchanged since the last check (a document version check), so it never applies a fix at an old position. It leaves out a fix that overlaps another one.
- New walkthrough, "Get started with Context Drift", with four steps. Open it from the Welcome page or with "Context Drift: Get Started".

### Listing
- The README opens with one sentence, a picture rendered from real output, three benefits and a two-step quick start.
- 30 keywords instead of 11, all about the files and facts Context Drift checks.

### Other
- `context-drift --version` and the JSON output now report the right version (0.1.4 still said 0.1.3).

## 0.1.4

Plainer README and Marketplace wording. No code changes.

## 0.1.3 (2026-11-05)

Fixes from the third independent review.

### Rules
- *skip, omit, ignore, forget, fail to, without* after a negation make a requirement only when they govern the command directly ("Do not skip `npm run typecheck`", "Never commit without first running `npm run lint`"). "Do not skip tests by calling `npm run skip-tests`" and "Avoid skipping hooks with `npm run commit:nohooks`" are negated again. 0.1.2 reported them as CD001 errors.
- A comma followed by an imperative (*run, use, call, regenerate, …*) starts a new clause: "Never edit generated files, run `npm run codegen` instead" and "Instead of yarn, use `npm run boot`" are checked. So is the command after an opening "Instead of / Unlike / Rather than `X`," phrase, and an imperative after *and* that follows four or more words ("Do not push to main and run `npm run lint`"). Lists and "Do not, under any circumstances, run `X`" stay negated.

### Precision
- On the 184 local folders of the precision measurement, 0.1.3 gives the same 264 findings as 0.1.2, none added and none removed.

### Safety
- Text output escapes line breaks and tabs in file names and messages, so a folder name with a newline cannot print its own line (a forged `::error` workflow command) into a CI log.

### Tests
- The third review's 51 cases are regression tests, plus 10 more negation-scope cases and a CLI test with a newline folder name.
- The 1 MB ReDoS timing tests allow 250 ms of CPU per case (they take 1–50 ms, and the regressions they guard against took 5 s and more), so a busy machine no longer fails them.

## 0.1.2 (2026-11-05)

Fixes from the second independent review.

### Rules
- Negation is read per clause, not per sentence. "Never commit without running `npm run lint`", "Don't forget to run `npm run typecheck`", "Do not open a PR until `make check` passes" are now checked. So is a path after "There is no Docker setup and the entry point is …". "(the old script was removed)" after a command no longer hides it. Words after a command count only when the command is their subject.
- In CD002, *new*, *like*, *into*, *either*, *output* and *locally* hide a path only when they are within 4 words before it. "New API handlers go in `src/api/handlers.ts`" is checked.
- In CD002, `../` paths that climb above the opened folder are no longer reported as missing (a monorepo package opened on its own). They cannot be checked.
- On the 184-folder corpus used for 0.1.1, the warnings and errors are unchanged.

### Safety
- Work on a file stops at the 2,000-finding cap, and one `make` command checks at most 32 targets. A 1 MB file of `make a a a …` took 5 s, and now it takes about 40 ms. A run stops after 20 s and lists the files it did not check.
- A long line of `[a](` made the link parser quadratic (1 s per MB). It is now linear. At most 16 version claims are read per line.
- Diagnostic messages and the CLI's text and GitHub output escape control and bidi characters from the repo (`\u001b`, `\u202e`, …).

### Editor
- The 30 s budget for a check counts from when the worker starts it, not from when it was queued behind another folder.
- When another folder's check runs over budget and the shared worker restarts, the dropped checks run again instead of keeping old diagnostics.

### Packaging
- Factory bookkeeping files (`deletions-*.txt`, `FIX*.md`, `DONE*`) are excluded from the .vsix and the npm package.

## 0.1.1 (2026-11-05)

Safety, speed and precision fixes from an independent review.

### Safety
- Globs from the repository (inline code, `.mdc` `globs:`, `.gitignore`, Taskfiles) are no longer turned into regular expressions. A linear-time glob matcher replaces them. A 100-byte glob could hang 0.1.0.
- Every line regex is linear: version claims, links, Makefile, justfile, Taskfile and TOML lines. Inputs are capped at 1 MB per file, 4,000 characters per line, 200 globs and 20,000 code spans per file. A new test times each adversarial input from the review at 1 MB (under 50 ms each).
- The extension runs the engine and git in a worker thread, never on the extension host. A check that takes longer than 30 s is stopped.
- git runs only asynchronously, with a 3 s timeout per call, `--no-optional-locks`, `core.fsmonitor=false` and `log.showSignature=false`. A hung git is killed.
- A symlinked instruction file or manifest that points outside the workspace is not read.

### Editor
- Saving a file re-checks only when it is an instruction file or a manifest. The repository view is cached. Instruction edits reuse it, manifest changes re-read only manifests, and created or deleted files re-walk the folder.
- Closing a dirty instruction file without saving drops the diagnostics of the unsaved text.
- "Disable for this line" writes a YAML comment inside frontmatter (Cursor `.mdc`), and goes above the fence for code blocks ("Disable for this code block").
- Activates for nested `.cursor/rules/**`, `.clinerules/**`, `.windsurf/rules/**`, `.github/instructions/**`, and when a Markdown file opens.
- New setting `contextDrift.useGit`. `contextDrift.gitStaleness` now defaults to `false`.

### Rules
- CD001 is an error only for `npm run X`, `pnpm run X` and `make X` checked against the manifest in the right folder. Every other form is a warning.
- CD006 is off by default (`--stale`, `contextDrift.gitStaleness`).
- Fixed false positives for sparse checkouts, gitignored and build-output globs, directory globs, extensionless module paths, Windows paths, negation on the previous line and the word "no", "a file named X" and similar prose, placeholders such as `your_tool.py`, prompt-less output lines in shell blocks, `make` target listings, `$(eval)` Makefiles, targets in sub-Makefiles, scripts in a `package.json` above the opened folder, binaries named differently from their package, CD004 history and CI text, package-level `engines`, CD005 commands that run in different folders, skill paths relative to the plugin root, git submodules, runtime state files, import aliases and package export subpaths, and folders that only hold a copied instruction file (one "Not a project root" note instead).
- Directives count only as real HTML comments (or YAML comments in frontmatter), not inside code spans.

### CLI
- The README now documents the real install path, `npx -y github:theluckystrike/context-drift` or `node bin/context-drift.js`. There is no npm package.
- Files that are not checked (over 1 MB, symlinks that leave the folder, very long lines) are listed on stderr and are not counted as checked.
- New `--stale`, and `--no-git` now turns off every git call.

## 0.1.0 (2026-11-05)

First release.

- CD001 command drift checks npm/pnpm/yarn/bun scripts (nearest and root `package.json`, workspaces), `make` targets (with `include`, `-C`, `-f`), `just` recipes and aliases, Taskfile tasks, `cargo -p`/`--bin`/aliases, and `uv run`/`poetry run` scripts.
- CD002 path drift checks backticked paths and markdown links. Moved files get a "Did you mean" fix. Globs and Cursor `globs:` / Copilot `applyTo:` patterns that match nothing are reported as info.
- CD003 package-manager drift checks commands and prose against `packageManager` and the lockfile, with a replace quick fix.
- CD004 version drift checks Node, Python and Go claims against `.nvmrc`, `.node-version`, `engines`, `volta`, `.python-version`, `requires-python`, `go.mod` and `.tool-versions`.
- CD005 cross-file conflict finds different test/build/lint/format/dev/typecheck commands in instruction files of the same scope. CD006 stale file flags files older than 180 days with 50+ commits since (git, read-only).

The VS Code extension shows diagnostics on open, edit and save, and adds the "Context Drift: Check Workspace" command, a status bar count, quick fixes and `contextDrift.*` settings. The CLI `context-drift` has `--json`, `--format github`, `--fail-on`, `--ignore` and `--no-git`. Inline suppression uses `<!-- context-drift-disable-next-line CD00x -->` and `<!-- context-drift-disable CD00x -->`.
