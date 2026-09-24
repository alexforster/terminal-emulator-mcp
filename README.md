# terminal-emulator-mcp

A headless, interactive terminal MCP server for shells, REPLs, and TUIs. Agents can launch commands, inspect screen text and formatting, send keyboard or mouse input, resize terminals, and close sessions. Each session owns a real pseudoterminal and a headless xterm emulator.

## Install

Requires Node.js 24.16.0+ within Node 24, or Node.js 26.0.0 or newer, on macOS or Linux. These runtimes include a libuv fix for premature end-of-file reporting that can discard final terminal output. The server checks the supported range at startup; `--help` and `--version` remain available on older runtimes.

Install the preview from npm:

```sh
npm install --global --allow-scripts=node-pty \
  terminal-emulator-mcp@0.9.0
terminal-emulator-mcp --version
```

The examples explicitly approve `node-pty`'s native installation scripts on npm versions that support `--allow-scripts`. This approval is not a blanket deny policy for other packages. Older npm versions without the option can omit it.

## Add to Claude Code

```sh
claude mcp add --scope user --transport stdio terminal-emulator-mcp -- terminal-emulator-mcp
claude mcp get terminal-emulator-mcp
```

The user scope makes the server available across projects.

## Add to Codex CLI

```sh
codex mcp add terminal-emulator-mcp -- terminal-emulator-mcp
codex mcp get terminal-emulator-mcp
```

Start a new harness session and use `/mcp` to check the connection. The executable must be on the harness's PATH; an absolute executable path also works. An existing registration with the same name may need to be removed before changing its launch command.

## Run through npx

For an npx-based setup, use these add commands instead of the global-install configuration above:

```sh
claude mcp add --scope user --transport stdio terminal-emulator-mcp -- \
  npx --yes --allow-scripts=node-pty \
  --package=terminal-emulator-mcp@0.9.0 \
  terminal-emulator-mcp

codex mcp add terminal-emulator-mcp -- \
  npx --yes --allow-scripts=node-pty \
  --package=terminal-emulator-mcp@0.9.0 \
  terminal-emulator-mcp
```

The version pin makes startup reproducible. Use `terminal-emulator-mcp@preview` to follow preview releases; stable releases use npm’s `latest` tag. A first npx run may need to download packages or compile native code; a global installation completes that work before the harness starts its MCP connection.

## Native binaries

The pinned `node-pty` dependency ships prebuilt binaries for macOS x64/ARM64 and glibc-based Linux x64/ARM64. A compatible prebuild avoids a local compiler requirement. Other environments, including musl-based Linux distributions, may need an explicit source build with Python 3, `make`, a C/C++ compiler, and suitable Node headers. macOS source builds use Xcode Command Line Tools.

```sh
npm_config_build_from_source=true npm install --global --allow-scripts=node-pty \
  terminal-emulator-mcp@0.9.0
```

The server uses stdin/stdout for MCP messages and stderr for diagnostics. With no arguments it starts the stdio server; `--help` and `--version` print their output and exit. Commands run with the server's local permissions and inherited environment.

Node releases bundling libuv 1.52.x retain a separate hangup-handling defect that can truncate final terminal output. [The upstream fix](https://github.com/libuv/libuv/pull/5165) is included in libuv 1.53.0; a Node runtime carrying that release or the backported fix is needed to include both corrections.

Maintainers can use the [opt-in PTY output probe](https://github.com/alexforster/terminal-emulator-mcp/blob/main/docs/runtime-validation.md) to check a candidate Node runtime. Passing a probe run does not establish that the upstream defect is fixed.

## Tools and a typical session

| Tool | Required arguments | Result |
|---|---|---|
| `terminal_start` | `command`, `cols`, `rows` | Initial snapshot and `sessionId` |
| `terminal_snapshot` | `sessionId` | Current snapshot; optional `scrollbackLines` |
| `terminal_input` | `sessionId`, `actions` | `snapshot`, `actionsCompleted`, `inputSent` |
| `terminal_resize` | `sessionId`, `cols`, `rows` | Snapshot at the applied size |
| `terminal_list` | None | `sessions` with command, directory, size, and process status |
| `terminal_close` | `sessionId` | `{sessionId, closed}` |

For example, start Claude Code in a 120×40 terminal:

```json
{"command":"claude","cols":120,"rows":40,"cwd":"/absolute/path/to/project"}
```

`terminal_start` runs `[shell, "-l", "-c", command]` by default, loading the shell's login startup files while executing a noninteractive command. Pass `login:false` to use `[shell, "-c", command]`. The `-l` flag is supported by common shells such as Bash, Zsh, Dash, and Fish; it is a convention rather than a universal POSIX requirement. Login startup does not force interactive mode or guarantee that interactive-only files such as `.zshrc` are read.

Commands support the selected shell's quoting, pipelines, and redirection. The shell defaults to the server's nonempty `SHELL` variable, then `/bin/sh`; pass `shell` to override it. The initial working directory defaults to the server's directory. `env` overrides inherited variables, with `null` deleting a variable; login startup files can further change the environment or directory. `TERM` is fixed to `xterm-256color` and cannot be overridden through `env`.

Use the returned session ID to submit input:

```json
{
  "sessionId": "<returned ID>",
  "actions": [
    {"type":"text","text":"Explain this repository"},
    {"type":"key","key":"Enter"},
    {"type":"wait","durationMs":500}
  ]
}
```

Inspect the screen, send any follow-up actions, and close the session when finished. Batches preserve action order and share a per-session queue with resize operations. They do not automatically wait for the application to respond between actions; add a `wait` action or use separate calls when needed. Snapshots can run while a batch waits.

## Input actions

| Action | Fields | Behavior |
|---|---|---|
| `text` | `text` | Send the exact Unicode string |
| `paste` | `text` | Normalize line endings to carriage returns; use bracketed-paste markers when enabled |
| `key` | `key`, optional `modifiers` | Send a named key or one printable ASCII character |
| `mouse` click | `event:"click"`, `row`, `column`, optional `button`, `modifiers` | Send a press and, where supported, release |
| `mouse` scroll | `event:"scroll"`, `row`, `column`, `direction:"up"` or `"down"`, optional `count`, `modifiers` | Send one wheel report per step |
| `wait` delay | `durationMs` | Pause for a fixed duration |
| `wait` observation | Optional `settleMs`, `settleTimeoutMs`; no `durationMs` | Wait for screen settlement |
| `focus` | `focused` | Notify the application when focus reporting is enabled; otherwise no output |
| `raw` | `bytes` | Send integers from 0 through 255 without text encoding |

Named keys are `Enter`, `Tab`, `Backspace`, `Escape`, `Space`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `Delete`, and `F1`–`F12`. Keys and modifiers are case-sensitive. Unicode input belongs in `text` or `paste`.

Modifiers are `Ctrl`, `Alt`, and `Shift`, with no duplicates:

| Key family | Supported modifiers |
|---|---|
| Navigation and function keys | Any subset of the three modifiers |
| `Enter`, `Escape` | `Alt` only |
| `Tab` | `Shift` only |
| `Backspace`, `Space` | `Ctrl` and/or `Alt` |
| Printable ASCII | Optional `Alt`; supply the resulting character instead of `Shift` |
| Ctrl with ASCII | Letters, space, `@`, `[`, backslash, `]`, `^`, `_`, `?`; optional `Alt` |

Unsupported combinations fail before any batch input is sent. Traditional terminal encodings cannot distinguish all physical keys: Ctrl+I and Tab send the same byte. There are no key-up events, platform shortcuts, keypad modes, or extended keyboard protocols; `raw` provides explicit byte access.

Mouse coordinates are 1-based cells within the terminal. Buttons are `left` (default), `middle`, and `right`. Wheel count defaults to one and accepts 1–100. Mouse reporting must be enabled by the application. Legacy mouse encoding supports coordinates through 223; SGR cell encoding supports the configured screen dimensions. Pixel mode is rejected. X10 supports unmodified click presses only, without release or wheel reports. Dragging, pointer motion, clipboard access, and window-system shortcuts are outside scope. Wheel reports are application input; they do not scroll the emulator's history.

Encoding follows the application's modes at each action. Paste control characters remain unchanged, and focus actions count as complete even when reporting is disabled.

## Screens and formatting

Every snapshot has exactly `rows` screen strings, a cursor, a style legend, and spans over nondefault cells. Tool results include both structured data and readable text with numbered screen rows. Coordinates and span endpoints are 1-based; endpoints are inclusive. String offsets are not cell coordinates, particularly for wide or combining characters.

Readable spans use `row: column[-column]=styleId`, for example `1: 1-5=s1 8=s2`. Structured content retains the full span objects. The complete encoded result has an 8 MiB limit, including structured data and readable text. If a screen or requested history cannot fit, the tool returns `RESULT_TOO_LARGE` with no screen instead of truncating its styles or disconnecting the client.

An example snapshot at 8×2:

```json
{
  "sessionId":"<ID>",
  "status":"running",
  "cols":8,
  "rows":2,
  "buffer":"normal",
  "screen":["READY",""],
  "cursor":{"row":2,"column":1,"visible":true},
  "styles":{"s1":{"foreground":{"kind":"palette","index":2},"bold":true}},
  "spans":[{"row":1,"startColumn":1,"endColumn":5,"styleId":"s1"}],
  "mouse":{"tracking":"none","encoding":"legacy"},
  "settled":true
}
```

Colors use palette indices or RGB values such as `{"kind":"rgb","value":"#00ff80"}`. Other attributes include background, dim, italic, underline, blink, inverse, invisible, strikethrough, and overline. Missing attributes mean terminal defaults. Style IDs belong to one snapshot and may change between snapshots.

Leading whitespace and blank rows are preserved. Trailing unstyled spaces can be omitted; styled blank cells retain their spans. Concealed characters are represented as spaces. Styles report visual facts without labeling application semantics such as selection or errors.

`terminal_snapshot` accepts `scrollbackLines: 0`–`2000` (default zero). Requested history is returned separately as `{lines, availableLines}`, in chronological order, from the normal buffer even while an alternate screen is active. History is bounded and is not a complete process transcript.

## Settlement and recovery

Start, snapshot, input, and resize accept optional `settleMs` and `settleTimeoutMs`. Each observation begins a fresh quiet interval:

| Timing | Meaning |
|---|---|
| Omitted | Wait for 250 ms of visible quiet, capped at 1,000 ms; return `settled:true` or `false` |
| `settleMs:N` | Request N ms of quiet within the deadline |
| `settleTimeoutMs:T` | Require settlement within T ms; otherwise return `SCREEN_NOT_SETTLED` |
| `settleMs:0` | Flush received output when possible and capture without a quiet wait |

Visible text, styles, cursor position/visibility, active buffer, and size affect quiet detection. Identical repaints and changes confined to history do not reset it. Pending parsing and an application's synchronized redraw prevent settlement. At a deadline, the latest complete parsed screen is returned with `settled:false`. A zero quiet interval with a strict deadline still waits for parsing and synchronized redraw completion.

Quiet intervals and explicit delays accept integer milliseconds from 0–60,000. Strict deadlines accept 1–60,000 and must be at least the quiet interval (250 ms if omitted). Without a strict deadline, a quiet interval above 1,000 ms cannot finish before the default cap. The input operation's final-observation deadline begins after its batch completes; each observation-style `wait` has its own independent timing.

Settlement measures observed inactivity, not application completion. On a strict timeout, input and resize effects remain applied, and a newly started session remains available. MCP tool errors include a stable `code`, readable `message`, `sessionId` when allocated, and `latestSnapshot` when available.

An input result or operational failure includes `actionsCompleted` and `inputSent`. Completed actions include waits and no-op focus actions. `inputSent:true` means bytes were submitted to the terminal, not that the application consumed them. A failure inside an action also includes zero-based `failedActionIndex`. Check these fields and the latest screen before retrying; resending an already-submitted batch can repeat its effects. Invalid schema arguments can be rejected by MCP before reaching the tool handler.

`RESULT_TOO_LARGE` preserves the session ID, dimensions, process status, and any input progress, along with `resultBytes` and `limitBytes`. Applied input and resize effects remain in place. Recover by resizing the terminal or requesting fewer scrollback lines; the connection and session stay available. If an underlying operation also failed, `originalError` retains its code and message (up to 1,024 characters, with `messageTruncated:true` when needed). Error responses omit oversized snapshots explicitly. Missing-session input reports zero completed actions and no submitted input.

Tool argument objects are strict: unknown top-level fields, unknown action fields, and invalid timing relationships are rejected before mutation.

## Limits and cleanup

The server retains at most eight sessions, including exited sessions. Supported dimensions are 2–500 columns and 1–200 rows. Each batch contains 1–256 actions and at most 1 MiB of UTF-8 text, paste, and raw payload combined. Output parsing uses backpressure to bound its pending queue while preserving the process output stream.

A command's exit is a successful observation with `status:"exited"` and available `exitCode` or `signal`, including nonzero exits. Its final screen remains inspectable until close. Input and resize reject exited sessions. Unknown or already-closed IDs return `closed:false` from `terminal_close`.

Close cancels pending work, terminates the launched process group, allows a bounded grace period, escalates to `SIGKILL` when necessary, and disposes terminal resources. Ordinary descendants sharing the group are included; deliberately detached processes are outside session ownership. Disconnect, `SIGHUP`, `SIGINT`, and `SIGTERM` close all sessions. Abrupt server termination such as `SIGKILL` cannot run cleanup. Canceling an individual MCP request releases its wait without closing the session or retracting submitted input.

## Development

From a source checkout:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm pack --dry-run
```

The project records a version-specific installation-script approval for `node-pty` through `allowScripts`. Consumer installations use their own npm policy.

`npm pack` builds an artifact containing compiled runtime modules, package metadata, this README, and LICENSE. The executable is `dist/src/index.js`; installed packages do not require TypeScript or the source tree. CLI and MCP versions are read from the package manifest.

CI is configured for macOS and Linux with Node 24.16.0 and Node 26, including real terminal-process tests and package checks.

## Release automation

Dependabot checks npm dependencies and GitHub Actions weekly. The release App verifies that updates are semver-compatible and that all four CI jobs pass before merging them. Accepted dependency updates are collected into a separate patch-version pull request, which must also pass CI before the App merges it and creates its version tag. Breaking or unrecognized updates require manual review.

The App is installed only on this repository. Its ID is stored in the Actions variable `RELEASE_APP_ID`, and its private key in the Actions secret `RELEASE_APP_PRIVATE_KEY`. It needs contents, pull-request, and workflow write permissions, plus checks and commit-status read permissions. Branch protection requires up-to-date CI checks before merges.

The Publish workflow builds one tarball and tests that same artifact across the platform matrix. npm publication requires the repository variable `NPM_PUBLISH_ENABLED` to be exactly `true` and npm trusted publishing to be configured for this repository and `publish.yml`. With publication disabled, a valid version tag produces a draft GitHub Release labeled as unpublished to npm. A manual dry run validates the package without creating a release.

## License

[Apache-2.0](LICENSE).
