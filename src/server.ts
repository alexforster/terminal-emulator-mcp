import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodError } from "zod";
import {
  InputSchema, ResizeSchema, SessionIdSchema, SnapshotSchema, StartSchema,
  ToolError, type BatchProgress, type TerminalSnapshot,
} from "./contracts.js";
import type { SessionRegistry } from "./session.js";
import { packageInfo } from "./package-info.js";

const resultByteLimit = 8 * 1024 * 1024;

function summary(value: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of [
    "sessionId", "cols", "rows", "status", "exitCode", "signal", "actionsCompleted", "inputSent", "failedActionIndex",
  ]) {
    if (value[key] === undefined) continue;
    const field = value[key];
    fields[key] = typeof field === "string" ? field.slice(0, 1024) : field;
    if (typeof field === "string" && field.length > 1024) fields[`${key}Truncated`] = true;
  }
  return fields;
}

function formatResult(value: object, isError = false): CallToolResult {
  const structuredContent: Record<string, unknown> = { ...value };
  const screen = ("screen" in value ? value : structuredContent.snapshot ?? structuredContent.latestSnapshot) as
    TerminalSnapshot | undefined;
  let text: string;
  if (screen) {
    const { screen: lines, styles, spans, history, ...state } = screen;
    const { snapshot: _snapshot, latestSnapshot: _latest, ...metadata } = structuredContent;
    const header = screen === value ? state : { ...metadata, ...state };
    const spanRows = new Map<number, string[]>();
    for (const { row, startColumn, endColumn, styleId } of spans) {
      const columns = startColumn === endColumn ? `${startColumn}` : `${startColumn}-${endColumn}`;
      if (!spanRows.has(row)) spanRows.set(row, []);
      spanRows.get(row)!.push(`${columns}=${styleId}`);
    }
    text = [
      JSON.stringify(header, null, 2),
      ...lines.map((line, index) => `${index + 1}: ${line}`),
      `styles: ${JSON.stringify(styles)}`,
      "spans (row: column[-column]=style):",
      ...Array.from(spanRows, ([row, columns]) => `${row}: ${columns.join(" ")}`),
      ...(history ? [
        `history (${history.lines.length} of ${history.availableLines} available lines):`,
        ...history.lines,
      ] : []),
    ].join("\n");
  } else {
    text = JSON.stringify(value, null, 2);
  }
  const formatted: CallToolResult = {
    structuredContent, content: [{ type: "text", text }], ...(isError && { isError }),
  };
  const resultBytes = Buffer.byteLength(JSON.stringify(formatted));
  if (resultBytes <= resultByteLimit) return formatted;
  const originalMessage = String(structuredContent.message ?? "");
  const failure = {
    ...summary({ ...structuredContent, ...screen }),
    code: "RESULT_TOO_LARGE",
    message: "The complete result exceeds 8 MiB. Screen and history are omitted; no input or resize is undone. "
      + "Resize the session or request less history to recover.",
    resultBytes,
    limitBytes: resultByteLimit,
    ...(isError && {
      originalError: {
        code: structuredContent.code,
        message: originalMessage.slice(0, 1024),
        ...(originalMessage.length > 1024 && { messageTruncated: true }),
      },
    }),
    ...(Array.isArray(structuredContent.sessions) && {
      sessions: structuredContent.sessions.map((session) => summary(session)),
    }),
  };
  return {
    structuredContent: failure, content: [{ type: "text", text: JSON.stringify(failure, null, 2) }], isError: true,
  };
}

async function result(
  operation: () => object | Promise<object>, initialProgress?: BatchProgress,
): Promise<CallToolResult> {
  try {
    return formatResult(await operation());
  } catch (error) {
    const failure = error instanceof ToolError ? error : error instanceof ZodError
      ? new ToolError("INVALID_INPUT", error.message)
      : new ToolError("IO_ERROR", `Terminal operation failed: ${String(error)}`);
    return formatResult({
      ...initialProgress, ...failure.details, code: failure.code, message: failure.message,
    }, true);
  }
}

export function createServer(registry: SessionRegistry): McpServer {
  const server = new McpServer({ name: packageInfo.name, version: packageInfo.version }, {
    instructions: "Start a terminal with explicit columns and rows, then inspect its screen and send ordered actions. "
      + "Coordinates are 1-based terminal cells. Snapshots include styles and spans, including styled blank cells. "
      + "Observations default to 250 ms of visible quiet within 1,000 ms; settlement is not application completion. "
      + "An explicit settleTimeoutMs requires settlement. Timeouts preserve sessions and applied input or resize; "
      + "inspect latestSnapshot, inputSent, and actionsCompleted before retrying. RESULT_TOO_LARGE preserves "
      + "effects and session metadata; recover by resizing or requesting less history. Close sessions when finished.",
  });

  server.registerTool("terminal_start", {
    description: "Run command through shell -l -c in a new terminal and return its styled screen and sessionId. "
      + "Example: {command:\"claude\",cols:120,rows:40}. shell defaults to SHELL or /bin/sh; cwd defaults to "
      + "the server directory. login defaults to true; false skips -l. The shell is not made interactive. "
      + "Use a shell supporting -l -c, such as bash, zsh, dash, or fish. "
      + "env overrides inherited variables; null deletes a variable. TERM is fixed to "
      + "xterm-256color. A strict observation timeout retains the allocated session for inspection.",
    inputSchema: StartSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (raw, extra) => result(async () => {
    const args = StartSchema.parse(raw);
    const session = registry.start(args);
    const { settleMs, settleTimeoutMs } = args;
    return session.snapshot({ settleMs, settleTimeoutMs }, 0, extra.signal);
  }));

  server.registerTool("terminal_snapshot", {
    description: "Observe the current terminal screen, styles, cursor, and process status without sending input. "
      + "Optionally request up to 2,000 normal-buffer scrollback lines. settleMs:0 captures without a quiet wait. "
      + "An exited process keeps its final screen until the session is closed.",
    inputSchema: SnapshotSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (raw, extra) => result(() => {
    const args = SnapshotSchema.parse(raw);
    const { settleMs, settleTimeoutMs } = args;
    return registry.get(args.sessionId).snapshot({ settleMs, settleTimeoutMs }, args.scrollbackLines, extra.signal);
  }));

  server.registerTool("terminal_input", {
    description: "Send an ordered batch of actions and return its styled screen, actionsCompleted, and inputSent. "
      + "text sends exact Unicode; paste normalizes newlines and honors bracketed-paste mode. key sends named keys "
      + "or printable ASCII with supported modifiers. mouse clicks/wheels require application reporting and "
      + "cell coordinates; disabled reporting, pixel mode, and unsupported X10 actions fail. focus is a no-op "
      + "unless reporting is enabled. raw sends bytes. wait delays with durationMs or observes with timing options. "
      + "Example actions: [{type:\"key\",key:\"F2\"},{type:\"wait\"},{type:\"key\",key:\"Down\"}]. "
      + "Modes are checked per action; response waits are explicit. A settling error does not undo input; "
      + "inspect inputSent, actionsCompleted, and zero-based failedActionIndex before retrying.",
    inputSchema: InputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (raw, extra) => result(() => {
    const args = InputSchema.parse(raw);
    return registry.get(args.sessionId).input(args.actions, args, extra.signal);
  }, { actionsCompleted: 0, inputSent: false }));

  server.registerTool("terminal_resize", {
    description: "Resize the child terminal and emulated screen, then observe the result. "
      + "The child receives its terminal-size notification. A strict timeout retains the applied dimensions "
      + "in latestSnapshot; it does not undo the resize.",
    inputSchema: ResizeSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, (raw, extra) => result(() => {
    const args = ResizeSchema.parse(raw);
    return registry.get(args.sessionId).resize(args.cols, args.rows, args, extra.signal);
  }));

  server.registerTool("terminal_list", {
    description: "List retained terminal sessions with IDs, commands, working directories, dimensions, and "
      + "process status. Exited sessions count toward the eight-session limit until closed.",
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => result(() => ({ sessions: registry.list() })));

  server.registerTool("terminal_close", {
    description: "Close a terminal, cancel pending work, terminate its process group, and release its screen. "
      + "Returns {sessionId,closed}; an unknown or already-closed ID returns closed:false.",
    inputSchema: SessionIdSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, (raw) => result(async () => {
    const { sessionId } = SessionIdSchema.parse(raw);
    return { sessionId, closed: await registry.close(sessionId) };
  }));
  return server;
}
