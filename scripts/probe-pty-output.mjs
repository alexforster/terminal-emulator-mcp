import { createRequire } from "node:module";
import { release } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pty from "node-pty";

const cases = [
  {
    name: "split-writes", command: "/bin/sh",
    args: ["-c", 'printf "PROFILE unset\\n"; printf "INTERACTIVE no\\n"'],
    expected: "PROFILE unset\r\nINTERACTIVE no\r\n",
  },
  {
    name: "64k-exit", command: process.execPath,
    args: ["-e", `
      const { writeSync } = require("node:fs");
      const block = Buffer.from("0123456789abcdef".repeat(16));
      for (let i = 0; i < 256; i++) {
        let offset = 0;
        while (offset < block.length) offset += writeSync(1, block, offset, block.length - offset);
      }
      process.exit(0);
    `],
    expected: "0123456789abcdef".repeat(4096),
  },
];
const activeChildren = new Set();
const failureLimit = 10;

export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      iterations: { type: "string", default: "100" },
      concurrency: { type: "string", default: "4" },
      "timeout-ms": { type: "string", default: "5000" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const bounded = (name, maximum) => {
    const value = values[name];
    if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum) {
      throw new Error(`--${name} must be an integer from 1 to ${maximum}`);
    }
    return Number(value);
  };
  return {
    iterations: bounded("iterations", 100_000), concurrency: bounded("concurrency", 32),
    timeoutMs: bounded("timeout-ms", 60_000), help: values.help,
  };
}

export function outputDifference(expected, actual, receivedBytes = Buffer.byteLength(actual)) {
  const wanted = Buffer.from(expected);
  const received = Buffer.from(actual);
  if (receivedBytes === wanted.length && wanted.equals(received)) return null;
  let firstDifference = 0;
  while (firstDifference < Math.min(wanted.length, received.length)
    && wanted[firstDifference] === received[firstDifference]) firstDifference++;
  return {
    expectedBytes: wanted.length, receivedBytes, firstDifference,
    expectedAtDifference: wanted.subarray(firstDifference, firstDifference + 96).toString("utf8"),
    receivedAtDifference: received.subarray(firstDifference, firstDifference + 96).toString("utf8"),
  };
}

function kill(child) {
  try {
    child.kill("SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") return String(error.message).slice(0, 256);
  }
}

export function runCase(scenario, { timeoutMs, signal }) {
  const started = performance.now();
  const env = { ...process.env };
  for (const name of ["ENV", "BASH_ENV", "NODE_OPTIONS", "NODE_PATH"]) delete env[name];
  return new Promise((resolve) => {
    let child;
    try {
      child = pty.spawn(scenario.command, scenario.args, {
        name: "xterm-256color", cols: 73, rows: 19, env, handleFlowControl: false,
      });
    } catch (error) {
      resolve({ failure: "spawn", error: String(error.message).slice(0, 256) });
      return;
    }
    activeChildren.add(child);
    const output = Buffer.alloc(Buffer.byteLength(scenario.expected) + 1);
    let retained = 0;
    let receivedBytes = 0;
    let chunks = 0;
    let firstDataMs = null;
    let lastDataMs = null;
    let stopped;
    let killError;
    let cleanupTimer;
    let finished = false;
    const dataListener = child.onData((data) => {
      const bytes = Buffer.from(data);
      retained += bytes.copy(output, retained);
      receivedBytes += bytes.length;
      chunks++;
      lastDataMs = performance.now() - started;
      firstDataMs ??= lastDataMs;
    });
    const finish = (exit, cleanupTimedOut = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener("abort", abort);
      dataListener.dispose();
      exitListener.dispose();
      if (!cleanupTimedOut) activeChildren.delete(child);
      const difference = outputDifference(scenario.expected, output.subarray(0, retained), receivedBytes);
      resolve({
        failure: cleanupTimedOut ? "cleanup-timeout" : stopped
          ?? (exit.exitCode !== 0 || exit.signal ? "exit" : difference ? "output" : null),
        pid: child.pid, exit, chunks, firstDataMs, lastDataMs,
        elapsedMs: performance.now() - started, difference, killError,
      });
    };
    const stop = (reason) => {
      if (stopped || finished) return;
      stopped = reason;
      killError = kill(child);
      cleanupTimer = setTimeout(() => finish(null, true), 1000);
    };
    const abort = () => stop("interrupted");
    const exitListener = child.onExit((exit) => finish(exit));
    const timeout = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: npm run test:pty-output -- [options]
  --iterations N   Runs per case (1–100000, default 100)
  --concurrency N  Maximum simultaneous children (1–32, default 4)
  --timeout-ms N   Per-child timeout (1–60000, default 5000)
  -h, --help       Show this help

Both cases run in every iteration. JSON lines report the runtime, failures, and summary.
A passing run is evidence for this workload, not proof that output loss is fixed.`);
    return;
  }
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("This probe requires macOS or Linux");
  const started = performance.now();
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const cleanup = () => { for (const child of activeChildren) kill(child); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  process.on("exit", cleanup);
  const stats = Object.fromEntries(cases.map(({ name }) => [name, { completed: 0, failures: 0, chunks: 0 }]));
  let next = 0;
  let failures = 0;
  let reportedFailures = 0;
  console.log(JSON.stringify({
    event: "start", platform: process.platform, arch: process.arch, kernel: release(),
    node: process.version, libuv: process.versions.uv, versions: process.versions,
    nodePty: createRequire(import.meta.url)("node-pty/package.json").version,
    ...options, plannedRuns: options.iterations * cases.length,
    cases: cases.map(({ name, expected }) => ({ name, expectedBytes: Buffer.byteLength(expected) })),
  }));
  try {
    await Promise.all(Array.from({ length: options.concurrency }, async () => {
      while (!controller.signal.aborted && next < options.iterations * cases.length) {
        const index = next++;
        const scenario = cases[index % cases.length];
        const result = await runCase(scenario, { ...options, signal: controller.signal });
        const stat = stats[scenario.name];
        stat.completed++;
        stat.chunks += result.chunks ?? 0;
        if (result.failure) {
          stat.failures++;
          failures++;
          if (reportedFailures++ < failureLimit) {
            console.log(JSON.stringify({
              event: "failure", case: scenario.name, iteration: Math.floor(index / cases.length) + 1, ...result,
            }));
          }
          if (["spawn", "cleanup-timeout"].includes(result.failure)) controller.abort();
        }
      }
    }));
  } finally {
    cleanup();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("exit", cleanup);
  }
  const summary = {
    event: "summary", iterations: options.iterations, concurrency: options.concurrency, started: next,
    failures, omittedFailureDetails: Math.max(0, reportedFailures - failureLimit),
    interrupted: controller.signal.aborted, elapsedMs: performance.now() - started, cases: stats,
  };
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify(summary)}\n`, resolve));
  process.exitCode = failures || controller.signal.aborted ? 1 : 0;
  // An unresponsive PTY must not keep the diagnostic alive after its child has been killed.
  if (activeChildren.size) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    for (const child of activeChildren) kill(child);
    console.error(String(error.message));
    process.exitCode = 1;
    if (activeChildren.size) process.exit(1);
  });
}
