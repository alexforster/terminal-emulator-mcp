import { spawn } from "node:child_process";
import { once } from "node:events";

const mode = process.argv[2] ?? "input";
process.stdin.setRawMode?.(true);
process.stdin.resume();

if (mode === "ignore-hup" || mode === "descendant") {
  process.on("SIGHUP", () => {});
}
if (mode === "descendant") setInterval(() => {}, 1000);

process.on("SIGWINCH", () => {
  process.stdout.write(`SIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`);
});

if (mode === "group") {
  const child = spawn(process.execPath, [process.argv[1], "descendant"], { stdio: ["ignore", "pipe", "inherit"] });
  await once(child.stdout, "data");
  process.stdout.write(`DESCENDANT ${child.pid}\r\n`);
}

process.stdout.write(`READY ${process.stdout.columns}x${process.stdout.rows} PID ${process.pid}\r\n`);

switch (mode) {
  case "environment":
    process.stdout.write(`OVERRIDE ${process.env.TERMINAL_EMULATOR_MCP_OVERRIDE}\r\n`);
    process.stdout.write(`DELETED ${Object.hasOwn(process.env, "TERMINAL_EMULATOR_MCP_DELETE")}\r\n`);
    process.stdout.write(`TERM ${process.env.TERM}\r\n`);
    process.stdout.write(`CWD ${process.cwd()}\r\n`);
    break;
  case "query": {
    let input = "";
    process.stdin.on("data", (bytes: Buffer) => {
      input += bytes.toString("utf8");
      if (input.includes("\x1b[2;3R")) process.stdout.write("QUERY_OK\r\n");
    });
    process.stdout.write("\x1b[2;3H\x1b[6n");
    break;
  }
  case "exit":
    process.stdout.write("\x1b[31mFINAL\x1b[0m\r\n", () => {
      process.exitCode = 7;
      process.stdin.pause();
    });
    break;
  case "burst":
    for (let i = 0; i < 128; i++) {
      if (!process.stdout.write("x".repeat(16_384))) await once(process.stdout, "drain");
    }
    process.stdout.write("\r\nBURST_COMPLETE\r\n");
    break;
  case "synchronized":
    process.stdout.write("\x1b[?2026hUNFINISHED\r\n");
    break;
  default:
    process.stdin.on("data", (bytes: Buffer) => {
      if (bytes.includes(3)) {
        process.stdout.write("FINAL\r\n", () => {
          process.exitCode = 7;
          process.stdin.pause();
        });
      } else {
        process.stdout.write(`INPUT ${bytes.toString("hex")}\r\n`);
      }
    });
}
