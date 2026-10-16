# Repository Guidelines

## Project Overview

OMP (oh-my-pi) TypeScript extension providing a thinking/tools band, files and
subagent-history docks, and optional text-only response view. This checkout
adapts the upstream pi plugin to OMP; use OMP-native APIs and installation.

## Architecture & Data Flow

- `package.json` registers only `split-view.ts` under `omp.extensions`.
  Its extension setup registers commands, widgets, lifecycle listeners, and
  native task events; helpers are not standalone extensions.
- `split-view.ts` reconstructs thinking, tools, and response history from the
  selected session branch, and delegates Files state to `files-activity.ts`.
  Live SDK events update panel state; session/branch changes rebuild it.
- `files-activity.ts` owns Files history, Last Edit, branch reconstruction, and
  dock/summary rendering. History records attempted references, not confirmed
  changes. Only the newest live edit call owns its preview; replay restores
  recorded result diffs rather than previews or child frames.
- `layout-manager.ts` owns the fullscreen overlay, borrowing live native
  transcript/editor/dock roots. Preserve OMP's history/frame provider and focus
  ownership; resolve roots per frame rather than retaining stale editor roots.
  Closing the last panel restores normal screen ownership.
- `subagents-panel.ts` owns run history per parent session across branches.
  Native parent-journal snapshots and read-only child-journal recovery refine
  live task events. Preserve parent/run identity; runtime IDs alone are not
  unique. Failed or uncertain recovery remains partial/incomplete.
- `ui-panels-config.ts` normalizes config in the active OMP agent directory.
  Toggles are process-local; only `/split-save` persists startup defaults to
  `ui-panels.json`. Resolve the directory per operation for profile changes;
  leave pi's separate configuration untouched.

## Key Directories

- Source and co-located `*.test.ts` files live at repository root; there is no
  `src/`, generated build tree, or dedicated scripts directory.
- `assets/` contains packaged screenshots. The README screenshot is an upstream
  reference, not proof of the current OMP rendering.

## Development Commands

Run from repository root:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun test subagents-panel.test.ts
```

For interactive verification, install this checkout and launch OMP:

```sh
omp install .
omp
```

Restart OMP after TypeScript changes; `/reload-plugins` does not re-evaluate the
running extension module. Avoid loading the extension twice. There are no
build, lint, or standalone run scripts; OMP loads TypeScript directly.

## Code Conventions & Common Patterns

- Match existing TypeScript: tabs, semicolons, double quotes, explicit types;
  camelCase functions/variables, PascalCase types/classes, kebab-case filenames.
  Local module imports use `.ts` extensions.
- State uses module-local panel flags, buffers, timers, and render caches, plus
  `SubagentsPanel`'s session-scoped model. Keep buffers/caches bounded and
  coalesce streaming updates without delaying start/end visibility.
- Reuse native SDK/TUI components and shared `panel-utils.ts` helpers, including
  `fieldBag` for unknown payloads and theme-dependent fingerprints. Validate
  event/config boundaries; retain strict boolean checks and geometry clamps.
- Keep model dependencies injectable through the existing panel hooks for
  persistence, serialization, and refresh notifications; do not add a DI
  framework. Guard async restoration with disposal/generation checks.
- Dispose timers, input listeners, scroll views, and overlay hooks with their
  owner. Retain explicit save-failure results and incomplete-history states;
  uncertain recovery must not look successful. Persist bounded subagent
  metadata, not tool output, thinking, messages, or full arguments.

## Important Files

- `split-view.ts`, `files-activity.ts`, `layout-manager.ts`,
  `subagents-panel.ts`, `ui-panels-config.ts`: architecture boundaries above.
- `package.json`: extension discovery, published-file allowlist, commands, and
  OMP dependency versions. Include new runtime helpers in the allowlist.
- `tsconfig.json`: strict no-emit checking, ESNext, bundler resolution, and
  verbatim module syntax.
- `README.md`: installation, slash commands, layout contract, manual QA.
  `CONTEXT.md` records historical adaptation rationale.

## Runtime/Tooling Preferences

Use Bun for dependency installation and tests; retain `bun.lock`. No runtime
version is enforced through `engines`. The package is ESM; TypeScript emits no
build artifact. OMP peers require `^18.11.1`; development SDK packages are pinned
to `18.11.1`. Consumers receive native SDK/TUI modules from OMP, while checkout
development uses the declared dependencies.

Do not reintroduce pi's `tuiMode`, `setLayoutRoot`, or `--tui-mode fullscreen`.
Panels require interactive TUI mode, not Print/RPC; concurrent interactive TUI
contexts are unsupported.

## Testing & QA

- Tests use `bun:test`; run the full suite and typecheck separately. No coverage
  threshold or separate test-runner configuration is declared.
- `split-view.test.ts` exercises the real OMP extension loader, events, session
  manager, and TUI. Its subprocess isolates HOME/profile/agent-directory state
  because host registries are process-global; preserve that isolation.
- `files-activity.test.ts` exercises rendered Files views, path handling,
  edit-result ownership, replay, bounded history, and cache invalidation using
  real temporary files.
- `subagents-panel.test.ts` covers bounded history, ownership, persistence,
  failure recovery, and stale-session events using injected model dependencies.
  `ui-panels-config.test.ts` covers normalization and save/reload. Use temporary
  directories and clean them up rather than touching user profiles.
- For layout/input changes, exercise `/split`, `/files`, `/split-subagents`,
  `/split-trim-response`, PageUp/PageDown, native dialogs, resize/theme changes,
  and final-panel teardown in OMP. Docks hide below 90 columns without clearing
  state. Check session/branch switches for stale data and `/split-save` across
  restart for persistence changes. See README for detailed manual scenarios.
