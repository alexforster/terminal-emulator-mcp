import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TerminalSnapshot } from "../src/contracts.js";

const executable = fileURLToPath(new URL("../src/index.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/terminal-child.js", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (mode = "input") => `exec ${quote(process.execPath)} ${quote(fixture)} ${quote(mode)}`;

async function connect(t: TestContext) {
  const client = new Client({ name: "terminal-emulator-mcp-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [executable], stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
  t.after(() => client.close());
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}

function snapshot(result: CallToolResult): TerminalSnapshot {
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(result.structuredContent);
  const value = result.structuredContent.snapshot ?? result.structuredContent;
  assert.ok(value && typeof value === "object" && "sessionId" in value);
  return value as TerminalSnapshot;
}

async function observe(client: Client, sessionId: string, pattern: RegExp): Promise<TerminalSnapshot> {
  const deadline = performance.now() + 5000;
  let screen: TerminalSnapshot;
  do {
    screen = snapshot(await call(client, "terminal_snapshot", { sessionId, settleMs: 0 }));
    if (pattern.test(screen.screen.join("\n"))) return screen;
    await delay(10);
  } while (performance.now() < deadline);
  assert.fail(`Missing ${pattern}: ${JSON.stringify(screen)}`);
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

test("advertises all tools and the complete action vocabulary over MCP", async (t) => {
  const { client } = await connect(t);
  const { name, version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(client.getServerVersion(), { name, version });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "terminal_close", "terminal_input", "terminal_list",
    "terminal_resize", "terminal_snapshot", "terminal_start",
  ]);
  const input = tools.find((tool) => tool.name === "terminal_input");
  assert.ok(input);
  const advertised = JSON.stringify(input.inputSchema);
  for (const word of ["paste", "focus", "mouse", "wait", "raw", "F12", "Ctrl", "settleTimeoutMs"]) {
    assert.ok(advertised.includes(word), word);
  }
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, ["terminal_list", "terminal_snapshot"].includes(tool.name));
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  const start = tools.find((tool) => tool.name === "terminal_start");
  assert.ok(start);
  assert.deepEqual(start.inputSchema.properties?.login, { type: "boolean", default: true });
  assert.ok(!start.inputSchema.required?.includes("login"));
});

test("drives a styled session through start, input, history, resize, list, and close", async (t) => {
  const { client, stderr } = await connect(t);
  const initial = snapshot(await call(client, "terminal_start", {
    command: `printf '\\033[31mSTYLED\\033[0m\\n'; ${command()}`, shell: "/bin/sh", login: false, cols: 73, rows: 19,
  }));
  const sessionId = initial.sessionId;
  await observe(client, sessionId, /READY 73x19/);
  const result = await call(client, "terminal_input", {
    sessionId, actions: [{ type: "text", text: "A" }, { type: "key", key: "Enter" }],
  });
  const screen = snapshot(result);
  assert.equal(result.structuredContent?.actionsCompleted, 2);
  assert.equal(result.structuredContent?.inputSent, true);
  assert.equal(screen.screen.length, 19);
  assert.deepEqual(screen.styles.s1.foreground, { kind: "palette", index: 1 });
  assert.deepEqual(screen.spans[0], { row: 1, startColumn: 1, endColumn: 6, styleId: "s1" });
  assert.ok(screen.screen.some((line) => line.startsWith("INPUT ")));
  const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  for (const word of [sessionId, "STYLED", "s1", "cursor", "settled"]) assert.ok(text.includes(word), word);
  assert.match(text, /1[:|] STYLED/);
  const history = snapshot(await call(client, "terminal_snapshot", { sessionId, scrollbackLines: 10 }));
  assert.deepEqual(history.history, { lines: [], availableLines: 0 });
  const resized = snapshot(await call(client, "terminal_resize", { sessionId, cols: 91, rows: 27 }));
  assert.equal(resized.cols, 91);
  assert.equal(resized.rows, 27);
  await observe(client, sessionId, /SIZE 91x27/);
  const listed = await call(client, "terminal_list");
  const sessions = listed.structuredContent?.sessions as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, sessionId);
  assert.equal(sessions[0].cols, 91);
  assert.equal(sessions[0].status, "running");
  assert.equal(Object.hasOwn(sessions[0], "screen"), false);
  const closed = await call(client, "terminal_close", { sessionId });
  assert.deepEqual(closed.structuredContent, { sessionId, closed: true });
  assert.deepEqual((await call(client, "terminal_list")).structuredContent, { sessions: [] });
  const closedAgain = await call(client, "terminal_close", { sessionId });
  assert.deepEqual(closedAgain.structuredContent, { sessionId, closed: false });
  const missing = await call(client, "terminal_snapshot", { sessionId });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent?.code, "SESSION_NOT_FOUND");
  assert.equal(missing.structuredContent?.sessionId, sessionId);
  assert.equal(stderr(), "");
});

test("preserves an allocated session when the initial strict observation times out", async (t) => {
  const { client } = await connect(t);
  const result = await call(client, "terminal_start", {
    command: command("synchronized"), shell: "/bin/sh", login: false, cols: 73, rows: 19,
    settleMs: 500, settleTimeoutMs: 500,
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.code, "SCREEN_NOT_SETTLED");
  const latest = result.structuredContent?.latestSnapshot as TerminalSnapshot;
  assert.equal(latest.settled, false);
  assert.equal(latest.status, "running");
  assert.equal(latest.sessionId, result.structuredContent?.sessionId);
  await observe(client, latest.sessionId, /UNFINISHED/);
  const sessions = (await call(client, "terminal_list")).structuredContent?.sessions as Array<Record<string, unknown>>;
  assert.equal(sessions[0].sessionId, latest.sessionId);
});

test("preserves submitted input and applied dimensions in strict timeout errors", async (t) => {
  const { client } = await connect(t);
  const { sessionId } = snapshot(await call(client, "terminal_start", {
    command: command("animate"), shell: "/bin/sh", login: false, cols: 73, rows: 19,
  }));
  await observe(client, sessionId, /READY/);
  const result = await call(client, "terminal_input", {
    sessionId, actions: [{ type: "text", text: "go" }, { type: "wait", durationMs: 100 }],
    settleMs: 100, settleTimeoutMs: 200,
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.code, "SCREEN_NOT_SETTLED");
  assert.equal(result.structuredContent?.actionsCompleted, 2);
  assert.equal(result.structuredContent?.inputSent, true);
  assert.equal(result.structuredContent?.failedActionIndex, undefined);
  const latest = result.structuredContent?.latestSnapshot as TerminalSnapshot;
  assert.equal(latest.sessionId, sessionId);
  assert.equal(latest.settled, false);
  assert.match(latest.screen.join("\n"), /FRAME/);
  const resized = await call(client, "terminal_resize", {
    sessionId, cols: 91, rows: 27, settleMs: 100, settleTimeoutMs: 200,
  });
  assert.equal(resized.isError, true);
  assert.equal(resized.structuredContent?.code, "SCREEN_NOT_SETTLED");
  const resizedScreen = resized.structuredContent?.latestSnapshot as TerminalSnapshot;
  assert.equal(resizedScreen.cols, 91);
  assert.equal(resizedScreen.rows, 27);
  assert.match(String(resized.structuredContent?.message), /91.*27/);
});

test("rejects full-schema refinements before starting or sending any batch input", async (t) => {
  const { client } = await connect(t);
  const invalidStart = await call(client, "terminal_start", {
    command: command(), cols: 73, rows: 19, settleMs: 100, settleTimeoutMs: 1,
  });
  assert.equal(invalidStart.isError, true);
  assert.match(JSON.stringify(invalidStart.content), /settleTimeoutMs/);
  assert.deepEqual((await call(client, "terminal_list")).structuredContent, { sessions: [] });
  const { sessionId } = snapshot(await call(client, "terminal_start", {
    command: command(), shell: "/bin/sh", login: false, cols: 73, rows: 19,
  }));
  await observe(client, sessionId, /READY/);
  for (const action of [
    { type: "unknown" },
    { type: "key", key: "a", modifiers: ["Shift"] },
    { type: "wait", durationMs: 10, settleMs: 0 },
  ]) {
    const result = await call(client, "terminal_input", {
      sessionId, actions: [{ type: "text", text: "must-not-send" }, action],
    });
    assert.equal(result.isError, true);
  }
  const invalidTiming = await call(client, "terminal_input", {
    sessionId, actions: [{ type: "text", text: "must-not-send" }], settleMs: 100, settleTimeoutMs: 1,
  });
  assert.equal(invalidTiming.isError, true);
  assert.match(JSON.stringify(invalidTiming.content), /settleTimeoutMs/);
  const final = snapshot(await call(client, "terminal_snapshot", { sessionId }));
  assert.ok(final.screen.every((line) => !line.includes("INPUT ")));
});

test("writes protocol diagnostics to stderr without corrupting subsequent responses", async (t) => {
  const { client, transport, stderr } = await connect(t);
  await transport.send({ jsonrpc: "2.0", id: "unexpected-response", result: {} });
  assert.deepEqual((await call(client, "terminal_list")).structuredContent, { sessions: [] });
  const deadline = performance.now() + 1000;
  while (!stderr().includes("unexpected-response") && performance.now() < deadline) await delay(10);
  assert.match(stderr(), /unexpected-response/);
});

for (const termination of ["disconnect", "SIGHUP", "SIGINT", "SIGTERM"] as const) {
  test(`cleans up a live child and exits on ${termination}`, async (t) => {
    const { client, transport } = await connect(t);
    const { sessionId } = snapshot(await call(client, "terminal_start", {
      command: command(termination === "SIGHUP" ? "group" : "ignore-hup"),
      shell: "/bin/sh", login: false, cols: 73, rows: 19,
    }));
    const screen = await observe(client, sessionId, /READY.*PID/);
    const childPid = Number(screen.screen.join("\n").match(/PID (\d+)/)?.[1]);
    const descendant = screen.screen.join("\n").match(/DESCENDANT (\d+)/);
    const pids = descendant ? [childPid, Number(descendant[1])] : [childPid];
    t.after(() => { if (pids.some(alive)) process.kill(-childPid, "SIGKILL"); });
    const serverPid = transport.pid;
    assert.ok(serverPid);
    assert.ok(alive(childPid));
    const started = performance.now();
    if (termination === "disconnect") await client.close();
    else process.kill(serverPid, termination);
    const deadline = performance.now() + 1500;
    while ((pids.some(alive) || alive(serverPid)) && performance.now() < deadline) await delay(10);
    assert.deepEqual(pids.filter(alive), [], "terminal process group must be reaped");
    assert.equal(alive(serverPid), false, "server must exit after cleanup");
    assert.ok(performance.now() - started < 1500, "disconnect must not need the SDK's 2-second signal fallback");
  });
}

test("stops accepting new terminal sessions while shutdown waits for children", async (t) => {
  const { client, transport } = await connect(t);
  const { sessionId } = snapshot(await call(client, "terminal_start", {
    command: command("ignore-hup"), shell: "/bin/sh", login: false, cols: 73, rows: 19,
  }));
  await observe(client, sessionId, /READY/);
  assert.ok(transport.pid);
  process.kill(transport.pid, "SIGTERM");
  await delay(50);
  await assert.rejects(call(client, "terminal_start", {
    command: "/usr/bin/true", shell: "/bin/sh", login: false, cols: 73, rows: 19, settleMs: 0,
  }));
});

test("rejects unknown top-level arguments before start, input, or resize has effects", async (t) => {
  const { client } = await connect(t);
  const invalidStart = await call(client, "terminal_start", {
    command: command(), cols: 73, rows: 19, unexpectedArgument: "reject",
  });
  assert.equal(invalidStart.isError, true);
  assert.deepEqual((await call(client, "terminal_list")).structuredContent, { sessions: [] });
  const { sessionId } = snapshot(await call(client, "terminal_start", {
    command: command(), shell: "/bin/sh", login: false, cols: 73, rows: 19,
  }));
  await observe(client, sessionId, /READY/);
  const invalidInput = await call(client, "terminal_input", {
    sessionId, actions: [{ type: "text", text: "must-not-send" }], unexpectedArgument: "reject",
  });
  assert.equal(invalidInput.isError, true);
  const invalidResize = await call(client, "terminal_resize", {
    sessionId, cols: 91, rows: 27, unexpectedArgument: "reject",
  });
  assert.equal(invalidResize.isError, true);
  const final = snapshot(await call(client, "terminal_snapshot", { sessionId }));
  assert.equal(final.cols, 73);
  assert.equal(final.rows, 19);
  assert.ok(final.screen.every((line) => !line.includes("INPUT ") && !line.includes("SIZE ")));
});

test("missing-session input reports zero completed actions and no submitted input", async (t) => {
  const { client } = await connect(t);
  const result = await call(client, "terminal_input", {
    sessionId: "missing", actions: [{ type: "text", text: "not-sent" }],
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.code, "SESSION_NOT_FOUND");
  assert.equal(result.structuredContent?.sessionId, "missing");
  assert.equal(result.structuredContent?.actionsCompleted, 0);
  assert.equal(result.structuredContent?.inputSent, false);
});

test("a broken stdout pipe shuts down the server and its resistant process group", async (t) => {
  const child = spawn(process.execPath, [executable], { stdio: "pipe" });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = once(child, "exit");
  const reader = new ReadBuffer();
  const client = new Client({ name: "broken-pipe-test", version: "1.0.0" });
  const pids: number[] = [];
  const transport: Transport = {
    start: async () => {
      child.stdout.on("data", (chunk: Buffer) => {
        reader.append(chunk);
        let message;
        while ((message = reader.readMessage())) transport.onmessage?.(message);
      });
      child.once("exit", () => transport.onclose?.());
    },
    send: async (message) => { child.stdin.write(serializeMessage(message)); },
    close: async () => { child.stdin.end(); },
  };
  t.after(async () => {
    await client.close();
    await Promise.race([exited, delay(2000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (pids.some(alive)) process.kill(-pids[0], "SIGKILL");
  });
  await client.connect(transport);
  const { sessionId } = snapshot(await call(client, "terminal_start", {
    command: command("group"), shell: "/bin/sh", login: false, cols: 73, rows: 19,
  }));
  const ready = await observe(client, sessionId, /READY.*PID/);
  const text = ready.screen.join("\n");
  pids.push(Number(text.match(/PID (\d+)/)?.[1]), Number(text.match(/DESCENDANT (\d+)/)?.[1]));
  child.stdout.destroy();
  await assert.rejects(call(client, "terminal_snapshot", { sessionId, settleMs: 0 }));
  await exited;
  assert.doesNotMatch(stderr, /Unhandled 'error' event/);
  assert.match(stderr, /EPIPE/);
  const deadline = performance.now() + 1500;
  while (pids.some(alive) && performance.now() < deadline) await delay(10);
  assert.deepEqual(pids.filter(alive), [], "stdout failure must finish owned process-group cleanup");
});

test("a complete alternating-color 500x200 screen fits the result budget and keeps MCP usable", async (t) => {
  const { client } = await connect(t);
  const { sessionId } = snapshot(await call(client, "terminal_start", {
    command: command("dense"), shell: "/bin/sh", login: false, cols: 500, rows: 200,
  }));
  const ready = await observe(client, sessionId, /READY/);
  assert.equal(ready.settled, false, "fixture readiness must already hold its synchronized frame open");
  const result = await call(client, "terminal_input", {
    sessionId, actions: [{ type: "text", text: "draw" }], settleMs: 250, settleTimeoutMs: 30_000,
  });
  const screen = snapshot(result);
  assert.equal(screen.screen.length, 200);
  assert.equal(screen.screen[199].at(-1), "Z");
  assert.equal(screen.spans.length, 100_000);
  assert.equal(Object.keys(screen.styles).length, 2);
  assert.equal(result.structuredContent?.actionsCompleted, 1);
  assert.equal(result.structuredContent?.inputSent, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8 * 1024 * 1024);
  t.diagnostic(`Complete alternating-color result: ${Buffer.byteLength(JSON.stringify(result))} bytes`);
  const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, /1: 1=s1 2=s2/);
  const closed = await call(client, "terminal_close", { sessionId });
  assert.deepEqual(closed.structuredContent, { sessionId, closed: true });
  assert.deepEqual((await call(client, "terminal_list")).structuredContent, { sessions: [] });
});

test("oversized screens return bounded errors preserving effects and recover by resizing", async (t) => {
  const { client } = await connect(t);
  const { sessionId } = snapshot(await call(client, "terminal_start", {
    command: command("unique"), shell: "/bin/sh", login: false, cols: 500, rows: 200,
  }));
  const ready = await observe(client, sessionId, /READY/);
  assert.equal(ready.settled, false, "fixture readiness must already hold its synchronized frame open");
  const result = await call(client, "terminal_input", {
    sessionId, actions: [{ type: "text", text: "draw" }], settleMs: 250, settleTimeoutMs: 30_000,
  });
  assert.equal(result.isError, true);
  const data = result.structuredContent!;
  assert.equal(data.code, "RESULT_TOO_LARGE");
  assert.equal(data.sessionId, sessionId);
  assert.equal(data.cols, 500);
  assert.equal(data.rows, 200);
  assert.equal(data.status, "running");
  assert.equal(data.actionsCompleted, 1);
  assert.equal(data.inputSent, true);
  assert.equal(data.snapshot, undefined);
  assert.equal(data.latestSnapshot, undefined);
  assert.ok(typeof data.resultBytes === "number" && data.resultBytes > 8 * 1024 * 1024);
  assert.equal(data.limitBytes, 8 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8 * 1024 * 1024);
  t.diagnostic(`Oversized ${data.resultBytes}-byte result replaced by ${JSON.stringify(result).length}-char error`);
  const failed = await call(client, "terminal_input", {
    sessionId, actions: [
      { type: "text", text: "ignored" },
      { type: "mouse", event: "click", row: 1, column: 1 },
    ],
  });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent?.code, "RESULT_TOO_LARGE");
  const original = failed.structuredContent?.originalError as Record<string, unknown>;
  assert.equal(original.code, "UNSUPPORTED_INPUT");
  assert.match(String(original.message), /mouse/i);
  assert.equal(failed.structuredContent?.actionsCompleted, 1);
  assert.equal(failed.structuredContent?.inputSent, true);
  assert.equal(failed.structuredContent?.failedActionIndex, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(failed)) <= 8 * 1024 * 1024);
  const resized = await call(client, "terminal_resize", { sessionId, cols: 499, rows: 200 });
  assert.equal(resized.structuredContent?.code, "RESULT_TOO_LARGE");
  assert.equal(resized.structuredContent?.cols, 499);
  assert.equal(resized.structuredContent?.rows, 200);
  const listed = (await call(client, "terminal_list")).structuredContent?.sessions as Array<Record<string, unknown>>;
  assert.equal(listed[0].sessionId, sessionId);
  assert.equal(listed[0].cols, 499);
  const recovered = snapshot(await call(client, "terminal_resize", { sessionId, cols: 73, rows: 19 }));
  assert.equal(recovered.cols, 73);
  assert.equal(recovered.rows, 19);
  assert.ok(recovered.spans.length > 0);
  const closed = await call(client, "terminal_close", { sessionId });
  assert.deepEqual(closed.structuredContent, { sessionId, closed: true });
});
