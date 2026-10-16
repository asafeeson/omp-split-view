# omp-split-view

Split-view TUI plugin for [oh-my-pi](https://github.com/can1357/oh-my-pi).
Native OMP port of [pi-split-view](https://github.com/Hugo-W/pi-split-view).
Requires OMP **18.11.1 / 18.x**; no build step.

```text
╭ Thinking ─────────────────────────╮╭ Tool Usage ───────╮╭ Subagents ─────╮
│ live reasoning                    ││ running / result ││ #1 Reviewer    │
╰───────────────────────────────────╯╰───────────────────╯│ read · done   │
 transcript, or user + assistant text only                ├ Last Edit ───┤
                                                         │ diff preview │
 native OMP editor and status                             │              │
 compact files summary / command feedback                 ╰──────────────╯
```

## Install

From **this adapted checkout**, not the upstream `pi-split-view` npm package:

```sh
omp install .
omp
```

Restart an already-running OMP after installation or TypeScript source changes.
OMP's `/reload-plugins` refreshes plugin discovery, skills, commands and MCP;
it does not re-evaluate this extension's running TypeScript module.

In OMP:

```text
/split
/files
/split-trim-response on
/split-save
```

Without saved defaults, startup is bare. `/split` initially enables thinking
and tools; the independent subagents flag defaults off. `/split-save` makes
the current layout the next startup default.
Do not run `/split` immediately if your saved layout is already enabled:
the command is a toggle.

To try the source without installing:

```sh
omp -e ./split-view.ts
```

Use one loading route, not an installed copy plus an explicit `-e` copy.
If an older `pi-split-view` is installed, uninstall that package first:

```sh
omp plugin list
omp plugin uninstall pi-split-view
```

The local package name is `omp-split-view`. No npm release is published by
this adaptation; `omp install npm:pi-split-view` installs the old pi version,
not this port. Local installation links the checkout, so keep it on disk.
Consumers do **not** need `bun install`: native SDK/TUI modules come from OMP.

## Features

- **Thinking**: live reasoning, coalesced updates and bounded recent history.
- **Tools**: running/success/error status; compact or full arguments/output.
  Parent-session calls and results rebuild on resume and branch changes.
  Live native task-subagent events include agent badges, output and errors.
- **Subagents**: independent run groups in the right dock, ordered by start.
  Each run retains its last seven tool calls and separate agent/action states.
  History spans parent-session branches; resume marks unconfirmed activity
  unknown. The panel never shows agent thinking, messages or tool output.
  Late child events update their owning parent tree, not the selected session.
  Conflicting ownership evidence is not assigned to the current session.
  Unsaved run state stays in memory and is retried when its parent is selected;
  it is not crash-durable until the native journal append succeeds.
  Legacy task results with different parent calls remain distinct, even when
  runtime ID/index repeat; shared child history is not guessed per follow-up.
- **Files**: newest-first read/write/seen/subagent paths, plus edit diff.
  Native inline read selectors are removed from file names; non-file URLs
  and internal URIs are not treated as filesystem paths.
  Relative paths and `~` use OMP's resolver and the active workspace cwd.
- **Response-only**: native OMP message components showing user/assistant
  **text only**, without thinking, tool calls, images or custom transcript
  entries. Full history remains available; branch changes preserve numeric
  scroll position, clamped to the new document. Fresh startup follows tail.
- **Native input**: the actual OMP editor, status and dialogs remain mounted.
  Ctrl+R history search and native transcript shortcuts retain their owner.
  Split-view registers no competing Ctrl+O/Ctrl+T shortcut.
- **Resize/theme**: allocated terminal geometry, CJK/emoji-safe truncation,
  bounded panel caches, and native theme invalidation.

The older upstream screenshot remains a visual reference, not an OMP capture:

![Upstream pi layout reference](assets/screenshot-band-files.png)

## Commands

| Command | Effect |
| --- | --- |
| `/split` | All panels off; or restore saved flags. Empty defaults → thinking + tools. |
| `/split-thinking` | Toggle thinking in the top band. |
| `/split-tools` | Toggle tools in the top band. |
| `/split-tools-view` | Compact ↔ full tool detail. |
| `/split-tools-width <pct>` | Tools share of band, clamped to 20–60%; default 35. |
| `/files` | Toggle right files dock, including files-only layouts. |
| `/split-subagents [up\|down\|live]` | Toggle the run-history dock; page and resume live following. |
| `/split-trim-response [on\|off]` | Full native transcript ↔ text-only responses. |
| `/split-height <n>` | Band height, clamped to 6–40 rows; default 20. |
| `/split-save` | Persist current flags and geometry for future startups. |

PageUp/PageDown scroll the active transcript or response-only document.
The files and subagents dock hides below **90 columns**, retaining enabled
flags and view state. When both are on, the dock shares height; short sections
clip without changing file history. `/split-subagents up|down` pauses follow;
`/split-subagents live` resumes it. PageUp/PageDown remain transcript controls.
Command feedback remains visible below the editor in response-only mode.
Other native/custom transcript notices are intentionally excluded there;
turn response-only off to inspect the full transcript.

Toggles affect only the current process. Only `/split-save` writes config:
`<OMP agent dir>/ui-panels.json`, normally `~/.omp/agent/ui-panels.json`.
The native resolver follows named profiles and `PI_CODING_AGENT_DIR`.
The pi config at `~/.pi/agent/ui-panels.json` is not read or overwritten.

## OMP layout contract

OMP does not have pi's `tuiMode`, `HStack`/`VStack` layout engine or
`setLayoutRoot`. Do **not** pass `--tui-mode fullscreen` or add the old
`"tuiMode": "fullscreen"` setting.

Enabling any split-view panel borrows OMP's alternate screen through a native
fullscreen overlay. Closing the last panel restores the normal screen and
OMP's original history/frame provider. In split view, use PageUp/PageDown
instead of the terminal's normal-buffer scrollback.

`layout-manager.ts` reads the live native transcript/dock roots rather than
capturing a stale editor. Its narrowly scoped compatibility bridge excludes
only the split-view root from `TUI.hasOverlay()`'s modal gate; actual dialogs
still count as overlays. This preserves OMP's main-editor shortcuts. The
original method is restored when closing or replacing the layout.

The port targets OMP 18.x's native root/focus contracts. Simultaneous
interactive TUI contexts in one process remain unsupported. Transcript and
response history are not virtualized; only recent thinking/tool buffers and
panel caches are bounded. Print/RPC modes do not display terminal panels.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

`omp.extensions` loads only `split-view.ts`; the other source files are
helpers, not independently discovered extensions. Host packages are optional
peers and pinned development dependencies, preventing a consumer install
from fetching a second copy of the agent/native runtime.

## Отчёт об адаптации

**Причина первой ошибки:** upstream импортировал `generateDiffString` из
корня pi SDK. OMP подхватывает такой импорт через legacy-совместимость,
но нужного экспорта там нет: `Export named 'generateDiffString' not found`.
Замена только имени пакета не решала следующую проблему — отсутствующие
layout API и другой контракт `ScrollView`.

**Изменения и следствия:**

1. Пакет переведён на `omp.extensions` и native `@oh-my-pi/*`.
   Сообщения, темы, diff и пути инструментов используют реальные API OMP.
   Пустые default-export фабрики из helper-файлов удалены.
2. pi layout-root заменён fullscreen-композицией поверх OMP.
   Штатные editor/status/history не заменяются. Учтён modal gate:
   без адаптации `hasOverlay()` OMP блокировал Ctrl+R/Ctrl+O/Ctrl+T.
3. Поддержаны replace `old_string/new_string`, hashline `input`,
   patch-предпросмотр, авторитетный `details.diff`, inline read selectors
   и native task-события. Старый результат edit не затирает новый preview.
   Относительные пути разрешаются через native resolver и актуальный
   `ctx.cwd`, а не cwd процесса: read и edit одного файла не дают дубликат.
4. Resume, смена сессии/ветки и tree восстанавливают данные. Смена ветки
   не перескакивает в конец response-only. Конфиг хранится в активном
   OMP agent dir; сохранение создаёт отсутствующую директорию и сообщает
   об ошибке записи. Feedback команд виден даже со скрытым transcript.

**Проверка:** OMP 18.11.1, Bun 1.4.0, терминальный TUI через tmux.
Проверены установка checkout и установка упакованных sources без
`node_modules`, в отдельных HOME. Локальный детерминированный
OpenAI-compatible endpoint подавал stream; реальные OMP read/write/edit
меняли временные файлы. Проверены replace и default hashline, inline
selector, thinking/tool/output/diff, response-only, PageUp, resize
140→80→160 колонок, сохранение, restart/resume и native settings/theme.
Ctrl+R проверен до исправления modal gate и после него; Ctrl+O реально
переключает native tools-expanded state с false на true.
Отдельно выполнены relative read-selector и hashline edit с `--cwd`,
отличным от cwd запуска: один файл в dock, корректный diff и запись на диск.

Изолированный дочерний процесс регрессионного сценария использует
настоящий loader, TUI, editor, message-компоненты и EventBus OMP.
Он проверяет фильтрацию ответов, canonical file identity, ошибки субагентов,
конкурирующие edit results, геометрию, тему,
branch scroll offset, modal gating, feedback, сохранение и teardown.
`bun test` и `bun run typecheck` — команды воспроизводимой проверки.
Native Tern/TSP backend отдельно не проверялся.

## License

[MIT](LICENSE)
