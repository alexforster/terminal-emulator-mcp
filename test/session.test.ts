import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import pty from "node-pty";
import { ToolError, type StartOptions, type TerminalSnapshot } from "../src/contracts.js";
import { Session, SessionRegistry } from "../src/session.js";

const fixture = fileURLToPath(new URL("./fixtures/terminal-child.js", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function environment(t: TestContext, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    const original = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }
}

function start(t: TestContext, mode = "input", options: Partial<StartOptions> = {}): Session {
  const session = Session.start({
    command: `exec ${quote(process.execPath)} ${quote(fixture)} ${quote(mode)}`,
    shell: "/bin/sh", login: false, cols: 73, rows: 19, ...options,
  });
  t.after(() => session.close());
  return session;
}

async function waitFor(
  session: Session,
  predicate: (snapshot: TerminalSnapshot) => boolean,
  description: string,
): Promise<TerminalSnapshot> {
  const deadline = performance.now() + 5000;
  let snapshot: TerminalSnapshot;
  do {
    snapshot = await session.snapshot({ settleMs: 0 });
    if (predicate(snapshot)) return snapshot;
    await delay(10);
  } while (performance.now() < deadline);
  assert.fail(`Timed out waiting for ${description}: ${JSON.stringify(snapshot)}`);
}

function contains(snapshot: TerminalSnapshot, text: string): boolean {
  return snapshot.screen.some((line) => line.includes(text));
}

async function ready(session: Session): Promise<number> {
  const snapshot = await waitFor(session, (value) => contains(value, "READY "), "readiness");
  const match = snapshot.screen.join("\n").match(/READY \d+x\d+ PID (\d+)/);
  assert.ok(match);
  return Number(match[1]);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function gone(...pids: number[]): Promise<void> {
  const deadline = performance.now() + 3000;
  while (pids.some(alive) && performance.now() < deadline) await delay(10);
  assert.deepEqual(pids.filter(alive), [], "session processes must be reaped");
}

test("launches a shell command with matching child and emulator dimensions", async (t) => {
  const session = start(t);
  await ready(session);
  const snapshot = await session.snapshot({ settleMs: 0 });
  assert.ok(contains(snapshot, "READY 73x19"));
  assert.equal(snapshot.cols, 73);
  assert.equal(snapshot.rows, 19);
  assert.equal(snapshot.screen.length, 19);
  assert.equal(snapshot.status, "running");
  assert.match(snapshot.sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(session.info(), {
    sessionId: snapshot.sessionId, command: session.info().command, cwd: process.cwd(),
    cols: 73, rows: 19, status: "running",
  });
});

test("applies environment overrides, deletion, TERM, and the working directory", async (t) => {
  environment(t, {
    TERMINAL_EMULATOR_MCP_OVERRIDE: "inherited", TERMINAL_EMULATOR_MCP_DELETE: "remove-me", TERM: "inherited-terminal",
  });
  const cwd = realpathSync(tmpdir());
  const session = start(t, "environment", {
    cwd, env: { TERMINAL_EMULATOR_MCP_OVERRIDE: "replaced", TERMINAL_EMULATOR_MCP_DELETE: null },
  });
  const snapshot = await waitFor(session, (value) => contains(value, "CWD "), "environment output");
  assert.ok(contains(snapshot, "OVERRIDE replaced"));
  assert.ok(contains(snapshot, "DELETED false"));
  assert.ok(contains(snapshot, "TERM xterm-256color"));
  assert.equal(snapshot.screen.filter((line) => line.startsWith("CWD "))[0], `CWD ${cwd}`);
  assert.equal(session.info().cwd, cwd);
});

test("falls back to /bin/sh when SHELL is empty and interprets shell syntax", async (t) => {
  environment(t, { SHELL: "" });
  const session = start(t, "input", { shell: undefined, command: "printf '%s\\n' \"quoted value\" | cat" });
  const snapshot = await waitFor(session, (value) => value.status === "exited", "shell exit");
  assert.ok(contains(snapshot, "quoted value"));
  assert.equal(snapshot.exitCode, 0);
});

for (const [shell, profile] of [
  ["/bin/bash", ".bash_profile"], ["/bin/dash", ".profile"], ["/bin/zsh", ".zprofile"],
]) {
  test(`uses a noninteractive login shell by default with ${shell}`, { skip: !existsSync(shell) }, async (t) => {
    const home = mkdtempSync(join(tmpdir(), "terminal-emulator-mcp-home-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(join(home, profile), "export TERMINAL_EMULATOR_MCP_PROFILE=loaded\n");
    const cases = [[{}, "loaded"], [{ login: true }, "loaded"], [{ login: false }, "unset"]] as const;
    for (const [options, expected] of cases) {
      const session = Session.start({
        shell, command: 'printf "PROFILE %s\\n" "${TERMINAL_EMULATOR_MCP_PROFILE:-unset}"; '
          + 'case $- in *i*) printf "INTERACTIVE yes\\n";; *) printf "INTERACTIVE no\\n";; esac',
        cols: 73, rows: 19,
        env: { HOME: home, ZDOTDIR: home, BASH_ENV: null, ENV: null, TERMINAL_EMULATOR_MCP_PROFILE: null },
        ...options,
      });
      try {
        const snapshot = await waitFor(
          session, (value) => value.status === "exited" && contains(value, "INTERACTIVE "), "complete login output",
        );
        assert.equal(snapshot.exitCode, 0);
        assert.ok(contains(snapshot, `PROFILE ${expected}`), JSON.stringify(snapshot.screen));
        assert.ok(contains(snapshot, "INTERACTIVE no"), JSON.stringify(snapshot.screen));
      } finally {
        await session.close();
      }
    }
  });
}

test("returns emulator-generated terminal query responses to the child", async (t) => {
  const session = start(t, "query");
  await waitFor(session, (snapshot) => contains(snapshot, "QUERY_OK"), "cursor report round trip");
});

test("retains parsed final output and nonzero exit metadata", async (t) => {
  const session = start(t, "exit");
  const snapshot = await waitFor(session, (value) => value.status === "exited", "command exit");
  assert.ok(contains(snapshot, "FINAL"));
  assert.equal(snapshot.exitCode, 7);
  assert.equal(session.info().exitCode, 7);
  assert.deepEqual(snapshot.styles.s1.foreground, { kind: "palette", index: 1 });
  assert.deepEqual(await session.snapshot({ settleMs: 0 }), snapshot);
});

test("preserves the marker following a large output burst", async (t) => {
  const session = start(t, "burst");
  const snapshot = await waitFor(session, (value) => contains(value, "BURST_COMPLETE"), "burst marker");
  assert.equal(snapshot.status, "running");
});

test("pauses a parser backlog and resumes reads so the remaining output arrives", async (t) => {
  const originalSpawn = pty.spawn;
  let pauses = 0;
  let resumes = 0;
  t.mock.method(pty, "spawn", (...args: Parameters<typeof pty.spawn>) => {
    const child = originalSpawn(...args);
    const onData = child.onData;
    // Coalesce real PTY chunks to exercise the queue limit independently of native read sizes.
    Object.defineProperty(child, "onData", {
      value: (listener: (bytes: string) => void) => {
        let buffered = "";
        return onData((bytes) => {
          buffered += bytes;
          if (buffered.length >= 1_048_576 || buffered.includes("BURST_COMPLETE")) {
            const output = buffered;
            buffered = "";
            listener(output);
          }
        });
      },
    });
    const pause = child.pause.bind(child);
    const resume = child.resume.bind(child);
    child.pause = () => { pauses++; pause(); };
    child.resume = () => { resumes++; resume(); };
    return child;
  });
  const session = start(t, "burst");
  await waitFor(session, (value) => contains(value, "BURST_COMPLETE"), "backpressure recovery");
  assert.ok(pauses > 0, "the queue limit must pause native reads");
  assert.equal(resumes, pauses, "each paused read must resume after parsing");
});

test("strict observation failures retain the latest snapshot and session", async (t) => {
  const session = start(t, "synchronized");
  await waitFor(session, (value) => contains(value, "UNFINISHED"), "synchronized output");
  await assert.rejects(session.snapshot({ settleMs: 0, settleTimeoutMs: 30 }), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "SCREEN_NOT_SETTLED");
    assert.equal(error.details.sessionId, session.info().sessionId);
    assert.equal(error.details.latestSnapshot?.settled, false);
    assert.ok(contains(error.details.latestSnapshot!, "UNFINISHED"));
    return true;
  });
  assert.equal(session.info().status, "running");
});

test("canceling an observation leaves its child running", async (t) => {
  const session = start(t);
  const pid = await ready(session);
  const cancellation = new AbortController();
  const observing = session.snapshot({ settleMs: 60_000 }, 0, cancellation.signal);
  cancellation.abort();
  await assert.rejects(observing, (error: unknown) => error instanceof ToolError && error.code === "REQUEST_CANCELLED");
  assert.equal(alive(pid), true);
  assert.equal((await session.snapshot({ settleMs: 0 })).status, "running");
});

test("close cancels observations promptly and is idempotent", async (t) => {
  const session = start(t, "ignore-hup");
  const pid = await ready(session);
  const started = performance.now();
  const observing = session.snapshot({ settleMs: 60_000 });
  const rejected = assert.rejects(observing, (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "SESSION_CLOSED");
    assert.ok(performance.now() - started < 400, "observation must cancel before termination grace expires");
    return true;
  });
  const closing = session.close();
  assert.equal(session.close(), closing);
  await rejected;
  await closing;
  await gone(pid);
  assert.ok(performance.now() - started < 2000, "cleanup must remain bounded");
  await assert.rejects(
    session.snapshot(), (error: unknown) => error instanceof ToolError && error.code === "SESSION_CLOSED",
  );
});

test("close terminates descendants even when the group leader exits on SIGHUP", async (t) => {
  const session = start(t, "group");
  const pid = await ready(session);
  const snapshot = await session.snapshot({ settleMs: 0 });
  const match = snapshot.screen.join("\n").match(/DESCENDANT (\d+)/);
  assert.ok(match);
  const descendant = Number(match[1]);
  assert.equal(alive(descendant), true);
  await session.close();
  await gone(pid, descendant);
});

test("validates configuration before spawning", () => {
  for (const invalid of [
    { cols: 1 }, { rows: 0 }, { shell: "" }, { env: { TERM: "dumb" } },
    { settleMs: 20, settleTimeoutMs: 10 },
  ]) {
    assert.throws(
      () => Session.start({ command: "exit 0", cols: 73, rows: 19, ...invalid }),
      (error: unknown) => error instanceof ToolError && error.code === "INVALID_INPUT",
    );
  }
});

test("rejects native string truncation and malformed environment names before spawning", () => {
  const invalidOptions: Partial<StartOptions>[] = [
    { command: "exit 0\0ignored" }, { shell: "/bin/sh\0ignored" }, { cwd: "/tmp\0ignored" },
    { env: { "A=B": "value" } }, { env: { "": "value" } }, { env: { "BAD\0NAME": "value" } },
    { env: { VALUE: "truncated\0value" } },
  ];
  for (const invalid of invalidOptions) {
    assert.throws(
      () => Session.start({ command: "exit 0", cols: 73, rows: 19, ...invalid }),
      (error: unknown) => error instanceof ToolError && error.code === "INVALID_INPUT",
    );
  }
});

test("close is safe immediately after process creation", async (t) => {
  for (let i = 0; i < 5; i++) {
    const session = start(t);
    await session.close();
  }
});

test("close waits for process group creation when the initial signal races startup", async (t) => {
  const session = start(t);
  const pid = await ready(session);
  const originalKill = process.kill;
  let pending = true;
  const kill = t.mock.method(process, "kill", (target: number, signal?: NodeJS.Signals | number) => {
    if (target === -pid && signal === "SIGHUP" && pending) {
      pending = false;
      throw Object.assign(new Error("Process group not created yet"), { code: "ESRCH" });
    }
    return originalKill(target, signal);
  });
  try {
    await session.close();
    await gone(pid);
  } finally {
    kill.mock.restore();
    if (alive(pid)) originalKill(-pid, "SIGKILL");
    await gone(pid);
  }
});

test("caller cancellation remains distinct when close follows before the observer resumes", async (t) => {
  const session = start(t);
  await ready(session);
  const cancellation = new AbortController();
  const observing = session.snapshot({ settleMs: 60_000 }, 0, cancellation.signal);
  cancellation.abort();
  const closing = session.close();
  await assert.rejects(observing, (error: unknown) => error instanceof ToolError && error.code === "REQUEST_CANCELLED");
  await closing;
});

test("cleanup signaling errors retain context and still cancel observers", async (t) => {
  const session = Session.start({
    command: `exec ${quote(process.execPath)} ${quote(fixture)}`,
    shell: "/bin/sh", login: false, cols: 73, rows: 19,
  });
  const originalKill = process.kill;
  let pid: number | undefined;
  t.after(async () => {
    if (pid !== undefined && alive(pid)) originalKill(-pid, "SIGKILL");
    await session.close().catch(() => {});
    if (pid !== undefined) await gone(pid);
  });
  pid = await ready(session);
  const kill = t.mock.method(process, "kill", (target: number, signal?: NodeJS.Signals | number) => {
    if (target === -pid! && signal === "SIGHUP") {
      throw Object.assign(new Error("Denied cleanup"), { code: "EPERM" });
    }
    return originalKill(target, signal);
  });
  const observing = assert.rejects(
    session.snapshot({ settleMs: 60_000 }),
    (error: unknown) => error instanceof ToolError && error.code === "SESSION_CLOSED",
  );
  await assert.rejects(session.close(), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "IO_ERROR");
    assert.equal(error.details.sessionId, session.info().sessionId);
    assert.ok(error.details.latestSnapshot);
    assert.ok(contains(error.details.latestSnapshot, "READY "));
    return true;
  });
  kill.mock.restore();
  await observing;
});

test("reports unavailable shell or cwd as a spawn failure or observed unsuccessful exit", async (t) => {
  for (const options of [
    { shell: "/terminal-emulator-mcp-no-such-shell" }, { cwd: "/terminal-emulator-mcp-no-such-directory" },
  ]) {
    let session: Session;
    try {
      session = start(t, "input", options);
    } catch (error) {
      assert.ok(error instanceof ToolError);
      assert.equal(error.code, "SPAWN_FAILED");
      continue;
    }
    const snapshot = await waitFor(session, (value) => value.status === "exited", "setup failure exit");
    assert.notEqual(snapshot.exitCode, 0);
  }
});

test("strict final observation retains the progress of input already submitted", async (t) => {
  const session = start(t, "animate");
  await ready(session);
  await assert.rejects(
    session.input([{ type: "text", text: "animate" }], { settleMs: 250, settleTimeoutMs: 500 }),
    (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.code, "SCREEN_NOT_SETTLED");
      assert.equal(error.details.inputSent, true);
      assert.equal(error.details.actionsCompleted, 1);
      assert.equal(error.details.failedActionIndex, undefined);
      assert.equal(error.details.latestSnapshot?.settled, false);
      assert.match(error.message, /already submitted/);
      return true;
    },
  );
});

test("preflights a later invalid key before submitting earlier text", async (t) => {
  const session = start(t, "record");
  await ready(session);
  await assert.rejects(session.input([
    { type: "text", text: "A" }, { type: "key", key: "Enter", modifiers: ["Ctrl"] },
  ]), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "INVALID_INPUT");
    assert.equal(error.details.actionsCompleted, 0);
    assert.equal(error.details.inputSent, false);
    return true;
  });
  await session.input([{ type: "text", text: "B" }]);
  const snapshot = await waitFor(session, (value) => contains(value, "BYTES "), "recorded input");
  assert.ok(contains(snapshot, "BYTES 42"));
  assert.equal(contains(snapshot, "BYTES 4142"), false);
});

test("a state-dependent action failure retains earlier progress and releases the queue", async (t) => {
  const session = start(t, "record");
  await ready(session);
  await assert.rejects(session.input([
    { type: "text", text: "A" },
    { type: "mouse", event: "click", row: 1, column: 1, button: "left", modifiers: [] },
  ]), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "UNSUPPORTED_INPUT");
    assert.equal(error.details.actionsCompleted, 1);
    assert.equal(error.details.inputSent, true);
    assert.equal(error.details.failedActionIndex, 1);
    assert.equal(error.details.latestSnapshot?.sessionId, session.info().sessionId);
    return true;
  });
  await session.input([{ type: "text", text: "C" }]);
  await waitFor(session, (value) => contains(value, "BYTES 4143"), "input after a rejected batch");
});

test("concurrent batches submit bytes in batch order without interleaving", async (t) => {
  const session = start(t, "record");
  await ready(session);
  const first = session.input([
    { type: "text", text: "A" }, { type: "wait", durationMs: 100 }, { type: "text", text: "B" },
  ]);
  const second = session.input([{ type: "text", text: "CD" }]);
  const results = await Promise.all([first, second]);
  assert.equal(results[0].actionsCompleted, 3);
  assert.equal(results[1].actionsCompleted, 1);
  await waitFor(session, (value) => contains(value, "BYTES 41424344"), "uninterleaved input");
});

test("an explicit wait lets subsequent actions use the child's changed input modes", async (t) => {
  const session = start(t, "modes", { cols: 160 });
  await ready(session);
  const result = await session.input([
    { type: "text", text: "modes" },
    { type: "wait", settleMs: 50, settleTimeoutMs: 1000 },
    { type: "key", key: "Up", modifiers: [] },
    { type: "paste", text: "a\nb" },
    { type: "focus", focused: true },
  ]);
  assert.equal(result.actionsCompleted, 5);
  assert.ok(contains(result.snapshot, "BYTES 6d6f6465731b4f411b5b3230307e610d621b5b3230317e1b5b49"));
});

test("waits and empty input actions count as completed without claiming input was sent", async (t) => {
  const session = start(t);
  await ready(session);
  const result = await session.input([
    { type: "text", text: "" }, { type: "raw", bytes: [] }, { type: "focus", focused: true },
    { type: "wait", durationMs: 0 }, { type: "wait", settleMs: 0 },
  ], { settleMs: 0 });
  assert.equal(result.actionsCompleted, 5);
  assert.equal(result.inputSent, false);
});

test("raw input preserves non-UTF-8 bytes through the PTY", async (t) => {
  const session = start(t, "record");
  await ready(session);
  const result = await session.input([{ type: "raw", bytes: [0, 128, 255] }]);
  assert.equal(result.inputSent, true);
  assert.ok(contains(result.snapshot, "BYTES 0080ff"));
});

test("snapshots proceed during waits and cancellation preserves submitted input", async (t) => {
  const session = start(t, "record");
  await ready(session);
  const cancellation = new AbortController();
  const input = session.input([
    { type: "text", text: "A" }, { type: "wait", durationMs: 60_000 }, { type: "text", text: "B" },
  ], {}, cancellation.signal);
  const rejected = assert.rejects(input, (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "REQUEST_CANCELLED");
    assert.equal(error.details.actionsCompleted, 1);
    assert.equal(error.details.inputSent, true);
    assert.equal(error.details.failedActionIndex, 1);
    return true;
  });
  await waitFor(session, (value) => contains(value, "BYTES 41"), "snapshot during a batch wait");
  cancellation.abort();
  await rejected;
  const result = await session.input([{ type: "text", text: "C" }]);
  assert.ok(contains(result.snapshot, "BYTES 4143"));
});

test("a queued request cancels promptly without waiting for the active batch", async (t) => {
  const session = start(t, "record");
  await ready(session);
  const activeCancellation = new AbortController();
  const queuedCancellation = new AbortController();
  const active = session.input([
    { type: "text", text: "A" }, { type: "wait", durationMs: 60_000 },
  ], {}, activeCancellation.signal);
  const activeRejected = assert.rejects(active, { code: "REQUEST_CANCELLED" });
  await waitFor(session, (value) => contains(value, "BYTES 41"), "active batch wait");
  const queued = session.input([{ type: "text", text: "B" }], {}, queuedCancellation.signal);
  queuedCancellation.abort();
  await assert.rejects(queued, (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "REQUEST_CANCELLED");
    assert.equal(error.details.actionsCompleted, 0);
    assert.equal(error.details.inputSent, false);
    return true;
  });
  activeCancellation.abort();
  await activeRejected;
  const result = await session.input([{ type: "text", text: "C" }]);
  assert.ok(contains(result.snapshot, "BYTES 4143"));
});

test("close promptly aborts an active settling wait and queued input and resize", async (t) => {
  const session = start(t, "record");
  await ready(session);
  const active = session.input([
    { type: "text", text: "A" }, { type: "wait", settleMs: 60_000, settleTimeoutMs: 60_000 },
  ]);
  await waitFor(session, (value) => contains(value, "BYTES 41"), "settling wait");
  const queued = session.input([{ type: "text", text: "B" }]);
  const resizing = session.resize(91, 27);
  const started = performance.now();
  const rejections = [
    assert.rejects(active, (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.code, "SESSION_CLOSED");
      assert.equal(error.details.actionsCompleted, 1);
      assert.equal(error.details.failedActionIndex, 1);
      return true;
    }),
    assert.rejects(queued, { code: "SESSION_CLOSED" }),
    assert.rejects(resizing, { code: "SESSION_CLOSED" }),
  ];
  const closing = session.close();
  await Promise.all(rejections);
  assert.ok(performance.now() - started < 400, "mutations must cancel before termination grace expires");
  await closing;
});

test("request cancellation remains distinct when close follows during a batch wait", async (t) => {
  const session = start(t, "record");
  await ready(session);
  const cancellation = new AbortController();
  const input = session.input([
    { type: "text", text: "A" }, { type: "wait", durationMs: 60_000 },
  ], {}, cancellation.signal);
  await waitFor(session, (value) => contains(value, "BYTES 41"), "batch wait");
  cancellation.abort();
  const closing = session.close();
  await assert.rejects(input, { code: "REQUEST_CANCELLED" });
  await closing;
});

test("a strict wait action reports its index and does not submit later input", async (t) => {
  const session = start(t, "synchronized");
  await waitFor(session, (value) => contains(value, "UNFINISHED"), "synchronized output");
  await assert.rejects(session.input([
    { type: "focus", focused: false },
    { type: "wait", settleMs: 0, settleTimeoutMs: 30 },
    { type: "text", text: "B" },
  ]), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "SCREEN_NOT_SETTLED");
    assert.equal(error.details.actionsCompleted, 1);
    assert.equal(error.details.inputSent, false);
    assert.equal(error.details.failedActionIndex, 1);
    return true;
  });
});

test("resize waits for an active batch and updates both child and emulator dimensions", async (t) => {
  const session = start(t, "record");
  await ready(session);
  const input = session.input([
    { type: "text", text: "A" }, { type: "wait", durationMs: 150 },
  ], { settleMs: 0 });
  await waitFor(session, (value) => contains(value, "BYTES 41"), "batch wait before resizing");
  const resizing = session.resize(91, 27);
  assert.equal((await session.snapshot({ settleMs: 0 })).cols, 73);
  await input;
  const snapshot = await resizing;
  assert.equal(snapshot.cols, 91);
  assert.equal(snapshot.rows, 27);
  assert.ok(contains(snapshot, "SIZE 91x27"), JSON.stringify(snapshot.screen));
  assert.equal(session.info().cols, 91);
  assert.equal(session.info().rows, 27);
});

test("invalid resize dimensions leave the session dimensions intact", async (t) => {
  const session = start(t);
  await ready(session);
  await assert.rejects(session.resize(1, 27), { code: "INVALID_INPUT" });
  const snapshot = await session.snapshot({ settleMs: 0 });
  assert.equal(snapshot.cols, 73);
  assert.equal(snapshot.rows, 19);
});

test("validated operation arguments do not leak mutation fields into the returned observation", async (t) => {
  const session = start(t, "record");
  await ready(session);
  const inputArguments = {
    sessionId: session.info().sessionId,
    actions: [{ type: "text" as const, text: "A" }],
    settleMs: 20,
  };
  const result = await session.input(inputArguments.actions, inputArguments);
  assert.equal(result.actionsCompleted, 1);
  assert.ok(contains(result.snapshot, "BYTES 41"));
  const resizeArguments = { sessionId: session.info().sessionId, cols: 91, rows: 27, settleMs: 20 };
  const snapshot = await session.resize(resizeArguments.cols, resizeArguments.rows, resizeArguments);
  assert.equal(snapshot.cols, 91);
  assert.equal(snapshot.rows, 27);
});

test("strict resize timeout reports the dimensions that remain applied", async (t) => {
  const session = start(t, "synchronized");
  await waitFor(session, (value) => contains(value, "UNFINISHED"), "synchronized output");
  await assert.rejects(session.resize(91, 27, { settleMs: 0, settleTimeoutMs: 30 }), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "SCREEN_NOT_SETTLED");
    assert.equal(error.details.latestSnapshot?.cols, 91);
    assert.equal(error.details.latestSnapshot?.rows, 27);
    assert.equal(error.details.latestSnapshot?.settled, false);
    assert.match(error.message, /91.*27/);
    return true;
  });
  assert.equal(session.info().cols, 91);
});

test("exited sessions reject input and resize while retaining their final screen", async (t) => {
  const session = start(t, "exit");
  await waitFor(session, (value) => value.status === "exited", "process exit");
  await assert.rejects(session.input([{ type: "text", text: "A" }]), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "SESSION_EXITED");
    assert.equal(error.details.actionsCompleted, 0);
    assert.equal(error.details.inputSent, false);
    assert.ok(contains(error.details.latestSnapshot!, "FINAL"));
    return true;
  });
  await assert.rejects(session.resize(91, 27), { code: "SESSION_EXITED" });
});

test("native write failures report completed input and leave later batches usable", async (t) => {
  const originalSpawn = pty.spawn;
  t.mock.method(pty, "spawn", (...args: Parameters<typeof pty.spawn>) => {
    const child = originalSpawn(...args);
    const write = child.write.bind(child);
    child.write = (data) => {
      if (data.toString() === "B") throw new Error("Native write failed");
      write(data);
    };
    return child;
  });
  const session = start(t, "record");
  await ready(session);
  await assert.rejects(session.input([
    { type: "text", text: "A" }, { type: "text", text: "B" },
  ]), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "IO_ERROR");
    assert.equal(error.details.actionsCompleted, 1);
    assert.equal(error.details.inputSent, true);
    assert.equal(error.details.failedActionIndex, 1);
    assert.ok(error.details.latestSnapshot);
    return true;
  });
  const result = await session.input([{ type: "text", text: "C" }]);
  assert.ok(contains(result.snapshot, "BYTES 4143"));
});

test("queued resize rechecks process exit before changing dimensions", async (t) => {
  const session = start(t);
  await ready(session);
  const input = session.input([
    { type: "key", key: "c", modifiers: ["Ctrl"] }, { type: "wait", durationMs: 150 },
  ], { settleMs: 0 });
  const resizing = session.resize(91, 27);
  const rejected = assert.rejects(resizing, (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "SESSION_EXITED");
    assert.equal(error.details.latestSnapshot?.cols, 73);
    assert.equal(error.details.latestSnapshot?.rows, 19);
    assert.ok(contains(error.details.latestSnapshot!, "FINAL"));
    return true;
  });
  const result = await input;
  assert.equal(result.snapshot.status, "exited");
  assert.equal(result.actionsCompleted, 2);
  await rejected;
});

test("a process exiting during a batch prevents subsequent input and reports its action index", async (t) => {
  const session = start(t);
  await ready(session);
  await assert.rejects(session.input([
    { type: "key", key: "c", modifiers: ["Ctrl"] },
    { type: "wait", durationMs: 150 },
    { type: "text", text: "B" },
  ]), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "SESSION_EXITED");
    assert.equal(error.details.actionsCompleted, 2);
    assert.equal(error.details.inputSent, true);
    assert.equal(error.details.failedActionIndex, 2);
    assert.equal(error.details.latestSnapshot?.status, "exited");
    return true;
  });
});

test("the registry retains exited sessions until close and enforces its eight-session limit", async (t) => {
  const registry = new SessionRegistry();
  t.after(() => registry.closeAll());
  const sessions = Array.from({ length: 8 }, () => registry.start({
    command: "printf 'FINAL\\n'; exit 7", shell: "/bin/sh", login: false, cols: 73, rows: 19,
  }));
  await Promise.all(sessions.map((session) => waitFor(session, (value) => value.status === "exited", "exit")));
  const ids = sessions.map((session) => session.info().sessionId);
  assert.equal(new Set(ids).size, 8);
  assert.ok(ids.every((id) => /^[0-9a-f-]{36}$/.test(id)));
  assert.equal(registry.list().length, 8);
  assert.ok(registry.list().every((info) => info.status === "exited" && info.exitCode === 7));
  assert.equal(registry.get(ids[0]), sessions[0]);
  assert.throws(
    () => registry.start({ command: "exit 0", shell: "/bin/sh", login: false, cols: 73, rows: 19 }),
    { code: "SESSION_LIMIT" },
  );
  assert.equal(await registry.close(ids[0]), true);
  assert.equal(await registry.close(ids[0]), false);
  assert.equal(await registry.close("missing"), false);
  assert.throws(() => registry.get(ids[0]), { code: "SESSION_NOT_FOUND" });
  assert.equal(registry.list().length, 7);
  registry.start({ command: "exit 0", shell: "/bin/sh", login: false, cols: 73, rows: 19 });
  assert.equal(registry.list().length, 8);
});

test("registry closeAll attempts every cleanup and reports a failed process-group signal", async (t) => {
  const registry = new SessionRegistry();
  const sessions = Array.from({ length: 2 }, () => registry.start({
    command: `exec ${quote(process.execPath)} ${quote(fixture)}`,
    shell: "/bin/sh", login: false, cols: 73, rows: 19,
  }));
  const originalKill = process.kill;
  const pids = await Promise.all(sessions.map(ready));
  t.after(async () => {
    for (const pid of pids) if (alive(pid)) originalKill(-pid, "SIGKILL");
    await registry.closeAll().catch(() => {});
    await gone(...pids);
  });
  const kill = t.mock.method(process, "kill", (target: number, signal?: NodeJS.Signals | number) => {
    if (target === -pids[0] && signal === "SIGHUP") {
      throw Object.assign(new Error("Denied cleanup"), { code: "EPERM" });
    }
    return originalKill(target, signal);
  });
  try {
    await assert.rejects(registry.closeAll(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.equal(error.errors[0].code, "IO_ERROR");
      return true;
    });
    await gone(pids[1]);
    assert.equal(registry.list().length, 0);
  } finally {
    kill.mock.restore();
  }
});

test("registry closeAll waits for a session whose individual close is still running", async (t) => {
  const registry = new SessionRegistry();
  const session = registry.start({
    command: `exec ${quote(process.execPath)} ${quote(fixture)} ignore-hup`,
    shell: "/bin/sh", login: false, cols: 73, rows: 19,
  });
  t.after(() => registry.closeAll());
  const pid = await ready(session);
  const closing = registry.close(session.info().sessionId);
  t.after(() => closing);
  await registry.closeAll();
  assert.equal(alive(pid), false, "all cleanup must finish before closeAll resolves");
  assert.equal(await closing, true);
  assert.equal(await registry.close(session.info().sessionId), false);
});

test("registry closeAll aggregates a late failure from an individual close already in progress", async (t) => {
  const registry = new SessionRegistry();
  const session = registry.start({
    command: `exec ${quote(process.execPath)} ${quote(fixture)} ignore-hup`,
    shell: "/bin/sh", login: false, cols: 73, rows: 19,
  });
  const originalKill = process.kill;
  let pid: number | undefined;
  let rejected: Promise<void> | undefined;
  let restore = () => {};
  t.after(async () => {
    try {
      await rejected;
    } finally {
      restore();
      if (pid && alive(pid)) originalKill(-pid, "SIGKILL");
      await registry.closeAll();
      if (pid) await gone(pid);
    }
  });
  pid = await ready(session);
  const kill = t.mock.method(process, "kill", (target: number, signal?: NodeJS.Signals | number) => {
    if (target === -pid! && signal === "SIGKILL") {
      throw Object.assign(new Error("Denied late cleanup"), { code: "EPERM" });
    }
    return originalKill(target, signal);
  });
  restore = () => kill.mock.restore();
  const closing = registry.close(session.info().sessionId);
  rejected = assert.rejects(closing, { code: "IO_ERROR" });
  await assert.rejects(registry.closeAll(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0].code, "IO_ERROR");
    assert.match(error.errors[0].message, /Denied late cleanup/);
    return true;
  });
  await rejected;
  assert.deepEqual(registry.list(), []);
});
