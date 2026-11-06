# Fix a finding

Put the cursor on a squiggle and press `Ctrl+.` (`Cmd+.` on macOS).

| Finding | Quick fix |
| --- | --- |
| `npm run buidl`, script missing | Replace with "build" |
| `pnpm install` in an npm repo | Replace `pnpm` with `npm` |
| `src/server/main.ts` moved | Replace with "src/main.ts" |
| Any finding | Disable for this line, or ignore the rule in this workspace |

When a file has two or more one-click fixes, the menu also shows "Apply all N Context Drift fixes in this file".
