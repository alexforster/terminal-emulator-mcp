import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  InputActionSchema, InputSchema, ObservationSchema, ResizeSchema, SessionIdSchema, SnapshotSchema, StartSchema,
  ToolError, type InputModes,
} from "../src/contracts.js";
import { encodeInput } from "../src/input.js";
import { encodeKey, type Modifier } from "../src/keys.js";
import { TerminalModel } from "../src/terminal.js";

const modifierCases: [Modifier[], number][] = [
  [[], 1],
  [["Shift"], 2],
  [["Alt"], 3],
  [["Alt", "Shift"], 4],
  [["Ctrl"], 5],
  [["Ctrl", "Shift"], 6],
  [["Ctrl", "Alt"], 7],
  [["Ctrl", "Alt", "Shift"], 8],
];

test("encodes every navigation and function key with every modifier subset", () => {
  const cursorKeys = [
    ["Up", "A"], ["Down", "B"], ["Right", "C"], ["Left", "D"], ["Home", "H"], ["End", "F"],
  ];
  const ss3Keys = [["F1", "P"], ["F2", "Q"], ["F3", "R"], ["F4", "S"]];
  const tildeKeys = [
    ["Insert", "2"], ["Delete", "3"], ["PageUp", "5"], ["PageDown", "6"],
    ["F5", "15"], ["F6", "17"], ["F7", "18"], ["F8", "19"],
    ["F9", "20"], ["F10", "21"], ["F11", "23"], ["F12", "24"],
  ];
  for (const [modifiers, parameter] of modifierCases) {
    for (const application of [false, true]) {
      for (const [key, suffix] of cursorKeys) {
        const expected = parameter === 1
          ? `\x1b${application ? "O" : "["}${suffix}` : `\x1b[1;${parameter}${suffix}`;
        assert.equal(encodeKey(key, modifiers, application), expected, `${key}: ${modifiers}`);
      }
      for (const [key, suffix] of ss3Keys) {
        const expected = parameter === 1 ? `\x1bO${suffix}` : `\x1b[1;${parameter}${suffix}`;
        assert.equal(encodeKey(key, modifiers, application), expected, `${key}: ${modifiers}`);
      }
      for (const [key, parameterKey] of tildeKeys) {
        const expected = parameter === 1 ? `\x1b[${parameterKey}~` : `\x1b[${parameterKey};${parameter}~`;
        assert.equal(encodeKey(key, modifiers, application), expected, `${key}: ${modifiers}`);
      }
    }
  }
});

test("encodes the simple-key modifier whitelist without keyboard-layout assumptions", () => {
  const cases: [string, Modifier[], string][] = [
    ["Enter", [], "\r"], ["Enter", ["Alt"], "\x1b\r"],
    ["Tab", [], "\t"], ["Tab", ["Shift"], "\x1b[Z"],
    ["Backspace", [], "\x7f"], ["Backspace", ["Ctrl"], "\b"],
    ["Backspace", ["Alt"], "\x1b\x7f"], ["Backspace", ["Ctrl", "Alt"], "\x1b\b"],
    ["Escape", [], "\x1b"], ["Escape", ["Alt"], "\x1b\x1b"],
    ["Space", [], " "], ["Space", ["Ctrl"], "\0"],
    ["Space", ["Alt"], "\x1b "], ["Space", ["Alt", "Ctrl"], "\x1b\0"],
    [" ", [], " "], [" ", ["Ctrl"], "\0"], [" ", ["Alt", "Ctrl"], "\x1b\0"],
    ["@", ["Ctrl"], "\0"], ["[", ["Ctrl"], "\x1b"], ["\\", ["Ctrl"], "\x1c"],
    ["]", ["Ctrl"], "\x1d"], ["^", ["Ctrl"], "\x1e"], ["_", ["Ctrl"], "\x1f"],
    ["?", ["Ctrl"], "\x7f"], ["?", ["Ctrl", "Alt"], "\x1b\x7f"],
  ];
  for (const [key, modifiers, expected] of cases) assert.equal(encodeKey(key, modifiers, false), expected);
  for (let code = 32; code <= 126; code++) {
    const key = String.fromCharCode(code);
    assert.equal(encodeKey(key, [], false), key);
    assert.equal(encodeKey(key, ["Alt"], false), `\x1b${key}`);
  }
  for (let code = 1; code <= 26; code++) {
    for (const key of [String.fromCharCode(code + 64), String.fromCharCode(code + 96)]) {
      assert.equal(encodeKey(key, ["Ctrl"], false), String.fromCharCode(code));
      assert.equal(encodeKey(key, ["Alt", "Ctrl"], false), `\x1b${String.fromCharCode(code)}`);
    }
  }
});

test("rejects every unsupported simple-key modifier subset, duplicate modifiers, and unknown keys", () => {
  const allowed: [string, number[]][] = [
    ["Enter", [1, 3]], ["Tab", [1, 2]], ["Backspace", [1, 3, 5, 7]],
    ["Escape", [1, 3]], ["Space", [1, 3, 5, 7]], [" ", [1, 3, 5, 7]],
    ["a", [1, 3, 5, 7]], ["A", [1, 3, 5, 7]], ["1", [1, 3]], ["!", [1, 3]],
  ];
  for (const [key, supported] of allowed) {
    for (const [modifiers, parameter] of modifierCases) {
      if (!supported.includes(parameter)) {
        assert.throws(() => encodeKey(key, modifiers, false), RangeError, `${key}: ${modifiers}`);
      }
    }
  }
  for (const key of ["up", "F13", "", "ab", "é", "\n", "\x7f", "constructor"]) {
    assert.throws(() => encodeKey(key, [], false), RangeError, key);
  }
  for (const key of ["Up", "a", "Tab"]) {
    assert.throws(() => encodeKey(key, ["Alt", "Alt"], false), RangeError);
  }
});

test("parses all action variants and supplies mouse and modifier defaults", () => {
  const cases = [
    { type: "text", text: "héllo\n\x03" },
    { type: "paste", text: "" },
    { type: "focus", focused: true },
    { type: "raw", bytes: [0, 128, 255] },
    { type: "wait", durationMs: 0 },
    { type: "wait", durationMs: 60_000 },
    { type: "wait" },
    { type: "wait", settleMs: 0, settleTimeoutMs: 1 },
  ];
  for (const action of cases) assert.deepEqual(InputActionSchema.parse(action), action);
  assert.deepEqual(InputActionSchema.parse({ type: "key", key: "F12" }), {
    type: "key", key: "F12", modifiers: [],
  });
  assert.deepEqual(InputActionSchema.parse({ type: "mouse", event: "click", row: 2, column: 3 }), {
    type: "mouse", event: "click", row: 2, column: 3, button: "left", modifiers: [],
  });
  assert.deepEqual(InputActionSchema.parse({ type: "mouse", event: "scroll", row: 1, column: 1, direction: "up" }), {
    type: "mouse", event: "scroll", row: 1, column: 1, direction: "up", count: 1, modifiers: [],
  });
});

test("rejects malformed actions and unsupported keys before encoding any batch input", () => {
  const click = { type: "mouse", event: "click", row: 1, column: 1 };
  const invalid: unknown[] = [
    { type: "unknown" }, { type: "text", text: "ok", unknown: true }, { type: "text", text: 42 },
    { type: "paste", text: "", unknown: true }, { type: "focus", focused: 1 },
    { type: "focus", focused: true, text: "" }, { type: "raw", bytes: [1], text: "" },
    { type: "key", key: "up" }, { type: "key", key: "é" }, { type: "key", key: "ab" },
    { type: "key", key: "a", modifiers: ["Shift"] }, { type: "key", key: "Enter", modifiers: ["Ctrl"] },
    { type: "key", key: "Up", modifiers: ["Alt", "Alt"] }, { type: "key", key: "Up", modifiers: ["Meta"] },
    { type: "key", key: "Up", text: "" }, { ...click, modifiers: ["Ctrl", "Ctrl"] },
    { ...click, event: "drag" }, { ...click, direction: "up" }, { ...click, count: 2 },
    { ...click, button: "extra" }, { ...click, row: 0 }, { ...click, column: 0 },
    { ...click, row: 201 }, { ...click, column: 501 }, { ...click, row: 1.5 }, { ...click, column: NaN },
    { ...click, event: "scroll", direction: "left" },
    { ...click, event: "scroll", direction: "up", button: "left" },
    { type: "wait", durationMs: 10, settleMs: 0 },
    { type: "wait", durationMs: 10, settleTimeoutMs: 250 },
    { type: "wait", durationMs: 0, unknown: true },
  ];
  for (const byte of [-1, 256, 0.5, NaN, Infinity]) invalid.push({ type: "raw", bytes: [byte] });
  for (const count of [0, 101, 1.5, NaN]) {
    invalid.push({ ...click, event: "scroll", direction: "up", count });
  }
  for (const durationMs of [-1, 60_001, 0.5, NaN]) invalid.push({ type: "wait", durationMs });
  for (const action of invalid) {
    assert.equal(InputActionSchema.safeParse(action).success, false, JSON.stringify(action));
    assert.equal(InputSchema.safeParse({
      sessionId: "session", actions: [{ type: "text", text: "valid prefix" }, action],
    }).success, false, JSON.stringify(action));
  }
});

test("enforces observation deadlines consistently for tool arguments and settlement waits", () => {
  const parsers = [
    (options: object) => ObservationSchema.safeParse(options),
    (options: object) => StartSchema.safeParse({ command: "sh", cols: 80, rows: 24, ...options }),
    (options: object) => SnapshotSchema.safeParse({ sessionId: "session", ...options }),
    (options: object) => InputSchema.safeParse({ sessionId: "session", actions: [{ type: "wait" }], ...options }),
    (options: object) => ResizeSchema.safeParse({ sessionId: "session", cols: 80, rows: 24, ...options }),
    (options: object) => InputActionSchema.safeParse({ type: "wait", ...options }),
  ];
  const valid = [
    {}, { settleMs: 0 }, { settleMs: 60_000 }, { settleTimeoutMs: 250 },
    { settleMs: 0, settleTimeoutMs: 1 }, { settleMs: 60_000, settleTimeoutMs: 60_000 },
  ];
  const invalid = [
    { settleMs: -1 }, { settleMs: 60_001 }, { settleMs: 0.5 }, { settleMs: NaN },
    { settleTimeoutMs: 0 }, { settleTimeoutMs: 60_001 }, { settleTimeoutMs: 0.5 }, { settleTimeoutMs: NaN },
    { settleTimeoutMs: 249 }, { settleMs: 500, settleTimeoutMs: 499 }, { extra: true },
  ];
  for (const parse of parsers) {
    for (const options of valid) assert.equal(parse(options).success, true, JSON.stringify(options));
    for (const options of invalid) assert.equal(parse(options).success, false, JSON.stringify(options));
  }
});

test("validates start, resize, session, history, and environment boundaries", () => {
  const start = { command: "printf hello", cols: 2, rows: 1 };
  assert.deepEqual(StartSchema.parse(start), { ...start, login: true });
  assert.deepEqual(StartSchema.parse({ ...start, login: false }), { ...start, login: false });
  assert.equal(StartSchema.safeParse({ ...start, login: "true" }).success, false);
  assert.equal(StartSchema.safeParse({ ...start, cols: 500, rows: 200 }).success, true);
  assert.equal(StartSchema.safeParse({
    ...start, shell: "/bin/sh", cwd: "/tmp", env: { EXAMPLE: "value", REMOVED: null },
  }).success, true);
  for (const env of [{ TERM: "dumb" }, { TERM: null }, { EXAMPLE: 42 }]) {
    assert.equal(StartSchema.safeParse({ ...start, env }).success, false);
  }
  for (const command of ["", null, 42]) assert.equal(StartSchema.safeParse({ ...start, command }).success, false);
  for (const dimensions of [
    { cols: 1 }, { cols: 501 }, { cols: 2.5 }, { cols: NaN },
    { rows: 0 }, { rows: 201 }, { rows: 1.5 }, { rows: Infinity },
  ]) {
    assert.equal(StartSchema.safeParse({ ...start, ...dimensions }).success, false);
    assert.equal(ResizeSchema.safeParse({ sessionId: "session", cols: 80, rows: 24, ...dimensions }).success, false);
  }
  assert.deepEqual(SessionIdSchema.parse({ sessionId: "session" }), { sessionId: "session" });
  assert.equal(SessionIdSchema.safeParse({ sessionId: "" }).success, false);
  assert.equal(SessionIdSchema.safeParse({ sessionId: "session", extra: true }).success, false);
  for (const scrollbackLines of [0, 2000]) {
    assert.equal(SnapshotSchema.safeParse({ sessionId: "session", scrollbackLines }).success, true);
  }
  for (const scrollbackLines of [-1, 2001, 0.5, NaN]) {
    assert.equal(SnapshotSchema.safeParse({ sessionId: "session", scrollbackLines }).success, false);
  }
});

test("bounds batches by action count and total UTF-8 text, paste, and raw payload bytes", () => {
  const parse = (actions: unknown[]) => InputSchema.safeParse({ sessionId: "session", actions }).success;
  assert.equal(parse([]), false);
  assert.equal(parse(Array.from({ length: 256 }, () => ({ type: "wait" }))), true);
  assert.equal(parse(Array.from({ length: 257 }, () => ({ type: "wait" }))), false);
  const halfLimit = 524_288;
  assert.equal(parse([{ type: "text", text: "a".repeat(halfLimit * 2) }]), true);
  assert.equal(parse([{ type: "text", text: "a".repeat(halfLimit * 2 + 1) }]), false);
  assert.equal(parse([{ type: "paste", text: "é".repeat(halfLimit) }]), true);
  assert.equal(parse([{ type: "paste", text: "é".repeat(halfLimit + 1) }]), false);
  assert.equal(parse([{ type: "raw", bytes: new Array(halfLimit * 2).fill(255) }]), true);
  assert.equal(parse([{ type: "raw", bytes: new Array(halfLimit * 2 + 1).fill(255) }]), false);
  const actions = [
    { type: "text", text: "é".repeat(halfLimit / 2) },
    { type: "paste", text: "b".repeat(halfLimit - 1) },
    { type: "raw", bytes: [255] },
  ];
  assert.equal(parse(actions), true);
  assert.equal(parse([...actions, { type: "raw", bytes: [0] }]), false);
});

test("publishes all input tags, key names, modifiers, and mouse variants in JSON Schema", () => {
  const schema = z.toJSONSchema(InputSchema);
  const enums: unknown[][] = [];
  const constants = new Set<unknown>();
  const descriptions: string[] = [];
  function visit(value: unknown): void {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.enum)) enums.push(object.enum);
    if ("const" in object) constants.add(object.const);
    if (typeof object.description === "string") descriptions.push(object.description);
    Object.values(object).forEach(visit);
  }
  visit(schema);
  for (const type of ["text", "paste", "key", "mouse", "wait", "focus", "raw", "click", "scroll"]) {
    assert.equal(constants.has(type), true, type);
  }
  assert.ok(enums.some((values) => ["Ctrl", "Alt", "Shift"].every((value) => values.includes(value))));
  assert.ok(enums.some((values) => [
    "Enter", "Tab", "Backspace", "Escape", "Space", "Up", "Down", "Left", "Right", "Home", "End",
    "PageUp", "PageDown", "Insert", "Delete", "F1", "F2", "F3", "F4", "F5", "F6",
    "F7", "F8", "F9", "F10", "F11", "F12",
  ].every((value) => values.includes(value))));
  assert.ok(enums.some((values) => ["left", "middle", "right"].every((value) => values.includes(value))));
  assert.ok(enums.some((values) => ["up", "down"].every((value) => values.includes(value))));
  assert.ok(descriptions.some((value) => /Shift/.test(value) && /printable/i.test(value)));
  assert.equal(schema.additionalProperties, false);
});

const modes: InputModes = {
  cols: 120, rows: 40, applicationCursorKeys: false, bracketedPaste: true, focusReporting: false,
  mouseTracking: "vt200", mouseEncoding: "sgr",
};

function encode(action: unknown, overrides: Partial<InputModes> = {}): Buffer {
  const parsed = InputActionSchema.parse(action);
  assert.notEqual(parsed.type, "wait");
  if (parsed.type === "wait") throw new Error("A wait action does not encode input");
  return encodeInput(parsed, { ...modes, ...overrides });
}

test("encodes exact UTF-8 text and raw bytes without key interpretation", () => {
  assert.deepEqual(encode({ type: "text", text: "é界\n\x03" }), Buffer.from([195, 169, 231, 149, 140, 10, 3]));
  assert.equal(encode({ type: "text", text: "Enter" }).toString(), "Enter");
  assert.deepEqual(encode({ type: "raw", bytes: [0, 128, 255] }), Buffer.from([0, 128, 255]));
  assert.equal(encode({ type: "text", text: "" }).length, 0);
  assert.equal(encode({ type: "raw", bytes: [] }).length, 0);
});

test("uses application-cursor mode when a key action executes", () => {
  assert.equal(encode({ type: "key", key: "Up" }).toString(), "\x1b[A");
  assert.equal(encode({ type: "key", key: "Up" }, { applicationCursorKeys: true }).toString(), "\x1bOA");
  assert.equal(encode({
    type: "key", key: "Up", modifiers: ["Ctrl", "Shift"],
  }, { applicationCursorKeys: true }).toString(), "\x1b[1;6A");
});

test("normalizes paste line endings and preserves embedded controls with mode-dependent wrapping", () => {
  const action = { type: "paste", text: "a\nb\r\nc\rd\r\r\n\x1b[201~\x03é" };
  assert.equal(encode(action).toString(), "\x1b[200~a\rb\rc\rd\r\r\x1b[201~\x03é\x1b[201~");
  assert.equal(encode(action, { bracketedPaste: false }).toString(), "a\rb\rc\rd\r\r\x1b[201~\x03é");
  assert.equal(encode({ type: "paste", text: "" }).toString(), "\x1b[200~\x1b[201~");
  assert.equal(encode({ type: "paste", text: "" }, { bracketedPaste: false }).length, 0);
});

test("emits focus notifications only when requested by the application", () => {
  assert.equal(encode({ type: "focus", focused: true }).length, 0);
  assert.equal(encode({ type: "focus", focused: false }).length, 0);
  assert.equal(encode({ type: "focus", focused: true }, { focusReporting: true }).toString(), "\x1b[I");
  assert.equal(encode({ type: "focus", focused: false }, { focusReporting: true }).toString(), "\x1b[O");
});

test("encodes SGR click presses and releases in cell coordinates for every modifier subset", () => {
  const cases: [Modifier[], number][] = [
    [[], 0], [["Shift"], 4], [["Alt"], 8], [["Alt", "Shift"], 12],
    [["Ctrl"], 16], [["Ctrl", "Shift"], 20], [["Ctrl", "Alt"], 24], [["Ctrl", "Alt", "Shift"], 28],
  ];
  for (const [modifiers, bits] of cases) {
    for (const [button, code] of [["left", 0], ["middle", 1], ["right", 2]] as const) {
      for (const mouseTracking of ["vt200", "drag", "any"] as const) {
        assert.equal(encode({
          type: "mouse", event: "click", row: 2, column: 3, button, modifiers,
        }, { mouseTracking }).toString(), `\x1b[<${code + bits};3;2M\x1b[<${code + bits};3;2m`);
      }
    }
  }
  assert.equal(encode({
    type: "mouse", event: "click", row: 200, column: 500,
  }, { cols: 500, rows: 200 }).toString(), "\x1b[<0;500;200M\x1b[<0;500;200m");
});

test("encodes legacy mouse reports as bytes including high-bit coordinates and release modifiers", () => {
  assert.deepEqual(encode({
    type: "mouse", event: "click", row: 2, column: 3,
  }, { mouseEncoding: "legacy" }), Buffer.from([27, 91, 77, 32, 35, 34, 27, 91, 77, 35, 35, 34]));
  assert.deepEqual(encode({
    type: "mouse", event: "click", row: 200, column: 223, button: "right", modifiers: ["Ctrl", "Alt", "Shift"],
  }, { mouseEncoding: "legacy", cols: 500, rows: 200 }),
  Buffer.from([27, 91, 77, 62, 255, 232, 27, 91, 77, 63, 255, 232]));
});

test("sends only unmodified presses under X10 tracking", () => {
  for (const [button, code] of [["left", 0], ["middle", 1], ["right", 2]] as const) {
    const action = { type: "mouse", event: "click", row: 2, column: 3, button };
    assert.equal(encode(action, { mouseTracking: "x10" }).toString(), `\x1b[<${code};3;2M`);
    assert.deepEqual(encode(action, { mouseTracking: "x10", mouseEncoding: "legacy" }),
      Buffer.from([27, 91, 77, code + 32, 35, 34]));
  }
});

test("encodes one wheel report per scroll step without release reports", () => {
  const action = { type: "mouse", event: "scroll", row: 2, column: 3, direction: "up" };
  assert.equal(encode(action).toString(), "\x1b[<64;3;2M");
  assert.equal(encode({ ...action, count: 100 }).toString(), "\x1b[<64;3;2M".repeat(100));
  assert.equal(encode({
    ...action, direction: "down", count: 2, modifiers: ["Alt", "Ctrl", "Shift"],
  }).toString(), "\x1b[<93;3;2M\x1b[<93;3;2M");
  assert.deepEqual(encode({
    ...action, direction: "down", count: 2, modifiers: ["Alt"],
  }, { mouseEncoding: "legacy" }), Buffer.from([27, 91, 77, 105, 35, 34, 27, 91, 77, 105, 35, 34]));
});

test("rejects unsupported mouse modes and coordinates at execution time", () => {
  const click = { type: "mouse", event: "click", row: 2, column: 3 };
  const cases: [unknown, Partial<InputModes>][] = [
    [click, { mouseTracking: "none" }],
    [click, { mouseEncoding: "sgr-pixels" }],
    [{ ...click, row: 41 }, {}],
    [{ ...click, column: 121 }, {}],
    [{ ...click, column: 224 }, { cols: 500, mouseEncoding: "legacy" }],
    [{ ...click, event: "scroll", direction: "up" }, { mouseTracking: "x10" }],
  ];
  for (const modifier of ["Ctrl", "Alt", "Shift"]) {
    cases.push([{ ...click, modifiers: [modifier] }, { mouseTracking: "x10" }]);
  }
  for (const [action, state] of cases) {
    assert.throws(() => encode(action, state), (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.code, "UNSUPPORTED_INPUT");
      return true;
    });
  }
});

test("uses the encoding selected by terminal mode changes and resets", async (t) => {
  const terminal = new TerminalModel(80, 24);
  t.after(() => terminal.dispose());
  const parsed = InputActionSchema.parse({ type: "mouse", event: "click", row: 2, column: 3 });
  assert.ok(parsed.type === "mouse");
  terminal.write("\x1b[?1000;1006h");
  await terminal.drain();
  assert.equal(encodeInput(parsed, terminal.getInputModes()).toString(), "\x1b[<0;3;2M\x1b[<0;3;2m");
  for (const reset of ["\x1b[?1006l", "\x1b[?1006;1016h\x1b[?1016l", "\x1bc\x1b[?1000h"]) {
    terminal.write(reset);
    await terminal.drain();
    assert.deepEqual(encodeInput(parsed, terminal.getInputModes()),
      Buffer.from([27, 91, 77, 32, 35, 34, 27, 91, 77, 35, 35, 34]));
  }
});
