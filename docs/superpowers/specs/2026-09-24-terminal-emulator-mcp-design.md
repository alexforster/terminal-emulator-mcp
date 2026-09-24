# Terminal Emulator MCP design

## Purpose and scope

Terminal Emulator MCP gives an agent access to interactive terminal applications through a local MCP server. An agent can launch a command at a specified terminal size, inspect its screen and formatting, send input, resize it, and close it. Representative applications include `claude`, `htop`, editors, and interactive command-line prompts.

The server owns its terminal sessions. A session survives individual tool calls and preserves its final screen when its command exits. Server shutdown closes all sessions. There is no separate daemon, browser, reconnect protocol, remote transport, image renderer, or platform clipboard integration.

## Global constraints

- Platforms: macOS and Linux.
- Runtime: Node.js 24.16.0 or newer within the 24.x line, or Node.js 26 or newer; TypeScript with strict checking and ESM output. These runtimes include the libuv 1.52 fix for premature PTY EOF.
- Runtime dependencies: `@xterm/headless` 6.0.0, `@modelcontextprotocol/sdk` 1.30.1, `node-pty` 1.2.0-beta.15, Zod 4, and SemVer 7.8.5.
- Transport: MCP over stdin/stdout; diagnostics go to stderr.
- Terminal coordinates: 1-based cells, with inclusive span endpoints.
- Default settling interval: `settleMs = 250`.
- Default best-effort observation deadline: 1,000 ms.
- An explicit `settleTimeoutMs` requires settlement and produces a tool error on timeout.
- All snapshots include visible text and a style map.
- Application code uses public dependency APIs; xterm's experimental public buffer/parser APIs are enabled explicitly and its version is pinned.
- Source line-length target: 120 characters; Markdown prose is not hard-wrapped.
- Tests use Node's built-in test runner; additional test frameworks and application frameworks are unnecessary.

Zod is a direct dependency because application code uses it to define the schemas registered with the MCP SDK. The native `node-pty` dependency may require the platform's compiler toolchain during installation.

## Architecture

Each session connects a `node-pty` process to an `@xterm/headless` terminal. Process output enters xterm's parser. Emulator-generated responses to terminal queries return to the process through xterm's `onData` event. Agent input enters the same process through an input adapter that translates named keys, paste, focus, and mouse actions into bytes.

The terminal session owns the process, emulator, output accounting, input ordering, observers, and disposal. A snapshot formatter reads terminal cells and produces a plain data object. An input module validates actions and encodes input using current terminal modes. The MCP layer defines schemas, dispatches operations, and formats tool results. There is no generic backend framework or terminal-provider abstraction.

Session IDs are opaque UUIDs. A small registry tracks sessions and enforces a maximum of eight open sessions, including exited sessions retained for inspection.

## Package and CLI

The package is Apache-2.0 licensed and declares macOS/Linux support. Package identity and version are read from `package.json` by a built-in-only metadata module shared by the CLI and MCP initialization. `--help`/`-h` and `--version`/`-v` print output and exit before loading server or native dependencies. Unknown CLI arguments fail with stderr diagnostics; no arguments start the stdio server. The distributed artifact includes compiled runtime modules, README, LICENSE, and package metadata.

## Command execution and lifecycle

`terminal_start` requires a nonempty `command`, `cols`, and `rows`. It executes a noninteractive login shell using `[shell, "-l", "-c", command]` by default. `login:false` selects `[shell, "-c", command]`. The shell defaults to the server's nonempty `SHELL` environment variable, falling back to `/bin/sh`; an explicit `shell` overrides it. The login flag is conventional in Bash, Zsh, Dash, and Fish, rather than guaranteed by POSIX. Login startup does not enable interactive mode or necessarily source interactive-only rc files. Commands retain the selected shell's quoting, pipelines, and redirection.

The initial working directory defaults to the server's working directory. The child inherits the server's environment, then receives requested overrides. An override value of `null` deletes a variable. `TERM=xterm-256color` is set by the server to match its emulator and cannot be overridden through `env`. Login startup files can subsequently change environment variables or the working directory. The server does not inject terminal-brand, color-depth, or pixel-size claims.

The child and emulator receive identical dimensions. Supported dimensions are 1–500 columns and 1–200 rows. Normal-buffer scrollback is limited to 2,000 lines. `terminal_resize` updates both components and lets the operating system notify the child of its new terminal size.

Exited sessions remain inspectable, with the last parsed screen, exit code, and signal where available. A command that exits unsuccessfully still yields a successful observation containing its exit status. Failure to create a process is a tool error. No input is accepted after exit.

Closing a session aborts its pending observers and queued actions, terminates its process group, waits a bounded grace period, and escalates to `SIGKILL` if necessary. The implementation must account for `node-pty.kill()` signaling only its direct child. Group cleanup covers ordinary descendants sharing the launched process group; deliberately detached processes are outside session ownership. Cleanup releases the emulator, listeners, timers, and registry entry. Closing an already-closed or unknown ID returns `closed: false`.

Graceful shutdown follows the same close path on transport disconnect, `SIGINT`, or `SIGTERM`. Abrupt termination such as `SIGKILL` cannot execute cleanup.

## MCP tools

| Tool | Arguments | Result |
|---|---|---|
| `terminal_start` | `command`, `cols`, `rows`, optional `shell`, `login`, `cwd`, `env`, and observation options | Initial snapshot containing the session ID |
| `terminal_snapshot` | `sessionId`, optional `scrollbackLines`, and observation options | Snapshot |
| `terminal_input` | `sessionId`, nonempty `actions`, and observation options | Snapshot and batch progress |
| `terminal_resize` | `sessionId`, `cols`, `rows`, and observation options | Snapshot |
| `terminal_list` | None | Session IDs, commands, working directories, dimensions, and process status |
| `terminal_close` | `sessionId` | Session ID and `closed` boolean |

An observation option applies to the snapshot returned by the operation. For input, its deadline begins after the batch has completed. A `wait` action inside a batch has its own independent timing.

Tool results contain structured data and a readable text representation. Snapshot text includes session status, numbered screen rows, a style legend, spans, cursor position, settling status, and requested history. MCP `tools/list` publishes the complete validated input vocabulary. Tool descriptions explain mode-dependent behavior, text versus paste, timeout effects, and examples.

## Snapshot contract

A snapshot contains:

- `sessionId`, `status` (`running` or `exited`), optional `exitCode` and `signal`.
- `cols`, `rows`, and `buffer` (`normal` or `alternate`).
- `screen`: exactly `rows` strings representing the live application screen.
- `cursor`: `row`, `column`, and `visible`.
- `styles`: style IDs mapped to nondefault cell attributes.
- `spans`: records containing `row`, `startColumn`, `endColumn`, and `styleId`.
- `mouse`: the active tracking mode and encoding.
- `settled`: whether this observation satisfied its settlement condition.
- Optional `history`: plain-text `lines` and `availableLines`, taken from normal-buffer scrollback.

Read screen rows at `buffer.active.baseY + rowOffset`. Leading whitespace and blank rows are preserved. Trailing unstyled spaces can be omitted because dimensions and spans retain their extent. Colored or otherwise styled blank cells retain style spans. Concealed characters are displayed as spaces. Wide and combining characters are read using xterm's cell widths; JavaScript string offsets are never treated as terminal columns.

Cursor positions are converted from xterm's zero-based coordinates. Its pending-wrap cursor can have `cursorX === cols`; report that cursor at the last column. Cursor blinking does not itself constitute a screen change; position and visibility do.

Style IDs are assigned deterministically in screen traversal order for each snapshot. Adjacent cells with equal attributes share one span. Default cells need no span. Attributes include foreground/background colors and true flags for bold, dim, italic, underline, blink, inverse, invisible, strikethrough, and overline. Colors use `{ kind: "palette", index }` or `{ kind: "rgb", value: "#rrggbb" }`; absence means the terminal default. Palette indices describe attributes rather than claiming a particular theme RGB value.

The formatter reports visual facts without assigning application semantics such as "selected" or "error." It returns complete screens; incremental diffs and style IDs stable across snapshots are outside scope.

`scrollbackLines` defaults to zero and accepts 0–2,000. Requested history contains the most recent available normal-buffer history lines in chronological order, separate from live-screen coordinates. It can be requested while the alternate buffer is active. History is bounded and may have evicted older output; it is not a complete process transcript.

## Output consistency and settlement

xterm parses writes asynchronously. Every received output chunk receives a sequence number and a `terminal.write(data, callback)` completion callback. Observers can wait for output already received at their observation boundary to finish parsing. `onWriteParsed` is useful as a notification but is not a queue-drained guarantee.

A quiet interval measures changes to visible characters, styles, cursor position/visibility, active buffer, or dimensions. Identical repainting and changes confined to scrollback do not reset it. Each observation starts a fresh quiet interval, so an input operation cannot return immediately merely because its preceding screen was old.

A screen is settled when the requested quiet interval has elapsed, received output has been processed, and synchronized-output mode is inactive. That mode allows a terminal application to bracket a multi-part redraw; xterm's public `modes.synchronizedOutputMode` exposes it. If the mode remains active, the observation remains unsettled.

Timing is:

| Request | Behavior |
|---|---|
| Omit timing options | Wait for 250 ms of quiet, up to 1,000 ms; return a snapshot with `settled: true` or `false` |
| `settleMs: N` | Require N ms of quiet within the observation's deadline |
| `settleTimeoutMs: T` | Use T ms as the deadline and return `SCREEN_NOT_SETTLED` if settlement is not achieved |
| `settleMs: 0` | Skip the quiet-period wait; flush received output when possible and capture the screen |

`settleMs` accepts 0–60,000 and `settleTimeoutMs` accepts 1–60,000, both as integer milliseconds. An explicit strict deadline must be at least the requested quiet interval. Without a strict deadline, a quiet interval longer than 1,000 ms is valid but cannot be satisfied before the default cap.

The deadline includes parser-drain waiting. At a deadline, return the latest complete parsed snapshot, marked unsettled, even if received output remains queued. With `settleMs: 0` and no strict deadline, a snapshot during synchronized output returns immediately and is marked unsettled. With an explicit strict deadline, a zero quiet interval still waits for parsing and synchronized output to finish, up to that deadline. Never label a partially processed or synchronized redraw as settled.

Settlement describes observed inactivity, not application completion. An animation with gaps longer than `settleMs` can satisfy it. A strict failure retains the session and includes the latest snapshot.

The process output stream is never discarded merely because it exceeds the scrollback limit. Pending unparsed output uses backpressure: pause PTY reads at 1 MiB and resume at 256 KiB. This prevents an output-heavy process from building an unbounded xterm write queue.

## Input vocabulary

Actions form a tagged union. The entire batch is structurally validated before any input is sent. A batch contains at most 256 actions and at most 1 MiB of text/raw input in total. Named keys and modifiers are case-sensitive. Duplicate modifiers are invalid.

| Type | Fields | Behavior |
|---|---|---|
| `text` | `text: string` | Submit the exact Unicode string without paste wrapping or key-name interpretation |
| `paste` | `text: string` | Normalize line endings to carriage returns and wrap in bracketed-paste markers when enabled |
| `key` | `key`, optional `modifiers` | Encode a supported named key or printable ASCII character |
| `mouse` | `event: "click"`, `row`, `column`, optional `button`, `modifiers` | Send a press and, when requested by the tracking mode, release |
| `mouse` | `event: "scroll"`, `row`, `column`, `direction: "up" or "down"`, optional `count`, `modifiers` | Send one wheel report per step |
| `wait` | `durationMs` | Delay for 0–60,000 ms |
| `wait` | Observation options, excluding `durationMs` | Wait for screen settlement using the observation contract |
| `focus` | `focused: boolean` | Send a focus notification if the application enabled reporting; otherwise complete without output |
| `raw` | `bytes: number[]` | Submit integers in the range 0–255 without text encoding |

Mouse buttons are `left`, `middle`, and `right`, defaulting to `left`. Scroll count defaults to one and accepts 1–100. Modifiers are drawn from `Ctrl`, `Alt`, and `Shift`.

Mode-dependent encoding is evaluated when each action executes, after pending received output has been processed. A batch preserves action order but does not insert waits between actions automatically. Agents use `wait` or separate input calls when the application must respond before subsequent input.

### Keyboard encoding

Named keys are `Enter`, `Tab`, `Backspace`, `Escape`, `Space`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `Delete`, and `F1` through `F12`. A single printable ASCII character is also valid. Arbitrary Unicode belongs in `text` or `paste`.

For navigation and function keys, all subsets of the three modifiers are supported. Let `m = 1 + Shift + 2*Alt + 4*Ctrl`, with each modifier valued at zero or one:

| Keys | Unmodified encoding | Modified encoding |
|---|---|---|
| Up, Down, Right, Left | `ESC [ A/B/C/D`, or `ESC O A/B/C/D` in application-cursor mode | `ESC [ 1 ; m A/B/C/D` |
| Home, End | `ESC [ H/F`, or `ESC O H/F` in application-cursor mode | `ESC [ 1 ; m H/F` |
| Insert, Delete, PageUp, PageDown | `ESC [ n ~`, with n = 2, 3, 5, 6 | `ESC [ n ; m ~` |
| F1–F4 | `ESC O P/Q/R/S` | `ESC [ 1 ; m P/Q/R/S` |
| F5–F12 | `ESC [ n ~`, with n = 15, 17, 18, 19, 20, 21, 23, 24 | `ESC [ n ; m ~` |

Spaces in the sequence notation above are explanatory separators, not emitted bytes.

Simple keys and characters use an explicit whitelist:

| Key | Supported modifiers and encoding |
|---|---|
| Enter | None: CR; Alt: ESC followed by CR |
| Tab | None: TAB; Shift: `ESC [ Z` |
| Backspace | None: DEL; Ctrl: BS; Alt may prefix either with ESC |
| Escape | None: ESC; Alt: two ESC bytes |
| Space or literal space | None: space; Ctrl: NUL; Alt may prefix either with ESC |
| Printable ASCII | Literal character; optional Alt prefix |
| Ctrl with ASCII | Letters A–Z, case-insensitively, map to bytes 1–26; space or `@` maps to NUL; `[` to ESC; backslash to 28; `]` to 29; `^` to 30; `_` to 31; `?` to DEL; optional Alt prefix |

Reject combinations outside this whitelist instead of silently dropping modifiers. Shift on printable characters is unsupported: the caller supplies the resulting character, such as `A` or `!`, avoiding keyboard-layout assumptions. Traditional encodings cannot distinguish all physical keys; for example, Ctrl+I and Tab share a byte. There is no automatic support for platform shortcuts, key-up events, keypad modes, or extended keyboard protocols; `raw` provides explicit protocol access.

### Mouse, paste, and focus

Use `terminal.modes.mouseTrackingMode` to determine whether mouse input is enabled. Support legacy byte encoding and SGR cell encoding. Legacy coordinates are limited to 223; SGR accepts coordinates within the configured screen. Reject coordinates outside the screen, disabled reporting, SGR pixel mode, and wheel input or modified clicks under X10 tracking. X10 sends unmodified presses only; other supported tracking modes send click press/release pairs. Wheel actions are application input and do not scroll the emulator's history.

Observe DEC private mode changes through public parser callbacks returning `false` so xterm still handles them. Track SGR cell mode 1006 and SGR pixel mode 1016, processing compound mode parameters in order. Resetting either encoding mode selects legacy encoding, matching the pinned xterm implementation. Full reset restores legacy encoding; soft reset preserves it. Unsupported UTF-8 and urxvt mouse encodings are not advertised.

The same observer tracks cursor visibility mode 25 because headless 6.0.0 has no public visibility getter. Match the pinned emulator's behavior: the initial cursor is visible; explicit mode changes update it; soft reset reveals it; full reset preserves its visibility. Tests protect this version-specific behavior. No private xterm fields are accessed.

Headless 6.0.0 has no public paste helper. The input adapter implements line-ending normalization and the `ESC [ 200 ~` / `ESC [ 201 ~` markers according to `modes.bracketedPasteMode`. Embedded escape sequences and other control characters remain unchanged, matching the pinned browser implementation. Focus uses `modes.sendFocusMode` and emits `ESC [ I` or `ESC [ O` when enabled.

Dragging, pointer motion, pixel coordinates, window-system shortcuts, and clipboard reads/writes are outside scope.

## Ordering, errors, and cancellation

Batches and resizes are serialized within each session. Observations can proceed while a batch is waiting. Different sessions operate independently. Close takes precedence over pending waits and stops queued mutations. A canceled tool request releases its observer and timers without closing the terminal or retracting input already submitted.

Successful input results include `actionsCompleted` and `inputSent` alongside the snapshot. `actionsCompleted` counts completed actions, including waits and focus no-ops. `inputSent` becomes true once an action submits bytes to the PTY; it does not claim the application has consumed them.

Operational failures use MCP tool errors (`isError: true`) with a stable `code`, readable `message`, `sessionId` when allocated, and the latest snapshot when available. An input failure also includes `actionsCompleted`, `inputSent`, and `failedActionIndex` when failure occurred in an action; the index is zero-based and is not a terminal coordinate.

Error codes include `SESSION_NOT_FOUND`, `SESSION_EXITED`, `SESSION_CLOSED`, `SESSION_LIMIT`, `SPAWN_FAILED`, `INVALID_INPUT`, `UNSUPPORTED_INPUT`, `SCREEN_NOT_SETTLED`, `REQUEST_CANCELLED`, and `IO_ERROR`. Invalid schema arguments can be rejected by MCP validation before reaching the handler.

A strict timeout after input or resize does not undo that operation. Error text explicitly states the applied effect. A timeout after start contains the allocated session ID so the process remains discoverable. Unknown actions and unsupported static key combinations are rejected before the batch begins; state-dependent failures, such as mouse reporting being disabled at execution time, can occur after earlier actions and report that progress.

## Verification

Tests exercise externally meaningful behavior using Node's test runner and small controlled child programs:

- Screen extraction: indentation, blank rows, styled blank cells, deduplicated spans, wide and combining characters, concealed cells, cursor state, alternate buffer, and bounded history.
- Parser correctness: split escape sequences, asynchronous writes, terminal query responses, mode transitions, compound mouse-mode parameters, and reset behavior.
- Input: every named-key encoding family, modifier validation, exact text, paste delimiters/newlines, binary bytes, mouse press/release/wheel protocols, and focus reporting.
- Settlement: default 250 ms, identical repaints, visible style/cursor changes, parser backlog, synchronized redraws, strict deadlines, immediate reads, cancellation, and retained snapshots on timeout.
- Sessions: controlled login-profile loading and opt-out, noninteractive shell mode, requested dimensions and environment, resize notification, final output before exit, nonzero exit status, ordered batches, partial progress, concurrent observation, limits, backpressure, and process-group cleanup.
- MCP: tool discovery exposes the complete action union and enums, results are readable and structured, partial-action errors are unambiguous, and stdin/stdout carry valid MCP traffic.
- Packaging: dependency-free help/version, shared manifest identity, and a built executable can be launched by an MCP client, has no source-tree dependency, and keeps logs off stdout.

Automated checks run on macOS and Linux. Local acceptance requires registering the built MCP server in both installed Codex and Claude harnesses and verifying that each can launch, inspect, interact with, and close an `htop` session through the server. Registration preserves unrelated harness configuration. These real-harness checks use the user's existing installations and authentication; they are not dependencies of the automated suite.

## Dependency references

- [xterm 6.0.0 headless API](https://github.com/xtermjs/xterm.js/blob/6.0.0/typings/xterm-headless.d.ts)
- [xterm keyboard conventions](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/common/input/Keyboard.ts)
- [xterm mouse encodings](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/common/services/CoreMouseService.ts)
- [node-pty 1.2.0-beta.15](https://registry.npmjs.org/node-pty/1.2.0-beta.15)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
