# Context Drift: measurement notes

## 0.1.1 (2026-11-05): after the independent review of 0.1.0

The review found one P0 (a short glob in a repo could hang the engine), six P1s and seventeen P2s. 0.1.0 also had a 78 % false-positive rate on real source repos. These numbers come from the reviewer's own scripts and folders, re-run against 0.1.1. Local folder names are left out on purpose.

### Real source repositories from the review (CLI, git on)

| Repo | 0.1.0 | 0.1.1 |
| --- | --- | --- |
| webdriverio checkout (50 instruction files) | 11 findings, all false (gitignored globs, a folder glob, negation on the previous line, `./utils`) | 0 |
| promptbook (sparse checkout) | 4 true, 2 false (a file in the git index but not on disk, an example file name) | the same 4 true, 0 false |
| a small CLI repo | 1 false ("a file named `X`") | 0 |
| **Total** | **4 true, 14 false (78 % false)** | **4 true, 0 false** |

Other folders from the same table:
- Two folders that hold only a copied AGENTS.md: 9 and 31 warnings before. Now each gets one info, "Not a project root".
- A 194-file repo: 194 CD006 notes before. Now 0, because CD006 is off by default.
- Eight more repos: 0 findings before and after.
- Five folders on an iCloud-synced Desktop were not re-run: reading them can trigger downloads. They had no findings in the review.

### Corpus: 184 folders, 3,629 instruction files (git off, as in the review)

| Rule | 0.1.0 | 0.1.1 |
| --- | --- | --- |
| CD001 | 31 (5 true, 26 false) | 6 (5 true, 1 false: `make deploy` that runs from a workspace root outside the repo) |
| CD003 | 24 (23 true, 1 false) | 23 (the same 23 true lines; `npm install <this package>` is no longer reported) |
| CD004 | 8 (3 true, 5 false) | 3 (3 true) |
| CD005 | 4 | 0 (the 2 that were left in the last round came from a `.github/AGENTS.md` about CI, which is now its own scope) |
| CD002 warnings | 921 (review sample: 6 true, 9 false of 15) | 224 |
| CD002 info | about 170 | 6 (4 "Not a project root", 2 alias targets that do not exist) |

- **CD002 precision.** The reviewer's deterministic sampler (15 items) now gives:
  - 5 true;
  - 9 "technically true": the instruction file was copied into a folder without the source, or is an installed extension's or plugin bundle's copy;
  - 1 false: a path in another npm package.

  A separate random sample of 40 gives 15 true, 21 technically true and 4 false:
  - a skill that describes a hypothetical skill;
  - a file that exists only during a release;
  - a per-user preferences file;
  - a line that continues from the previous line.
- **Estimated false-positive rate over all findings:** about 9 %.
- No crashes. The slowest folder took 0.4 s.

### The reviewer's 48 adversarial cases

- 0.1.0: 23 OK, 24 false positives, 1 false negative.
- 0.1.1: 48 OK.
- `test/fp-regressions.test.js` turns every one of these false-positive classes, and the classes found in the corpus, into a regression test.

### Safety

The reviewer's `redos.js` end-to-end inputs:

| Input | 0.1.0 | 0.1.1 |
| --- | --- | --- |
| glob `*a` ×40 | over 20 s from ×6 | 11 ms |
| `**/` ×100 | over 20 s from ×12 | 5 ms |
| `.gitignore` `*a` ×40 | over 20 s | 11 ms |
| `.mdc` glob | over 20 s | 4 ms |
| 1 MB version line | over 20 s | 5 ms |
| 1 MB link line | over 20 s | 6 ms |
| 1 MB backticks | 1.5 s | 5 ms |
| 1 MB pyproject, justfile, Makefile lines | over 20 s | 7–14 ms |

- `test/redos.test.js` builds about 1 MB of each adversarial input, with lines just under the 4,000-character cap so the parsers really run. Every case must finish in under 50 ms of CPU time.
- In the mock-`vscode` harness:
  - Saving a source file five times starts no check.
  - A manifest save re-reads only the manifests.
  - The engine never runs on the extension host thread; it runs in `src/worker.js`.
  - A `git` that hangs is abandoned after 3 s (`test/extension-events.test.js` uses a fake `git` that sleeps).

### Design decisions in 0.1.1

- **Precision over recall.**
  - When the tool cannot tell, it says nothing: sparse checkouts without git, a skill that ships no `scripts/` folder, globs whose first folder exists nowhere, text that says something is generated, stored, named, deprecated or elsewhere.
  - The cost is some lost true findings. One example: a skill that names a bundled file it never shipped is no longer reported when the skill has no bundle folder at all.
- **"Not a project root".** The folder is not a git repository root and has no manifest, at least 3 referenced paths are missing, and at least half of them are. A strict "no git and no manifest" rule would hide true findings in small test repos (review case 30).
- **CD001 severity.**
  - Error: only `npm run X`, `pnpm run X` and `make X` checked against the manifest in the folder the command runs in.
  - Warning: everything else, including `npm test` and `npm start`.
- **git use.**
  - Read-only: `check-ignore`, `ls-files`, and `log` for CD006.
  - Asynchronous only, 3 s per call, never in untrusted workspaces.
  - The synchronous `analyzeWorkspace` API never runs git.
- **CLI.** Not on the npm registry. The README documents `npx -y github:theluckystrike/context-drift` and `node bin/context-drift.js`. Both forms were tested: `npm pack` + `npx --package=./context-drift-0.1.1.tgz` runs 0.1.1, and `npx -y github:theluckystrike/context-drift` ran the published 0.1.0 from GitHub. The GitHub Action snippet pins `#v0.1.1`, so the `v0.1.1` tag must be pushed with the release.

### Not done

- The extension was tested against a mock `vscode` API, not in a real VS Code window.
- The `make deploy` false positive above (a Makefile that lives outside the repo, without a phrase such as "workspace root" in the sentence) is still reported as a warning.
