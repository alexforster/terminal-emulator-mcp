import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { TerminalModel } from "../src/terminal.js";

async function controlledTerminal(t: TestContext, seed = "ready") {
  const terminal = new TerminalModel(20, 4);
  t.after(() => terminal.dispose());
  terminal.write(seed);
  await terminal.drain();
  let now = 0;
  let parserDelay = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Explicit zero keeps omitted xterm delays ordered correctly by Node's mock timer queue.
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds?: number, ...args: unknown[]) => {
    return schedule(callback, milliseconds ?? parserDelay, ...args);
  });
  const advance = (milliseconds: number, elapsed = milliseconds) => {
    now += elapsed;
    t.mock.timers.tick(milliseconds);
  };
  return { terminal, advance, delayParsing: (milliseconds: number) => { parserDelay = milliseconds; } };
}

test("uses a fresh 250 ms quiet interval for each default observation", async (t) => {
  const { terminal, advance } = await controlledTerminal(t);
  let completed = false;
  const observation = terminal.observe().then((value) => {
    completed = true;
    return value;
  });
  advance(249);
  await Promise.resolve();
  assert.equal(completed, false);
  advance(1);
  assert.equal((await observation).settled, true);
  completed = false;
  const next = terminal.observe().then((value) => {
    completed = true;
    return value;
  });
  advance(249);
  await Promise.resolve();
  assert.equal(completed, false);
  advance(1);
  assert.equal((await next).settled, true);
});

for (const [label, options, budget] of [
  ["default", {}, 1000],
  ["explicit", { settleTimeoutMs: 600 }, 600],
] as const) {
  test(`returns the latest parsed frame unsettled at the ${label} deadline`, async (t) => {
    const { terminal, advance } = await controlledTerminal(t);
    let completed = false;
    const observation = terminal.observe(options).then((value) => {
      completed = true;
      return value;
    });
    for (let elapsed = 100; elapsed < budget; elapsed += 100) {
      advance(100);
      terminal.write(`\rframe ${elapsed}`);
      advance(0);
      await terminal.drain();
      assert.equal(completed, false);
    }
    advance(99);
    await Promise.resolve();
    assert.equal(completed, false);
    advance(1);
    const screen = await observation;
    assert.equal(screen.settled, false);
    assert.equal(screen.screen[0], `frame ${budget - 100}`);
  });
}

test("settles 250 ms after the final changing frame", async (t) => {
  const { terminal, advance } = await controlledTerminal(t);
  let completed = false;
  const observation = terminal.observe().then((value) => {
    completed = true;
    return value;
  });
  for (let frame = 1; frame <= 5; frame++) {
    advance(100);
    terminal.write(`\rframe ${frame}`);
    advance(0);
    await terminal.drain();
    assert.equal(completed, false);
  }
  advance(249);
  await Promise.resolve();
  assert.equal(completed, false);
  advance(1);
  const screen = await observation;
  assert.equal(screen.settled, true);
  assert.equal(screen.screen[0], "frame 5");
});

test("caps quiet intervals longer than the default deadline", async (t) => {
  const { terminal, advance } = await controlledTerminal(t);
  const observation = terminal.observe({ settleMs: 2000 });
  advance(1000);
  assert.equal((await observation).settled, false);
});

test("timer scheduling delay does not reject quiet already achieved at the deadline", async (t) => {
  const { terminal, advance } = await controlledTerminal(t);
  const observation = terminal.observe({ settleMs: 250, settleTimeoutMs: 250 });
  advance(250, 251);
  assert.equal((await observation).settled, true);
});

test("identical output parsed after the deadline cannot satisfy a strict observation", async (t) => {
  const { terminal, advance, delayParsing } = await controlledTerminal(t);
  delayParsing(100);
  terminal.write("\rready");
  const observation = terminal.observe({ settleMs: 0, settleTimeoutMs: 100 });
  advance(100, 101);
  assert.equal((await observation).settled, false);
});

test("identical repaints do not reset the quiet interval", async (t) => {
  const { terminal, advance } = await controlledTerminal(t);
  const observation = terminal.observe();
  for (let frame = 0; frame < 2; frame++) {
    advance(100);
    terminal.write("\rready");
    advance(0);
    await terminal.drain();
  }
  advance(50);
  assert.equal((await observation).settled, true);
});

for (const [description, output] of [
  ["style", "\r\x1b[7mready"],
  ["cursor position", "\x1b[H"],
  ["cursor visibility", "\x1b[?25l"],
  ["active buffer", "\x1b[?1049h"],
] as const) {
  test(`${description} changes reset the quiet interval`, async (t) => {
    const { terminal, advance } = await controlledTerminal(t);
    let completed = false;
    const observation = terminal.observe().then((value) => {
      completed = true;
      return value;
    });
    advance(200);
    terminal.write(output);
    advance(0);
    await terminal.drain();
    advance(249);
    await Promise.resolve();
    assert.equal(completed, false);
    advance(1);
    assert.equal((await observation).settled, true);
  });
}

test("dimension changes reset the quiet interval", async (t) => {
  const { terminal, advance } = await controlledTerminal(t);
  let completed = false;
  const observation = terminal.observe().then((value) => {
    completed = true;
    return value;
  });
  advance(200);
  terminal.resize(30, 5);
  advance(249);
  await Promise.resolve();
  assert.equal(completed, false);
  advance(1);
  const screen = await observation;
  assert.equal(screen.settled, true);
  assert.equal(screen.cols, 30);
  assert.equal(screen.rows, 5);
});

test("history-only output and mouse mode changes do not reset the quiet interval", async (t) => {
  const { terminal, advance } = await controlledTerminal(t, "old\r\none\r\ntwo\r\nthree\r\nfour");
  const observation = terminal.observe({}, 2);
  advance(200);
  terminal.write("\r\none\r\ntwo\r\nthree\r\nfour\x1b[?1000;1006h");
  advance(0);
  await terminal.drain();
  advance(50);
  const screen = await observation;
  assert.equal(screen.settled, true);
  assert.deepEqual(screen.screen, ["one", "two", "three", "four"]);
  assert.deepEqual(screen.history, { lines: ["three", "four"], availableLines: 5 });
  assert.deepEqual(screen.mouse, { tracking: "vt200", encoding: "sgr" });
});

test("finishing a synchronized redraw can settle without another visible change", async (t) => {
  const { terminal, advance } = await controlledTerminal(t, "\x1b[?2026hready");
  let completed = false;
  const observation = terminal.observe().then((value) => {
    completed = true;
    return value;
  });
  advance(300);
  await Promise.resolve();
  assert.equal(completed, false);
  terminal.write("\x1b[?2026l");
  advance(0);
  const screen = await observation;
  assert.equal(screen.settled, true);
  assert.equal(screen.screen[0], "ready");
});

test("a synchronized redraw started during observation prevents settlement", async (t) => {
  const { terminal, advance } = await controlledTerminal(t);
  const observation = terminal.observe();
  advance(200);
  terminal.write("\x1b[?2026h");
  advance(0);
  await terminal.drain();
  advance(800);
  assert.equal((await observation).settled, false);
});

test("an immediate best-effort observation returns unsettled during a synchronized redraw", async (t) => {
  const { terminal } = await controlledTerminal(t, "\x1b[?2026hready");
  const screen = await terminal.observe({ settleMs: 0 });
  assert.equal(screen.settled, false);
  assert.equal(screen.screen[0], "ready");
});

test("an immediate strict observation waits for synchronized output to finish", async (t) => {
  const { terminal, advance } = await controlledTerminal(t, "\x1b[?2026hready");
  let completed = false;
  const observation = terminal.observe({ settleMs: 0, settleTimeoutMs: 600 }).then((value) => {
    completed = true;
    return value;
  });
  advance(599);
  await Promise.resolve();
  assert.equal(completed, false);
  terminal.write("\x1b[?2026l");
  advance(0);
  assert.equal((await observation).settled, true);
});

test("an immediate strict observation times out if synchronized output remains active", async (t) => {
  const { terminal, advance } = await controlledTerminal(t, "\x1b[?2026hready");
  const observation = terminal.observe({ settleMs: 0, settleTimeoutMs: 600 });
  advance(600);
  assert.equal((await observation).settled, false);
});

test("an immediate observation flushes its received output", async (t) => {
  const { terminal, advance } = await controlledTerminal(t);
  terminal.write("\rnew");
  let completed = false;
  const observation = terminal.observe({ settleMs: 0 }).then((value) => {
    completed = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  advance(0);
  const screen = await observation;
  assert.equal(screen.settled, true);
  assert.equal(screen.screen[0], "newdy");
});

test("the deadline includes parser waiting and preserves the latest complete screen", async (t) => {
  const { terminal, advance, delayParsing } = await controlledTerminal(t);
  delayParsing(1500);
  terminal.write("\rqueued");
  const observation = terminal.observe({ settleTimeoutMs: 600 });
  advance(600);
  const screen = await observation;
  assert.equal(screen.settled, false);
  assert.equal(screen.screen[0], "ready");
  advance(900);
  await terminal.drain();
  assert.equal(terminal.capture().screen[0], "queued");
});

test("an immediate best-effort observation also bounds parser waiting", async (t) => {
  const { terminal, advance, delayParsing } = await controlledTerminal(t);
  delayParsing(1500);
  terminal.write("\rqueued");
  const observation = terminal.observe({ settleMs: 0 });
  advance(1000);
  const screen = await observation;
  assert.equal(screen.settled, false);
  assert.equal(screen.screen[0], "ready");
});

test("new output received during draining prevents a strict observation from falsely settling", async (t) => {
  const { terminal, advance } = await controlledTerminal(t);
  const controller = new AbortController();
  terminal.onResponse(() => controller.abort());
  let appended = false;
  terminal.onPendingBytes((bytes) => {
    if (bytes === 0 && !appended) {
      appended = true;
      terminal.write("\x1b[6n");
    }
  });
  terminal.write("\rready");
  const observation = terminal.observe({ settleMs: 0, settleTimeoutMs: 600 }, 0, controller.signal);
  const rejected = assert.rejects(observation, { code: "REQUEST_CANCELLED" });
  advance(0);
  await rejected;
  await terminal.drain();
  assert.equal(terminal.capture().screen[0], "ready");
});

test("cancellation rejects promptly without cancelling another observer or terminal parsing", async (t) => {
  const { terminal, advance } = await controlledTerminal(t);
  const controller = new AbortController();
  const cancelled = terminal.observe({}, 0, controller.signal);
  const continuing = terminal.observe();
  controller.abort();
  await assert.rejects(cancelled, { code: "REQUEST_CANCELLED" });
  terminal.write("\rstill usable");
  advance(0);
  await terminal.drain();
  advance(250);
  assert.equal((await continuing).settled, true);
  await assert.rejects(terminal.observe({}, 0, controller.signal), { code: "REQUEST_CANCELLED" });
  const next = terminal.observe({ settleMs: 0 });
  assert.equal((await next).screen[0], "still usable");
});

test("disposal rejects observers and clears their pending timers", async (t) => {
  const { terminal, advance } = await controlledTerminal(t);
  const controller = new AbortController();
  const observation = terminal.observe({}, 0, controller.signal);
  const rejected = assert.rejects(observation, { code: "SESSION_CLOSED" });
  terminal.dispose();
  await rejected;
  controller.abort();
  assert.doesNotThrow(() => advance(1000));
  await assert.rejects(terminal.observe(), { code: "SESSION_CLOSED" });
});
