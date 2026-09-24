import assert from "node:assert/strict";
import test from "node:test";
import { visibleFingerprint } from "../src/snapshot.js";
import { TerminalModel } from "../src/terminal.js";

test("captures highlighted blank cells with 1-based coordinates", async (t) => {
  const terminal = new TerminalModel(24, 3);
  t.after(() => terminal.dispose());
  terminal.write("Open project\r\n\x1b[7mSettings                \x1b[0m");
  await terminal.drain();
  const screen = terminal.capture();
  assert.equal(screen.screen.length, 3);
  assert.equal(screen.screen[0], "Open project");
  assert.equal(screen.screen[1], "Settings                ");
  const span = screen.spans.find((value) => value.row === 2);
  assert.ok(span);
  assert.equal(span.startColumn, 1);
  assert.equal(span.endColumn, 24);
  assert.equal(screen.styles[span.styleId].inverse, true);
});

test("preserves indentation, blank rows, and wide and combining text in cell coordinates", async (t) => {
  const terminal = new TerminalModel(12, 3);
  t.after(() => terminal.dispose());
  terminal.write("  \x1b[31m界e\u0301\x1b[0m!");
  await terminal.drain();
  const screen = terminal.capture();
  assert.deepEqual(screen.screen, ["  界e\u0301!", "", ""]);
  assert.deepEqual(screen.cursor, { row: 1, column: 7, visible: true });
  assert.deepEqual(screen.spans, [{ row: 1, startColumn: 3, endColumn: 5, styleId: "s1" }]);
  assert.deepEqual(screen.styles, { s1: { foreground: { kind: "palette", index: 1 } } });
});

test("conceals characters without shifting following text or losing invisible spans", async (t) => {
  const terminal = new TerminalModel(12, 2);
  t.after(() => terminal.dispose());
  terminal.write("A\x1b[8m界x\x1b[0mB");
  await terminal.drain();
  const screen = terminal.capture();
  assert.deepEqual(screen.screen, ["A   B", ""]);
  assert.deepEqual(screen.spans, [{ row: 1, startColumn: 2, endColumn: 4, styleId: "s1" }]);
  assert.deepEqual(screen.styles, { s1: { invisible: true } });
});

test("reports a pending-wrap cursor at the last screen column", async (t) => {
  const terminal = new TerminalModel(4, 2);
  t.after(() => terminal.dispose());
  terminal.write("1234");
  await terminal.drain();
  assert.deepEqual(terminal.capture().cursor, { row: 1, column: 4, visible: true });
});

test("captures the active buffer and retains normal history while the alternate buffer is active", async (t) => {
  const terminal = new TerminalModel(10, 2);
  t.after(() => terminal.dispose());
  terminal.write("old\r\none\r\ntwo");
  await terminal.drain();
  assert.equal(terminal.capture().buffer, "normal");
  assert.deepEqual(terminal.capture().screen, ["one", "two"]);
  terminal.write("\x1b[?1049h\x1b[Halternate");
  await terminal.drain();
  const alternate = terminal.capture(10);
  assert.equal(alternate.buffer, "alternate");
  assert.deepEqual(alternate.screen, ["alternate", ""]);
  assert.deepEqual(alternate.history, { lines: ["old"], availableLines: 1 });
  terminal.write("\x1b[?1049l");
  await terminal.drain();
  assert.deepEqual(terminal.capture().screen, ["one", "two"]);
});

test("bounds history to 2,000 lines and returns its newest lines in chronological order", async (t) => {
  const terminal = new TerminalModel(10, 2);
  t.after(() => terminal.dispose());
  terminal.write(Array.from({ length: 2005 }, (_, i) => `line${i}`).join("\r\n"));
  await terminal.drain();
  const full = terminal.capture(2000);
  assert.equal(full.history?.availableLines, 2000);
  assert.equal(full.history.lines.length, 2000);
  assert.equal(full.history.lines[0], "line3");
  assert.equal(full.history.lines.at(-1), "line2002");
  assert.deepEqual(full.screen, ["line2003", "line2004"]);
  assert.deepEqual(terminal.capture(2).history, { lines: ["line2001", "line2002"], availableLines: 2000 });
  assert.equal(terminal.capture().history, undefined);
});

test("deduplicates all supported attributes and merges only adjacent equal cell styles", async (t) => {
  const terminal = new TerminalModel(12, 2);
  t.after(() => terminal.dispose());
  terminal.write("\x1b[1;2;3;4;5;7;8;9;53;38;2;1;2;3;48;5;200m  \x1b[0m-\x1b[31mX");
  terminal.write("\r\n\x1b[0;31mY Z\x1b[0m");
  await terminal.drain();
  const screen = terminal.capture();
  assert.deepEqual(screen.screen, ["  -X", "Y Z"]);
  assert.deepEqual(screen.styles, {
    s1: {
      foreground: { kind: "rgb", value: "#010203" },
      background: { kind: "palette", index: 200 },
      bold: true,
      dim: true,
      italic: true,
      underline: true,
      blink: true,
      inverse: true,
      invisible: true,
      strikethrough: true,
      overline: true,
    },
    s2: { foreground: { kind: "palette", index: 1 } },
  });
  assert.deepEqual(screen.spans, [
    { row: 1, startColumn: 1, endColumn: 2, styleId: "s1" },
    { row: 1, startColumn: 4, endColumn: 4, styleId: "s2" },
    { row: 2, startColumn: 1, endColumn: 3, styleId: "s2" },
  ]);
  assert.deepEqual(terminal.capture(), screen);
});

test("captures synchronously and drains only when the received write has been parsed", async (t) => {
  const terminal = new TerminalModel(10, 2);
  t.after(() => terminal.dispose());
  terminal.write("ready");
  assert.deepEqual(terminal.capture().screen, ["", ""]);
  let drained = false;
  const drain = terminal.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  await drain;
  assert.deepEqual(terminal.capture().screen, ["ready", ""]);
});

test("parses escape sequences split across writes", async (t) => {
  const terminal = new TerminalModel(10, 2);
  t.after(() => terminal.dispose());
  terminal.write("\x1b[");
  await terminal.drain();
  assert.deepEqual(terminal.capture().screen, ["", ""]);
  terminal.write("7mX");
  await terminal.drain();
  assert.equal(terminal.capture().screen[0], "X");
  assert.deepEqual(terminal.capture().styles, { s1: { inverse: true } });
});

test("forwards query responses and detaches response listeners", async (t) => {
  const terminal = new TerminalModel(10, 2);
  t.after(() => terminal.dispose());
  const responses: string[] = [];
  const detach = terminal.onResponse((data) => responses.push(data));
  terminal.write("abc\x1b[6n");
  await terminal.drain();
  assert.deepEqual(responses, ["\x1b[1;4R"]);
  detach();
  terminal.write("\x1b[6n");
  await terminal.drain();
  assert.deepEqual(responses, ["\x1b[1;4R"]);
});

test("tracks UTF-8 bytes until each chunk finishes parsing and detaches listeners", async (t) => {
  const terminal = new TerminalModel(10, 2);
  t.after(() => terminal.dispose());
  const pending: number[] = [];
  const detach = terminal.onPendingBytes((bytes) => pending.push(bytes));
  terminal.write("é");
  terminal.write("界");
  await terminal.drain();
  assert.deepEqual(pending, [2, 5, 3, 0]);
  detach();
  terminal.write("X");
  await terminal.drain();
  assert.deepEqual(pending, [2, 5, 3, 0]);
});

test("preserves write order when a pending-byte listener submits another chunk", async (t) => {
  const terminal = new TerminalModel(10, 2);
  t.after(() => terminal.dispose());
  let submitted = false;
  terminal.onPendingBytes(() => {
    if (!submitted) {
      submitted = true;
      terminal.write("B");
    }
  });
  terminal.write("A");
  await terminal.drain();
  assert.equal(terminal.capture().screen[0], "AB");
});

test("drain keeps its entry boundary when more output is received", async (t) => {
  const terminal = new TerminalModel(10, 2);
  t.after(() => terminal.dispose());
  const controller = new AbortController();
  terminal.onResponse(() => controller.abort());
  terminal.write("first");
  const boundary = terminal.drain(controller.signal);
  terminal.write("\x1b[6n");
  await boundary;
  await terminal.drain();
  assert.equal(controller.signal.aborted, true);
});

test("cancels a drain without cancelling parsing or other drain waiters", async (t) => {
  const terminal = new TerminalModel(10, 2);
  t.after(() => terminal.dispose());
  const controller = new AbortController();
  terminal.write("ready");
  const cancelled = terminal.drain(controller.signal);
  const continuing = terminal.drain();
  controller.abort();
  await assert.rejects(cancelled, { code: "REQUEST_CANCELLED" });
  await continuing;
  assert.equal(terminal.capture().screen[0], "ready");
  await assert.rejects(terminal.drain(controller.signal), { code: "REQUEST_CANCELLED" });
});

test("disposal rejects pending drains and prevents further terminal use", async () => {
  const terminal = new TerminalModel(10, 2);
  const pending: number[] = [];
  const responses: string[] = [];
  terminal.onPendingBytes((bytes) => pending.push(bytes));
  terminal.onResponse((data) => responses.push(data));
  terminal.write("\x1b[6n");
  const drain = terminal.drain();
  terminal.dispose();
  terminal.dispose();
  await assert.rejects(drain, { code: "SESSION_CLOSED" });
  await assert.rejects(terminal.drain(), { code: "SESSION_CLOSED" });
  assert.throws(() => terminal.write("X"), { code: "SESSION_CLOSED" });
  assert.throws(() => terminal.capture(), { code: "SESSION_CLOSED" });
  assert.deepEqual(responses, []);
  assert.deepEqual(pending, [4]);
});

test("observes cursor visibility with the pinned full and soft reset behavior", async (t) => {
  const terminal = new TerminalModel(10, 2);
  t.after(() => terminal.dispose());
  terminal.write("\x1b[?25l\x1bc");
  await terminal.drain();
  assert.equal(terminal.capture().cursor.visible, false);
  terminal.write("\x1b[!p");
  await terminal.drain();
  assert.equal(terminal.capture().cursor.visible, true);
  terminal.write("\x1b[?25l\x1b[?25h");
  await terminal.drain();
  assert.equal(terminal.capture().cursor.visible, true);
});

test("reports public input modes and processes compound mouse encodings in parameter order", async (t) => {
  const terminal = new TerminalModel(10, 2);
  t.after(() => terminal.dispose());
  assert.deepEqual(terminal.getInputModes(), {
    cols: 10,
    rows: 2,
    applicationCursorKeys: false,
    bracketedPaste: false,
    focusReporting: false,
    mouseTracking: "none",
    mouseEncoding: "legacy",
  });
  terminal.write("\x1b[?1;2004;1004;1002;1006;1016h");
  await terminal.drain();
  assert.deepEqual(terminal.getInputModes(), {
    cols: 10,
    rows: 2,
    applicationCursorKeys: true,
    bracketedPaste: true,
    focusReporting: true,
    mouseTracking: "drag",
    mouseEncoding: "sgr-pixels",
  });
  assert.deepEqual(terminal.capture().mouse, { tracking: "drag", encoding: "sgr-pixels" });
  terminal.write("\x1b[?1016;1006h");
  await terminal.drain();
  assert.equal(terminal.getInputModes().mouseEncoding, "sgr");
  terminal.write("\x1b[!p");
  await terminal.drain();
  assert.equal(terminal.getInputModes().mouseEncoding, "sgr");
  terminal.write("\x1b[?1016l");
  await terminal.drain();
  assert.equal(terminal.getInputModes().mouseEncoding, "legacy");
  terminal.write("\x1b[?1016h\x1b[?1006l");
  await terminal.drain();
  assert.equal(terminal.getInputModes().mouseEncoding, "legacy");
  terminal.write("\x1b[?1006h\x1bc");
  await terminal.drain();
  assert.equal(terminal.getInputModes().mouseEncoding, "legacy");
  assert.equal(terminal.getInputModes().mouseTracking, "none");
});

test("resizing updates captured dimensions, screen rows, and input boundaries", async (t) => {
  const terminal = new TerminalModel(10, 2);
  t.after(() => terminal.dispose());
  terminal.write("hello");
  await terminal.drain();
  terminal.resize(12, 3);
  const screen = terminal.capture();
  assert.equal(screen.cols, 12);
  assert.equal(screen.rows, 3);
  assert.deepEqual(screen.screen, ["hello", "", ""]);
  assert.equal(terminal.getInputModes().cols, 12);
  assert.equal(terminal.getInputModes().rows, 3);
});

test("visible fingerprints exclude history and mouse modes but include visual changes", async (t) => {
  const terminal = new TerminalModel(10, 2);
  t.after(() => terminal.dispose());
  terminal.write("old\r\none\r\ntwo");
  await terminal.drain();
  const original = visibleFingerprint(terminal.capture());
  assert.equal(visibleFingerprint(terminal.capture(1)), original);
  terminal.write("\r\none\r\ntwo");
  await terminal.drain();
  assert.equal(terminal.capture(1).history?.availableLines, 3);
  assert.equal(visibleFingerprint(terminal.capture()), original);
  terminal.write("\x1b[?1000;1006h");
  await terminal.drain();
  assert.equal(visibleFingerprint(terminal.capture()), original);
  for (const sequence of ["\x1b[H", "\x1b[?25l", "\x1b[31mX", "\x1b[?1049h"]) {
    const before = visibleFingerprint(terminal.capture());
    terminal.write(sequence);
    await terminal.drain();
    assert.notEqual(visibleFingerprint(terminal.capture()), before);
  }
  const beforeResize = visibleFingerprint(terminal.capture());
  terminal.resize(12, 3);
  assert.notEqual(visibleFingerprint(terminal.capture()), beforeResize);
});
