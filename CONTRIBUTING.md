# Contributing to Grok Dictate

Thanks for wanting to help. This document is the short path from a clone to a reviewable change.

## Development setup

macOS on Apple Silicon, Node 20+, Xcode command-line tools.

```bash
npm install
./native/build.sh
npm run dev
```

On first launch, sign in with an xAI API key or a Grok CLI login.

```bash
npm test
npm run lint
npm run typecheck
./native/test.sh
```

`npm run package` builds the standalone `Grok Dictate.app` into `/Applications` and a zip in `release/`.

## How the repo is laid out

| Path            | What it is                                                       |
| --------------- | ---------------------------------------------------------------- |
| `contracts/`    | Frozen types every side of the app builds against                |
| `src/main/`     | Electron main process (state machine, STT, tray, auth)           |
| `src/renderer/` | HUD, Settings / History / Stats, sign-in, capture                |
| `src/shared/`   | Logger, redaction, constants                                     |
| `native/`       | Swift helper: hotkey tap + insertion ladder                      |
| `mocks/`        | Test doubles. The app itself does not use them at runtime        |
| `docs/`         | Architecture, permissions, and dated handoffs and reports        |
| `scripts/`      | Packaging and one-off dev scripts, not part of the app build     |
| `test/`         | End-to-end tests; most unit tests live next to their source file |

The state machine in `src/main/state/machine.ts` is a pure reducer. Prefer extending it with a new event and effect over reaching for Electron inside a test.

Comments across the codebase cite `IMPLEMENTATION-PLAN.md`, `braindump`, and dated phase reports (e.g. `docs/phase-2-report.md`, `docs/phase-3-report.md`) by section number — `§4.2`, `HT-13`, and so on. These are pre-open-source planning documents, written while the project was still private, and were deliberately not carried into the public repository. They are not missing by accident and should not be restored here. Where a comment cites one of these, the comment itself still carries the fact the citation was backing up, so the pointer is provenance, not a dependency for understanding the comment.

## Rules that are load-bearing

1. **The clipboard is written only on an explicit Copy click.** `Ctrl+Cmd+V` is re-insertion, not paste. `test/e2e/audit-5b.test.ts` greps for new pasteboard writes.
2. **Never log a token.** Go through `src/shared/logger.ts`. Do not add `console.*` in the app. Do not implement OAuth refresh against `~/.grok/auth.json`.
3. **The HUD must never take focus.** Changing `src/main/hud/flags.ts` means re-running the focus test.
4. **Unknown fields on a known protocol type are ignored**, not rejected. Do not repeat the “drop fields we did not model” bug.

## Pull requests

- One concern per PR.
- Add or extend a test for any behaviour change. The suite should stay runnable with `npm test` and no network.
- Match the surrounding comment style: short, factual, only for non-obvious constraints.
- Do not commit `grok-build/`, `out/`, `release/`, `node_modules/`, or anything from `~/.grok/`.

## Reporting a vulnerability

See [SECURITY.md](SECURITY.md). Please do not open a public issue for a token leak or a helper-privilege problem.
