# Terminal Emulator MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local MCP server through which agents can launch, inspect, and interact with persistent VT terminal sessions.

**Architecture:** A terminal model wraps headless xterm, owns parser-completion accounting, and produces styled screen snapshots. A session owns that model and a pseudoterminal process, translating ordered input actions through a small protocol encoder. Six MCP tools expose sessions through schemas that also describe the complete input vocabulary.

**Tech Stack:** TypeScript, Node.js, `@xterm/headless`, `@modelcontextprotocol/sdk`, `node-pty`, Zod, SemVer, and Node's built-in test runner.

**Spec:** [Terminal Emulator MCP design](../specs/2026-09-24-terminal-emulator-mcp-design.md). Read the complete spec before executing this plan; the keyboard encoding tables and error semantics are part of the implementation contract.

## Global Constraints

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

Additional exact limits from the spec: eight open sessions, 2–500 columns, 1–200 rows, 2,000 scrollback lines, 256 actions per batch, 1 MiB of encoded text/raw input per batch, 8 MiB per encoded tool result, and 100 wheel steps per action. Pause PTY reads at 1 MiB of pending output and resume at 256 KiB. Timing options accept integer milliseconds; quiet intervals and explicit delays are at most 60,000 ms, and strict deadlines are between 1 and 60,000 ms.

## Files and responsibilities

| File | Responsibility |
|---|---|
| `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore` | Dependency/build configuration and packaging boundaries |
| `src/keys.ts` | Named-key vocabulary, static modifier validation, and conventional key encoding |
| `src/contracts.ts` | Zod argument/action schemas, inferred request types, shared result types, and error codes |
| `src/snapshot.ts` | Read cell text/attributes and format screen, styles, cursor, and history |
| `src/terminal.ts` | Own headless xterm, parser observers, output accounting, input modes, and observation timing |
| `src/input.ts` | Convert validated non-wait actions into bytes using current terminal modes |
| `src/session.ts` | Own the pseudoterminal and model, process cleanup, ordered mutations, batch progress, and session registry |
| `src/server.ts` | Register MCP tools, route calls, and convert data/errors to MCP results |
| `src/package-info.ts` | Shared package identity and version from the distributed manifest |
| `src/index.ts` | CLI help/version, executable entry point, stdio transport, and shutdown |
| `test/*.test.ts`, `test/fixtures/terminal-child.ts` | Focused behavioral tests and controlled terminal child |
| `README.md`, `.github/workflows/ci.yml` | Installation/use documentation and cross-platform verification |

Do not create generic transport, process-provider, event-bus, or dependency-injection frameworks. Small pure functions and one terminal/session owner are sufficient. Add a helper file only when it removes a concrete cycle or gives a substantial unit an independent responsibility.

## Shared interfaces

Define these interfaces in the indicated tasks. They are the dependency contract between implementation units.

```ts
// src/keys.ts — Task 2
export const MODIFIERS = ["Ctrl", "Alt", "Shift"] as const;
export type Modifier = (typeof MODIFIERS)[number];
export function encodeKey(key: string, modifiers: readonly Modifier[], applicationCursorKeys: boolean): string;
// Throws for unsupported static combinations; schemas reuse this validation.

// src/contracts.ts — Task 1 types; Task 2 schemas
export interface ObservationOptions {
  settleMs?: number;
  settleTimeoutMs?: number;
}
export type MouseTracking = "none" | "x10" | "vt200" | "drag" | "any";
export type MouseEncoding = "legacy" | "sgr" | "sgr-pixels";
export interface InputModes {
  cols: number;
  rows: number;
  applicationCursorKeys: boolean;
  bracketedPaste: boolean;
  focusReporting: boolean;
  mouseTracking: MouseTracking;
  mouseEncoding: MouseEncoding;
}
export interface CellStyle {
  foreground?: { kind: "palette"; index: number } | { kind: "rgb"; value: string };
  background?: { kind: "palette"; index: number } | { kind: "rgb"; value: string };
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  blink?: true;
  inverse?: true;
  invisible?: true;
  strikethrough?: true;
  overline?: true;
}
export interface ScreenState {
  cols: number;
  rows: number;
  buffer: "normal" | "alternate";
  screen: string[];
  cursor: { row: number; column: number; visible: boolean };
  styles: Record<string, CellStyle>;
  spans: Array<{ row: number; startColumn: number; endColumn: number; styleId: string }>;
  mouse: { tracking: MouseTracking; encoding: MouseEncoding };
  history?: { lines: string[]; availableLines: number };
}
export interface ObservedScreen extends ScreenState { settled: boolean }
export interface TerminalSnapshot extends ObservedScreen {
  sessionId: string;
  status: "running" | "exited";
  exitCode?: number;
  signal?: number;
}
export interface BatchProgress {
  actionsCompleted: number;
  inputSent: boolean;
  failedActionIndex?: number;
}
export interface SessionInfo {
  sessionId: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  status: "running" | "exited";
  exitCode?: number;
  signal?: number;
}
export type ErrorCode =
  | "SESSION_NOT_FOUND" | "SESSION_EXITED" | "SESSION_CLOSED" | "SESSION_LIMIT"
  | "SPAWN_FAILED" | "INVALID_INPUT" | "UNSUPPORTED_INPUT" | "SCREEN_NOT_SETTLED"
  | "REQUEST_CANCELLED" | "IO_ERROR" | "RESULT_TOO_LARGE";
export interface ErrorDetails extends Partial<BatchProgress> {
  sessionId?: string;
  latestSnapshot?: TerminalSnapshot;
}
export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: ErrorDetails = {},
  ) {
    super(message);
    this.name = "ToolError";
  }
}

// src/terminal.ts — Tasks 1 and 3
export class TerminalModel {
  constructor(cols: number, rows: number);
  write(data: string): void;
  drain(signal?: AbortSignal): Promise<void>;
  capture(scrollbackLines?: number): ScreenState;
  getInputModes(): InputModes;
  resize(cols: number, rows: number): void;
  observe(options?: ObservationOptions, scrollbackLines?: number, signal?: AbortSignal): Promise<ObservedScreen>;
  onResponse(listener: (data: string) => void): () => void;
  onPendingBytes(listener: (bytes: number) => void): () => void;
  dispose(): void;
}
// observe returns settled:false at its deadline. The session converts that
// outcome into SCREEN_NOT_SETTLED when settleTimeoutMs was explicit.

// src/input.ts — Task 2
export function encodeInput(action: Exclude<InputAction, { type: "wait" }>, modes: InputModes): Buffer;
// InputAction is inferred from InputActionSchema in src/contracts.ts.

// src/session.ts — Tasks 4 and 5
export interface BatchResult extends BatchProgress { snapshot: TerminalSnapshot }
export class Session {
  static start(options: StartOptions): Session;
  info(): SessionInfo;
  snapshot(options?: ObservationOptions, scrollbackLines?: number, signal?: AbortSignal): Promise<TerminalSnapshot>;
  input(actions: InputAction[], options?: ObservationOptions, signal?: AbortSignal): Promise<BatchResult>;
  resize(cols: number, rows: number, options?: ObservationOptions, signal?: AbortSignal): Promise<TerminalSnapshot>;
  close(): Promise<void>;
}
export class SessionRegistry {
  start(options: StartOptions): Session;
  get(sessionId: string): Session;
  list(): SessionInfo[];
  close(sessionId: string): Promise<boolean>;
  closeAll(): Promise<void>;
}
// StartOptions is inferred from StartSchema; it includes optional observation
// options, although Session.start itself only allocates the session.

// src/server.ts — Task 6
export function createServer(registry: SessionRegistry): McpServer;
```

These declarations describe interfaces to implement, not a separate declaration-only file. Do not check in inert stubs merely to satisfy a future task.

## Task 1: Build the headless screen model

**Files:** Create build/package configuration, `src/contracts.ts` result types, `src/terminal.ts`, `src/snapshot.ts`, and `test/terminal.test.ts`.

**Consumes:** The pinned headless API and the spec's snapshot contract.

**Produces:** `TerminalModel` constructor, `write`, `drain`, `capture`, `getInputModes`, `resize`, `onResponse`, `onPendingBytes`, and `dispose`; `ScreenState`, `InputModes`, result types, and `ToolError`. Observation timing is implemented in Task 3.

- [x] **Create the configuration needed to execute the first behavior test.** Install the exact runtime versions and development tools. Keep source and tests under one TypeScript compilation root, with output in `dist/`; package only `dist/src`.

```sh
npm install --save-exact @xterm/headless@6.0.0 @modelcontextprotocol/sdk@1.30.1 node-pty@1.2.0-beta.15 zod@4
npm install --save-dev typescript @types/node@22
```

Use these package fields, adding dependencies from the commands rather than copying transitive dependencies:

```json
{
  "name": "terminal-emulator-mcp",
  "version": "0.9.0",
  "type": "module",
  "engines": { "node": "^24.16.0 || >=26.0.0" },
  "bin": { "terminal-emulator-mcp": "dist/src/index.js" },
  "files": ["dist/src", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "npm run build && node --test dist/test/*.test.js",
    "prepack": "npm run build"
  }
}
```

Set `target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `strict: true`, `rootDir: "."`, `outDir: "dist"`, `types: ["node"]`, and `skipLibCheck: true`. Include `src/**/*.ts` and `test/**/*.ts`. Ignore `node_modules/`, `dist/`, and `*.tgz`. Use Apache-2.0, Alex Forster <alex@alexforster.com>, and `git+https://github.com/alexforster/terminal-emulator-mcp.git`; include matching homepage/issues links, macOS/Linux declarations, public publishing metadata, and terminal/MCP discovery keywords. Add the full standard Apache-2.0 LICENSE.

- [x] **Write and run a failing screen test.** Use this initial case plus explicit assertions for wide text, concealed cells, normal/alternate buffers, a pending-wrap cursor, and history capped at 2,000 lines.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { TerminalModel } from "../src/terminal.js";

test("captures highlighted blank cells with 1-based coordinates", async (t) => {
  const terminal = new TerminalModel(24, 3);
  t.after(() => terminal.dispose());
  terminal.write("Open project\r\n\x1b[7mSettings                \x1b[0m");
  await terminal.drain();
  const screen = terminal.capture();
  assert.equal(screen.screen.length, 3);
  assert.equal(screen.screen[0], "Open project");
  assert.ok(screen.screen[1].startsWith("Settings"));
  const span = screen.spans.find((value) => value.row === 2);
  assert.ok(span);
  assert.equal(span.startColumn, 1);
  assert.equal(span.endColumn, 24);
  assert.equal(screen.styles[span.styleId].inverse, true);
});
```

Run `npm run build && node --test dist/test/terminal.test.js`. Expected initial failure: the model implementation is absent, or highlighted blanks fail the assertion.

- [x] **Implement the model and formatter.** Construct xterm with `{ cols, rows, scrollback: 2000, allowProposedApi: true }`. Maintain received/parsed sequence counters and pending UTF-8 byte counts. A drain captures the received sequence at entry and resolves when that sequence is parsed; subsequent output does not extend its boundary.

```ts
const sequence = ++received;
const byteLength = Buffer.byteLength(data, "utf8");
pendingBytes += byteLength;
terminal.write(data, () => {
  parsed = sequence;
  pendingBytes -= byteLength;
  // Refresh the visible-state fingerprint, notify observers, and resolve
  // drain waiters whose captured sequence is <= parsed.
});
```

Read `buffer.active.baseY + rowOffset`; iterate actual cells, including empty styled cells. Emit each wide glyph once, using cell width rather than string length. Normalize numeric attribute predicates with `Boolean(...)`. Build style records from the fields in `CellStyle`, deduplicate by canonical serialization, and merge neighboring equal styles. Exclude history and mouse mode from the visible-state fingerprint; include dimensions, active buffer, cursor visibility/position, text, and styles.

Register public mode observers for `CSI ? ... h/l`, full reset `ESC c`, and soft reset `CSI ! p`; return `false` from each callback. Track cursor mode 25 and mouse encoding modes 1006/1016 using the reset behavior in the spec. Forward xterm's `onData` event through `onResponse`. Remove all listeners and reject pending drain waiters on disposal.

- [x] **Verify parser and mode behavior with concrete cases.** Check split writes `"\x1b["` then `"7mX"`; query response to `"\x1b[6n"`; `"\x1b[?1049h"` / `"\x1b[?1049l"`; `"\x1b[?25l\x1bc"` keeping the cursor hidden; `"\x1b[!p"` revealing it; and compound `"\x1b[?1006;1016h"` selecting pixel encoding. Verify capture remains synchronous while a drain resolves only after parsing.

Run `npm test`. Expected: screen, parser, mode, and cleanup tests pass with no open timer handles.

- [x] **Commit the independently usable model.**

```sh
git add package.json package-lock.json tsconfig.json .gitignore \
  src/contracts.ts src/terminal.ts src/snapshot.ts test/terminal.test.ts
git commit -m "feat: model terminal screens with headless xterm"
```

## Task 2: Define discoverable input schemas and protocol encoders

**Files:** Create `src/keys.ts`, `src/input.ts`, and `test/input.test.ts`; extend `src/contracts.ts`.

**Consumes:** `InputModes` and the spec's full input/keyboard tables.

**Produces:** `encodeKey`, `encodeInput`, `InputActionSchema`, inferred `InputAction`, `ObservationSchema`, `StartSchema`, `SnapshotSchema`, `InputSchema`, `ResizeSchema`, and `SessionIdSchema`; infer `StartOptions` from `StartSchema`.

- [x] **Write failing table-driven encoder tests.** Cover each function-key/navigation family, every allowed modifier subset for those families, and explicit rejection cases for the simple-key whitelist.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { encodeKey } from "../src/keys.js";

test("encodes conventional and application cursor keys", () => {
  assert.equal(encodeKey("Up", [], false), "\x1b[A");
  assert.equal(encodeKey("Up", [], true), "\x1bOA");
  assert.equal(encodeKey("Up", ["Ctrl", "Shift"], true), "\x1b[1;6A");
  assert.equal(encodeKey("F12", ["Alt"], false), "\x1b[24;3~");
  assert.equal(encodeKey("Tab", ["Shift"], false), "\x1b[Z");
  assert.equal(encodeKey("c", ["Ctrl"], false), "\x03");
  assert.throws(() => encodeKey("Enter", ["Ctrl"], false));
  assert.throws(() => encodeKey("a", ["Shift"], false));
});
```

Run `npm run build && node --test dist/test/input.test.js`. Expected initial failure: missing encoder.

- [x] **Implement the key encoder using lookup tables.** Export the literal named-key list and modifier enum from `keys.ts`. Use the spec's exact sequences and simple-key whitelist; compute `m` from modifier membership. Prefix Alt characters with ESC on both platforms. Throw `RangeError` for duplicate modifiers and unsupported combinations; schema refinements convert that error to a validation issue, which handlers report as `INVALID_INPUT`. Keep `keys.ts` independent of `contracts.ts` so schemas can reuse its validation without an import cycle.

The schema accepts the named-key enum or `/^[\x20-\x7e]$/`, and reuses `encodeKey(key, modifiers, false)` in a refinement for static validity. Document supported modifier restrictions on the key action so discovery does not imply every combination is valid.

- [x] **Define strict action and tool schemas.** Use literal `type` values for each action, nested discriminated branches for mouse events, and mutually exclusive wait shapes. Publish all seven action types. Reject unknown fields, NaN/fractional/out-of-range values, invalid dimensions, `TERM` overrides, duplicate modifiers, empty batches, excess action count, and excess total payload.

```ts
const modifiers = z.array(z.enum(MODIFIERS)).max(3).default([]);
const textAction = z.strictObject({ type: z.literal("text"), text: z.string() });
const rawAction = z.strictObject({
  type: z.literal("raw"),
  bytes: z.array(z.number().int().min(0).max(255)).max(1_048_576),
});
const delayAction = z.strictObject({
  type: z.literal("wait"),
  durationMs: z.number().int().min(0).max(60_000),
});
```

Build the complete union from the spec's table. For the two `wait` shapes, use a union or refinement compatible with Zod's discriminated-union rules; do not register two identical discriminator values directly. Export complete strict schemas for SDK registration. Raw shape registration lets the SDK strip unknown fields before callbacks can reject them. Reuse observation validation on wait and tool arguments, including `settleTimeoutMs >= (settleMs ?? 250)`.

- [x] **Implement byte encoding for text, paste, focus, raw, and mouse.** Text is UTF-8; raw is `Buffer.from(bytes)`. Paste applies `text.replace(/\r?\n/g, "\r")`, then conditionally brackets it. Embedded control characters remain literal, matching the pinned xterm behavior. Disabled focus reporting yields an empty buffer. Mode validation happens against `InputModes` when the action executes.

For mouse, use `modifierBits = Shift*4 + Alt*8 + Ctrl*16`; button codes are left=0, middle=1, right=2, wheel-up=64, wheel-down=65. SGR reports use `ESC [ < button ; column ; row M` for presses/wheel and lowercase `m` for release. Legacy uses `Buffer.from([27, 91, 77, button + 32, column + 32, row + 32])`; release uses button 3 plus modifier bits. X10 sends unmodified presses only. Reject legacy coordinates above 223, disabled tracking, pixel encoding, and X10 wheel reports or modified clicks.

- [x] **Verify discovery and byte-level edge cases.**

```ts
const modes: InputModes = {
  cols: 120, rows: 40, applicationCursorKeys: false,
  bracketedPaste: true, focusReporting: false,
  mouseTracking: "vt200", mouseEncoding: "sgr",
};
assert.equal(
  encodeInput({ type: "paste", text: "a\nb" }, modes).toString(),
  "\x1b[200~a\rb\x1b[201~",
);
assert.equal(
  encodeInput({ type: "mouse", event: "click", row: 2, column: 3, button: "left", modifiers: [] }, modes).toString(),
  "\x1b[<0;3;2M\x1b[<0;3;2m",
);
assert.deepEqual(encodeInput({ type: "raw", bytes: [0, 128, 255] }, modes), Buffer.from([0, 128, 255]));
```

Also assert CRLF normalization, focus-on/off bytes, X10 press-only output, scroll count, legacy coordinate 223 versus 224, reset-selected encoding, empty text, and static preflight rejection. Use `z.toJSONSchema(InputSchema)` to assert that named keys, modifiers, mouse variants, and all action tags survive JSON-schema conversion. Run `npm test`.

- [x] **Commit the input contract and encoders.**

```sh
git add src/contracts.ts src/keys.ts src/input.ts test/input.test.ts
git commit -m "feat: define discoverable terminal input actions"
```

## Task 3: Observe screens with bounded settlement

**Files:** Extend `src/terminal.ts`; create `test/observation.test.ts`.

**Consumes:** `TerminalModel` output accounting/fingerprint and `ObservationOptions`.

**Produces:** `TerminalModel.observe`, with cancellation and parser-aware deadlines. The model returns `settled: false` at a deadline; session code adds tool-level strict failure context.

- [x] **Write failing timing tests using controlled time.** Seed/drain the terminal before enabling timer mocks. Mock `performance.now` alongside Node's `setTimeout` mock so the implementation can use a monotonic clock without depending on wall-clock time.

```ts
test("uses 250 ms of quiet by default", async (t) => {
  const terminal = new TerminalModel(20, 4);
  t.after(() => terminal.dispose());
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let completed = false;
  const observation = terminal.observe().then((value) => {
    completed = true;
    return value;
  });
  await Promise.resolve();
  now = 249;
  t.mock.timers.tick(249);
  await Promise.resolve();
  assert.equal(completed, false);
  now = 250;
  t.mock.timers.tick(1);
  assert.equal((await observation).settled, true);
});
```

Run `npm run build && node --test dist/test/observation.test.js`. Expected initial failure: observe is absent or returns before 250 ms.

- [x] **Implement one bounded observer per call.** Capture the start time, quiet interval, deadline, and received-output boundary. Subscribe to parsed changes and disposal; schedule the next quiet/deadline boundary. Any change to the visible fingerprint resets the quiet start. New output must finish parsing before reporting settlement. Evaluate `modes.synchronizedOutputMode` each time even when a mode change has no visible fingerprint change.

```ts
const quietMs = options.settleMs ?? 250;
const budgetMs = options.settleTimeoutMs ?? 1_000;
const startedAt = performance.now();
const deadline = startedAt + budgetMs;
// On parser notifications and timer boundaries:
// 1. Abort/dispose rejects and detaches this observer.
// 2. Drained + redraw inactive + elapsed quiet interval resolves settled:true.
// 3. Reached deadline resolves the latest parsed capture with settled:false.
// 4. Reschedule the nearest remaining quiet/deadline boundary.
```

For `settleMs: 0`, do not wait for inactivity; flush the captured output boundary when possible. During synchronized output, return immediately with `settled: false` if no strict deadline was supplied. With an explicit strict deadline, continue waiting for parser drain and synchronized-output completion up to that deadline. The session converts an unsettled result to `SCREEN_NOT_SETTLED`. Remove timers/subscriptions on every exit path.

- [x] **Exercise exact observation boundaries.** Assert 1,000 ms best-effort timeout during 100 ms frame updates, an explicit 600 ms budget returning unsettled, and successful settlement 250 ms after the last frame. Repeated identical content does not reset the timer. Style-only changes and cursor movement do. `"\x1b[?2026h"` prevents settlement until `"\x1b[?2026l"`; a stuck redraw times out. Add output during a drain and prove a snapshot cannot falsely claim settlement with pending parser work.

Use short controlled test sequences rather than long real sleeps. Cancellation must reject promptly and leave the model usable for another observation. Run `npm test`.

- [x] **Commit observation behavior.**

```sh
git add src/terminal.ts test/observation.test.ts
git commit -m "feat: observe terminal screens with bounded settling"
```

## Task 4: Own real terminal processes and their cleanup

**Files:** Create `src/session.ts`, `test/session.test.ts`, and `test/fixtures/terminal-child.ts`.

**Consumes:** `TerminalModel`, `StartOptions`, `TerminalSnapshot`, `SessionInfo`, and `ToolError`.

**Produces:** `Session.start`, `info`, `snapshot`, and `close`, plus the connection between PTY output, emulator responses, and read backpressure. Batch input, resize, and registry behavior are added in Task 5.

- [x] **Write a controlled child and failing lifecycle tests.** The child runs in raw mode, reports dimensions/environment, supports terminal queries, and accepts simple test instructions. Keep instructions deterministic and flush one readiness line before the test proceeds.

```ts
// test/fixtures/terminal-child.ts
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write(`READY ${process.stdout.columns}x${process.stdout.rows}\r\n`);
process.stdout.on("resize", () => {
  process.stdout.write(`SIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`);
});
process.stdin.on("data", (bytes: Buffer) => {
  if (bytes.includes(3)) {
    process.stdout.write("FINAL\r\n");
    process.exitCode = 7;
    process.stdin.pause();
    return;
  }
  process.stdout.write(`INPUT ${bytes.toString("hex")}\r\n`);
});
```

Extend the fixture with explicit command-line modes for final-output-then-exit, environment reporting, high-volume output, ignored termination signals, and a child process in the same group. Those modes must print readiness/PIDs as needed and avoid terminal programs installed outside the project.

Run `npm run build && node --test dist/test/session.test.js`. Expected initial failure: Session is missing.

- [x] **Implement start and connect both directions.**

```ts
const env = { ...process.env };
for (const [key, value] of Object.entries(options.env ?? {})) {
  if (value === null) delete env[key];
  else env[key] = value;
}
env.TERM = "xterm-256color";
const args = options.login === false ? ["-c", options.command] : ["-l", "-c", options.command];
const child = pty.spawn(options.shell ?? process.env.SHELL ?? "/bin/sh", args, {
  name: "xterm-256color",
  cols: options.cols,
  rows: options.rows,
  cwd: options.cwd ?? process.cwd(),
  env,
  handleFlowControl: false,
});
```

Define a boolean `login` option defaulting to true, with an input type that permits omission. Normalize an empty `SHELL` to `/bin/sh`. Use isolated child homes to verify login profiles and opt-out on available Bash/Dash/Zsh binaries, preserving noninteractive command mode. Ordinary process fixtures explicitly opt out of login startup so tests do not depend on user profiles. Validate all configuration before spawning. Dispose a partially constructed model if spawning fails. Route `child.onData` to `model.write` and `model.onResponse` to `child.write`. Subscribe to pending-byte counts: pause once at or above 1 MiB, resume once at or below 256 KiB. Native flow-control input interception remains disabled, so Ctrl+S/Ctrl+Q retain terminal behavior.

- [x] **Implement status, snapshot, and errors.** Preserve the screen when `onExit` fires and retain exit metadata. Snapshot composes session metadata with the observed screen. When an explicit strict deadline returns unsettled, throw `ToolError("SCREEN_NOT_SETTLED", ...)` with the session ID and latest snapshot. Nonzero exit codes are data; unknown shell/executable setup failures become `SPAWN_FAILED` or an observed command exit, according to what actually occurred.

- [x] **Implement idempotent cleanup with bounded escalation.** Abort session observers first. Signal the process group with SIGHUP, allow 500 ms for exit, then signal it with SIGKILL if it still exists; ignore only ESRCH and surface other cleanup failures appropriately. Use process-group signaling rather than assuming `child.kill()` reaches descendants. Drain already-received output before disposing where the close budget allows. Unsubscribe handlers and release timers even when signaling fails.

Keep request cancellation separate from session cancellation. A canceled snapshot must leave the child running. Ordinary process exit retains the model; explicit close disposes it.

- [x] **Verify process behavior and resource ownership.** Assert the requested 73×19 size, environment override/deletion, enforced TERM, working directory, terminal-query response path, final output with exit code 7, and retained snapshots. Verify backpressure preserves a finite marker emitted after a large output burst. Start a same-group descendant, close its session, and confirm both PIDs disappear; exercise escalation with a child that ignores SIGHUP. Ensure `t.after` closes every created session even if an assertion fails.

Use bounded readiness polling with diagnostic snapshots on timeout; do not rely on a fixed startup sleep. Run `npm test`.

- [x] **Commit process ownership.**

```sh
git add src/session.ts test/session.test.ts test/fixtures/terminal-child.ts
git commit -m "feat: manage pseudoterminal session lifecycles"
```

## Task 5: Execute ordered batches, resize, and manage multiple sessions

**Files:** Extend `src/session.ts`, `test/session.test.ts`, and `test/fixtures/terminal-child.ts`.

**Consumes:** Session lifecycle, action schemas/encoder, model observation, and result/error contracts.

**Produces:** `Session.input`, `Session.resize`, and all `SessionRegistry` methods.

- [x] **Write a failing partial-progress test.** Use a child mode that repeatedly changes visible text every 25 ms after receiving a command. A strict final observation must fail after input has been submitted.

```ts
await assert.rejects(
  session.input(
    [{ type: "text", text: "animate" }],
    { settleMs: 250, settleTimeoutMs: 500 },
  ),
  (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "SCREEN_NOT_SETTLED");
    assert.equal(error.details.inputSent, true);
    assert.equal(error.details.actionsCompleted, 1);
    assert.equal(error.details.latestSnapshot?.settled, false);
    return true;
  },
);
```

Run `npm run build && node --test dist/test/session.test.js`. Expected initial failure: batch execution is absent.

- [x] **Implement static preflight and ordered execution.** Parse the entire batch and run static key validation before entering the mutation queue. A session has one promise-based mutation queue for batches and resizes; rejected jobs must not poison later jobs. Each queued operation checks session closure and request cancellation before acting.

For each non-wait action, drain received output, read current input modes, encode, and submit a nonempty buffer. Increment `actionsCompleted` after completion and set `inputSent` upon submission. For fixed waits use an abortable timer; for settling waits call the session's observation helper without reacquiring the mutation queue. Final observation uses the outer timing options and retains progress if it fails.

```ts
for (const [index, action] of actions.entries()) {
  // Check request/session cancellation and running status.
  // Wait actions use an abortable timer or the shared observation helper.
  // Other actions drain, encode using current modes, and submit bytes.
  // Wrap an action failure with failedActionIndex:index and accumulated progress.
  progress.actionsCompleted++;
}
```

Do not hold observations behind the mutation queue: an agent must be able to inspect a session while another call is waiting. Close aborts active waits and queued jobs. Validation errors submit no bytes; a later state-dependent mouse failure preserves prior progress. An action's successful submission does not imply the child has consumed it.

- [x] **Implement resize and registry behavior.** Resize the model and PTY within the same mutation queue, handling a process exit between validation and resize. Notify observers of changed dimensions. Attach the resulting dimensions and latest snapshot to a strict post-resize timeout.

The registry allocates UUIDs, limits retained sessions to eight, lists concise status, rejects missing IDs, and removes sessions only through close. `close` returns false for unknown IDs. `closeAll` attempts every session even if one cleanup fails, then reports failures.

- [x] **Verify concurrency and discovery-relevant progress.** Assert an invalid later key prevents earlier text from being sent; two concurrent batches do not interleave; a mode-changing child affects a subsequent action after an explicit wait; snapshots run during waits; cancellation preserves already-sent input and leaves the session usable; close promptly aborts waits; resize produces `SIZE 91x27`; and nine retained sessions exceed the registry limit. Verify list includes exited sessions until they are closed.

Add a mouse case where one earlier text action succeeds and the later click fails because reporting is disabled; assert `actionsCompleted: 1` and `failedActionIndex: 1`. Run `npm test`.

- [x] **Commit ordered session operations.**

```sh
git add src/session.ts test/session.test.ts test/fixtures/terminal-child.ts
git commit -m "feat: execute ordered terminal actions across sessions"
```

## Task 6: Expose and package the MCP server

**Files:** Create `src/server.ts`, `src/package-info.ts`, `src/index.ts`, `test/cli.test.ts`, `test/server.test.ts`, `README.md`, and `.github/workflows/ci.yml`; update package metadata as necessary.

**Consumes:** The six tool schemas, `SessionRegistry`, snapshot formatter, and typed errors.

**Produces:** A runnable `terminal-emulator-mcp` executable, complete MCP discovery, cross-platform checks, and usage documentation.

- [x] **Write a failing client-driven discovery test.** Use the SDK's client and stdio transport against the built executable. Inspect actual `tools/list` output rather than only Zod's local conversion.

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "terminal-emulator-mcp-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/src/index.js"],
  stderr: "pipe",
});
await client.connect(transport);
const { tools } = await client.listTools();
assert.deepEqual(tools.map((tool) => tool.name).sort(), [
  "terminal_close", "terminal_input", "terminal_list",
  "terminal_resize", "terminal_snapshot", "terminal_start",
]);
const inputTool = tools.find((tool) => tool.name === "terminal_input");
assert.ok(inputTool);
const advertised = JSON.stringify(inputTool.inputSchema);
for (const word of ["paste", "focus", "mouse", "wait", "raw", "F12", "Ctrl", "settleTimeoutMs"]) {
  assert.ok(advertised.includes(word), word);
}
await client.close();
```

Register cleanup with `t.after` in the actual test so failures do not leave a server process running. Run `npm run build && node --test dist/test/server.test.js`. Expected initial failure: the CLI entry point or registered tools are missing.

- [x] **Register the six tools with complete schemas and descriptions.**

```ts
server.registerTool("terminal_input", {
  description: "Send an ordered batch of terminal actions and return its styled screen. "
    + "A settling error does not undo input; inspect inputSent and actionsCompleted before retrying.",
  inputSchema: InputSchema,
}, async (rawArgs, extra) => {
  const args = InputSchema.parse(rawArgs);
  const result = await registry.get(args.sessionId).input(args.actions, args, extra.signal);
  return formatResult(result);
});
```

Register the full strict schema objects, including refinements, using the pinned SDK's schema-object support. Verify that actual discovery advertises `additionalProperties:false` and that unknown top-level arguments cannot be discarded before mutation. Define `formatResult` locally in `server.ts` to return both `structuredContent` and readable text content; define one error wrapper that preserves `ToolError.details` and sets `isError: true`. Missing-session input errors retain zero progress. Avoid a generic tool framework.

Readable style spans use compact row groups such as `12: 1-16=s3`; structured content retains the complete span objects. Measure the complete encoded tool result against an 8 MiB budget. Oversized results return `RESULT_TOO_LARGE` with bounded session/effect metadata and original error context, without silently truncating style data or closing the connection. Exercise both a full alternating-color 500×200 screen that fits and a many-style result that fails explicitly, then verify recovery by resizing.

Start allocates the session before observing, preserving its ID on strict timeout. List returns concise metadata. Snapshot passes optional history. Resize carries applied dimensions in its snapshot. Close returns `{ sessionId, closed }`. Tool annotations must accurately describe mutating versus observing behavior.

- [x] **Implement the executable and shutdown.** Read package identity/version from `package.json` through one small shared metadata module. Handle `--help`/`-h`, `--version`/`-v`, and invalid arguments before dynamically loading server/native dependencies; test these paths from an isolated package without dependencies. Add SemVer 7.8.5 as a production dependency and its 7.8.0 type definitions as a development dependency. Validate the running Node version against the package manifest's engine range before loading MCP/native dependencies, while keeping help/version independent of dependencies. Add `#!/usr/bin/env node` at the top of `src/index.ts`, mark the compiled entry point executable in the build command, connect `StdioServerTransport`, and route diagnostics to stderr. A single idempotent shutdown promise stops protocol admission before awaiting every registry cleanup on stdin EOF, stdout stream failure, SIGHUP, SIGINT, or SIGTERM. Consume writable stream errors so EPIPE cannot terminate the process before cleanup. Do not call immediate `process.exit` before cleanup completes. Never write child output directly to server stdout.

- [x] **Exercise the full MCP workflow.** Start a 73×19 fixture session through `client.callTool`, extract its session ID from structured content, submit a batch, inspect the styled screen, resize, list, close, and verify the session is gone. Trigger a strict animated timeout and assert MCP `isError`, progress fields, and latest snapshot. Close each side of the client connection with a live resistant child and verify cleanup. Assert malformed actions and unknown top-level fields are rejected before effects, missing-session input has zero progress, and stderr diagnostics never corrupt protocol messages.

- [x] **Write usage documentation and a platform matrix.** README leads with consumer installation and copyable `claude mcp add` / `codex mcp add` commands; it includes native installation prerequisites, developer build commands, a `claude` example at 120×40, the full action vocabulary, key/modifier restrictions, snapshot/style examples, 250 ms quiet/1,000 ms cap behavior, strict timeout recovery, session cleanup boundaries, and mouse limits.

```sh
npm install --global --allow-scripts=node-pty terminal-emulator-mcp@0.9.0
claude mcp add --scope user --transport stdio terminal-emulator-mcp -- terminal-emulator-mcp
codex mcp add terminal-emulator-mcp -- terminal-emulator-mcp
```

CI runs `npm ci`, `npm run typecheck`, `npm test`, and `npm pack --dry-run` on `ubuntu-latest` and `macos-latest`, with Node 24.16.0 and 26. Approve only the pinned `node-pty` dependency's install scripts in the project's `allowScripts` field so Linux can compile its native addon. Use the pinned dependency's correctly packaged native helpers without permission repairs. Verify fresh installations using its macOS and compatible Linux prebuilds, and document explicit source builds for environments without compatible binaries. Keep dependency permission repair out of runtime application code. Use current maintained checkout/setup-node actions verified at implementation time; do not invent action versions.

- [x] **Verify the deliverable and commit.** Run the commands below and inspect every result. Inspect the package file list to ensure the executable and all runtime imports are included, with no tests or source-tree requirement. In a temporary directory, extract the packed artifact and run its executable with the SDK client; install production dependencies there if necessary.

```sh
npm run typecheck
npm test
npm pack --dry-run
git diff --check
```

- [x] **Install and verify both local harnesses.** Register the built executable as the `terminal-emulator-mcp` MCP server in the installed Codex and Claude harnesses, using their supported configuration commands and preserving unrelated configuration. Verify current CLI syntax and official documentation before modifying configuration. Both binaries and `htop` are available on this machine.

Through each harness, ask the agent to use only the `terminal-emulator-mcp` tools to start `htop` at 120×40, inspect the screen, open its setup menu with F2, observe a menu change after keyboard navigation, return to the process view, and quit. Require actual MCP tool-call evidence and screen observations, not a natural-language claim that the tool worked. Prefer exercising the interactive harnesses; if a harness can only be verified through its noninteractive entry point, record that limitation explicitly. Preserve concise evidence of the method and results without checking private harness transcripts or machine process listings into Git. Do not make automated tests depend on either harness, external credentials, or `htop`.

```sh
git add src/server.ts src/index.ts test/server.test.ts README.md .github/workflows/ci.yml package.json package-lock.json
git commit -m "feat: expose terminal sessions through a packaged MCP server"
```

## Self-review and execution handoff

Before execution, confirm every spec section maps to a task: snapshot/parser behavior to Task 1, discovery and byte encoding to Task 2, settlement to Task 3, process/environment/cleanup/backpressure to Task 4, batching/resize/registry/cancellation to Task 5, and MCP/packaging/platform checks to Task 6.

The six commits build a reviewer’s understanding from emulated screen state, through input and timing, to process ownership and the public interface. Tests and fixes belong in the commit introducing their behavior. Setup is part of the screen-model deliverable; README and CI are part of the runnable server deliverable.

Execute sequentially in the current session with focused subagents for each substantive task and reviews between tasks. Shared-interface changes must be reconciled in this plan and the consuming code before dependent work starts. The existing user authorization permits delegation; no additional delegation choice is needed.
