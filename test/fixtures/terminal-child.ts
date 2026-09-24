import { spawn } from "node:child_process";
import { once } from "node:events";

const mode = process.argv[2] ?? "input";
process.stdin.setRawMode?.(true);
process.stdin.resume();

if (mode === "ignore-hup" || mode === "descendant") {
  process.on("SIGHUP", () => {});
}
if (mode === "descendant") setInterval(() => {}, 1000);

process.stdout.on("resize", () => {
  process.stdout.write(`SIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`);
});

if (mode === "group") {
  const child = spawn(process.execPath, [process.argv[1], "descendant"], { stdio: ["ignore", "pipe", "inherit"] });
  await once(child.stdout, "data");
  process.stdout.write(`DESCENDANT ${child.pid}\r\n`);
}

if (mode === "dense" || mode === "unique") process.stdout.write("\x1b[?2026h");
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
  case "animate":
    process.stdin.once("data", () => {
      let frame = 0;
      setInterval(() => process.stdout.write(`\x1b[HFRAME ${++frame}`), 25);
    });
    break;
  case "record":
  case "modes": {
    let received = Buffer.alloc(0);
    process.stdin.on("data", (bytes: Buffer) => {
      received = Buffer.concat([received, bytes]);
      if (mode === "modes") process.stdout.write("\x1b[?1h\x1b[?2004h\x1b[?1004h");
      process.stdout.write(`BYTES ${received.toString("hex")}\r\n`);
    });
    break;
  }
  case "dense":
  case "unique":
    process.stdin.on("data", (bytes: Buffer) => {
      if (!bytes.toString().includes("draw")) return;
      const count = mode === "dense" ? 100_000 : 50_000;
      const cells = Array.from({ length: count }, (_, index) => {
        const color = mode === "dense" ? `3${index % 2 + 1}` :
          `38;2;${index >> 16};${index >> 8 & 255};${index & 255}`;
        return `\x1b[${color}m${index === count - 1 ? "Z" : "x"}`;
      });
      process.stdout.write(`\x1b[0m\x1b[2J\x1b[H\x1b[?2026h${cells.join("")}\x1b[?2026l`);
    });
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
