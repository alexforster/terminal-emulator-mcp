#!/usr/bin/env node
import { parseArgs } from "node:util";
import { packageInfo } from "./package-info.js";

function diagnostic(error: unknown): void {
  console.error(`${packageInfo.name}:`, error);
}

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      options: { help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } },
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(`${packageInfo.name}: ${(error as Error).message}\nRun ${packageInfo.name} --help for usage.`);
    process.exitCode = 1;
    return;
  }
  if (values.help) {
    console.log(`${packageInfo.name} ${packageInfo.version}

${packageInfo.description}

Usage: ${packageInfo.name} [options]

With no options, starts an MCP server over stdio.

Options:
  -h, --help     Show this help
  -v, --version  Show the package version`);
    return;
  }
  if (values.version) {
    console.log(packageInfo.version);
    return;
  }

  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { createServer } = await import("./server.js");
  const { SessionRegistry } = await import("./session.js");
  const registry = new SessionRegistry();
  const server = createServer(registry);
  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | undefined;

  function shutdown(): Promise<void> {
    shutdownPromise ??= Promise.resolve().then(async () => {
      try {
        await server.close();
      } finally {
        await registry.closeAll();
      }
    }).catch((error: unknown) => {
      diagnostic(error);
      process.exitCode = 1;
    });
    return shutdownPromise;
  }

  server.server.onerror = diagnostic;
  server.server.onclose = () => { void shutdown(); };
  process.stdin.once("end", () => { void shutdown(); });
  process.stdout.on("error", (error: Error) => {
    diagnostic(error);
    process.exitCode = 1;
    void shutdown();
  });
  process.on("SIGHUP", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });

  try {
    await server.connect(transport);
  } catch (error) {
    diagnostic(error);
    process.exitCode = 1;
    await shutdown();
  }
}

main().catch((error: unknown) => {
  diagnostic(error);
  process.exitCode = 1;
});
