import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.ok(process.argv.length <= 3, "Usage: npm run test:package -- [package.tgz]");
const temporary = await mkdtemp(join(tmpdir(), "terminal-emulator-mcp-package-"));
const consumer = join(temporary, "consumer");
const environment = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;

function run(command, args, cwd = consumer, inherit = false) {
  const result = spawnSync(command, args, {
    cwd, env: environment, encoding: "utf8", timeout: 180_000, stdio: inherit ? "inherit" : "pipe",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result.stdout;
}

async function files(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), `${relative}/`));
    else result.push(relative);
  }
  return result;
}

try {
  const tarball = process.argv[2] ? resolve(process.argv[2]) : join(temporary, JSON.parse(run(
    "npm", ["pack", "--json", "--pack-destination", temporary], root,
  ))[0].filename);
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "terminal-emulator-mcp-package-check",
    private: true,
    type: "module",
    allowScripts: manifest.allowScripts,
  }));
  run("npm", [
    "install", "--omit=dev", "--no-audit", "--no-fund", "--foreground-scripts", tarball,
  ], consumer, true);

  const installedRoot = join(consumer, "node_modules", manifest.name);
  const installed = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  assert.equal(installed.name, manifest.name);
  assert.equal(installed.version, manifest.version);
  for (const path of await files(installedRoot)) {
    assert.ok(
      ["package.json", "README.md", "LICENSE"].includes(path) || /^dist\/src\/[^/]+\.js$/.test(path),
      `Unexpected published file: ${path}`,
    );
  }
  for (const required of ["README.md", "LICENSE", installed.bin[installed.name]]) {
    await access(join(installedRoot, required));
  }
  const dependencies = JSON.parse(run("npm", ["ls", "--omit=dev", "--all", "--json"]));
  function checkDependencies(tree) {
    for (const [name, dependency] of Object.entries(tree.dependencies ?? {})) {
      assert.ok(!["typescript", "tsx", "ts-node"].includes(name), `Development runtime installed: ${name}`);
      checkDependencies(dependency);
    }
  }
  checkDependencies(dependencies);
  const executable = join(consumer, "node_modules", ".bin", installed.name);
  await access(executable, constants.X_OK);
  const version = run(executable, ["--version"]).trim();
  assert.equal(version, installed.version);
  const help = run(executable, ["--help"]);
  assert.ok(help.includes(`${installed.name} ${installed.version}`), help);
  assert.ok(help.includes(`Usage: ${installed.name}`), help);

  const requireInstalled = createRequire(join(installedRoot, "package.json"));
  if (process.platform === "darwin") {
    const nativeRoot = dirname(requireInstalled.resolve("node-pty/package.json"));
    await access(join(nativeRoot, "prebuilds", `darwin-${process.arch}`, "spawn-helper"), constants.X_OK);
  }
  const { Client } = await import(pathToFileURL(requireInstalled.resolve("@modelcontextprotocol/sdk/client/index.js")));
  const { StdioClientTransport } = await import(pathToFileURL(
    requireInstalled.resolve("@modelcontextprotocol/sdk/client/stdio.js"),
  ));
  const fixture = join(consumer, "terminal-child.mjs");
  await writeFile(fixture, `
process.stdin.setRawMode(true);
process.stdin.resume();
let input = Buffer.alloc(0);
process.stdin.on("data", (bytes) => {
  input = Buffer.concat([input, bytes]);
  process.stdout.write("INPUT " + input.toString("hex") + "\\r\\n");
});
process.stdout.on("resize", () => {
  process.stdout.write("SIZE " + process.stdout.columns + "x" + process.stdout.rows + "\\r\\n");
});
process.stdout.write("\\x1b[31mSTYLED\\x1b[0m\\r\\n");
process.stdout.write("READY " + process.stdout.columns + "x" + process.stdout.rows + "\\r\\n");
`);
  const client = new Client({ name: "packed-package-check", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: executable, cwd: consumer, env: environment, stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

  async function call(name, args = {}) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(result.structuredContent, JSON.stringify(result));
    return result.structuredContent;
  }
  async function observe(sessionId, pattern) {
    const deadline = performance.now() + 10_000;
    let snapshot;
    do {
      snapshot = await call("terminal_snapshot", { sessionId, settleMs: 0 });
      if (pattern.test(snapshot.screen.join("\n"))) return snapshot;
      await delay(20);
    } while (performance.now() < deadline);
    assert.fail(`Missing ${pattern}: ${JSON.stringify(snapshot)}`);
  }
  try {
    await client.connect(transport);
    assert.deepEqual(client.getServerVersion(), { name: installed.name, version: installed.version });
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
      "terminal_close", "terminal_input", "terminal_list", "terminal_resize", "terminal_snapshot", "terminal_start",
    ]);
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const { sessionId } = await call("terminal_start", {
      command: `exec ${quote(process.execPath)} ${quote(fixture)}`,
      shell: "/bin/sh", login: false, cols: 73, rows: 19,
    });
    const initial = await observe(sessionId, /READY 73x19/);
    assert.equal(initial.screen[0], "STYLED");
    const styled = initial.spans.find((span) => span.row === 1 && span.startColumn === 1 && span.endColumn === 6);
    assert.ok(styled, JSON.stringify(initial.spans));
    assert.deepEqual(initial.styles[styled.styleId].foreground, { kind: "palette", index: 1 });
    const input = await call("terminal_input", {
      sessionId, actions: [{ type: "text", text: "A" }, { type: "key", key: "Enter" }],
    });
    assert.equal(input.actionsCompleted, 2);
    assert.equal(input.inputSent, true);
    await observe(sessionId, /INPUT 410d/);
    const resized = await call("terminal_resize", { sessionId, cols: 91, rows: 27 });
    assert.equal(resized.cols, 91);
    assert.equal(resized.rows, 27);
    await observe(sessionId, /SIZE 91x27/);
    const history = await call("terminal_snapshot", { sessionId, scrollbackLines: 10 });
    assert.equal(history.screen.length, 27);
    assert.deepEqual(history.history, { lines: [], availableLines: 0 });
    const listed = await call("terminal_list");
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].sessionId, sessionId);
    assert.equal(listed.sessions[0].status, "running");
    assert.equal(listed.sessions[0].cols, 91);
    assert.deepEqual(await call("terminal_close", { sessionId }), { sessionId, closed: true });
    assert.deepEqual(await call("terminal_list"), { sessions: [] });
  } finally {
    await client.close();
  }
  assert.equal(stderr, "");
  console.log(`Packed ${installed.name}@${installed.version}: executable, production dependencies, and MCP passed.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
