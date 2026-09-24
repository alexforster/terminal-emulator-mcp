import { z } from "zod";
import { encodeKey, MODIFIERS, NAMED_KEYS } from "./keys.js";

export interface ObservationOptions {
  settleMs?: number;
  settleTimeoutMs?: number;
}

export type MouseTracking = "none" | "x10" | "vt200" | "drag" | "any";
export type MouseEncoding = "legacy" | "sgr" | "sgr-pixels";

export interface InputModes {
  cols: number;
  rows: number;
  applicationCursorKeys: boolean;
  bracketedPaste: boolean;
  focusReporting: boolean;
  mouseTracking: MouseTracking;
  mouseEncoding: MouseEncoding;
}

export interface CellStyle {
  foreground?: { kind: "palette"; index: number } | { kind: "rgb"; value: string };
  background?: { kind: "palette"; index: number } | { kind: "rgb"; value: string };
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  blink?: true;
  inverse?: true;
  invisible?: true;
  strikethrough?: true;
  overline?: true;
}

export interface ScreenState {
  cols: number;
  rows: number;
  buffer: "normal" | "alternate";
  screen: string[];
  cursor: { row: number; column: number; visible: boolean };
  styles: Record<string, CellStyle>;
  spans: Array<{ row: number; startColumn: number; endColumn: number; styleId: string }>;
  mouse: { tracking: MouseTracking; encoding: MouseEncoding };
  history?: { lines: string[]; availableLines: number };
}

export interface ObservedScreen extends ScreenState {
  settled: boolean;
}

export interface TerminalSnapshot extends ObservedScreen {
  sessionId: string;
  status: "running" | "exited";
  exitCode?: number;
  signal?: number;
}

export interface BatchProgress {
  actionsCompleted: number;
  inputSent: boolean;
  failedActionIndex?: number;
}

export interface SessionInfo {
  sessionId: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  status: "running" | "exited";
  exitCode?: number;
  signal?: number;
}

export type ErrorCode =
  | "SESSION_NOT_FOUND" | "SESSION_EXITED" | "SESSION_CLOSED" | "SESSION_LIMIT"
  | "SPAWN_FAILED" | "INVALID_INPUT" | "UNSUPPORTED_INPUT" | "SCREEN_NOT_SETTLED"
  | "REQUEST_CANCELLED" | "IO_ERROR";

export interface ErrorDetails extends Partial<BatchProgress> {
  sessionId?: string;
  latestSnapshot?: TerminalSnapshot;
}

export class ToolError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details: ErrorDetails = {}) {
    super(message);
    this.name = "ToolError";
  }
}

const inputByteLimit = 1_048_576;
const milliseconds = z.number().int().min(0).max(60_000);
const columns = z.number().int().min(2).max(500);
const rows = z.number().int().min(1).max(200);

export const ObservationShape = {
  settleMs: milliseconds.optional(),
  settleTimeoutMs: z.number().int().min(1).max(60_000).optional(),
};

function validateObservation(options: ObservationOptions, context: z.RefinementCtx): void {
  if (options.settleTimeoutMs !== undefined && options.settleTimeoutMs < (options.settleMs ?? 250)) {
    context.addIssue({
      code: "custom", path: ["settleTimeoutMs"],
      message: "settleTimeoutMs must be at least settleMs (250 ms when omitted)",
    });
  }
}

export const ObservationSchema = z.strictObject(ObservationShape).superRefine(validateObservation);
const modifiers = z.array(z.enum(MODIFIERS)).max(3).default([]).refine(
  (values) => new Set(values).size === values.length,
  "Duplicate modifiers are invalid",
);
const payloadText = z.string().max(inputByteLimit).refine(
  (value) => Buffer.byteLength(value, "utf8") <= inputByteLimit,
  "Text payload exceeds 1 MiB of UTF-8",
);
const textAction = z.strictObject({ type: z.literal("text"), text: payloadText });
const pasteAction = z.strictObject({ type: z.literal("paste"), text: payloadText });
const keyAction = z.strictObject({
  type: z.literal("key"),
  key: z.union([z.enum(NAMED_KEYS), z.string().regex(/^[\x20-\x7e]$/)]),
  modifiers,
}).superRefine((action, context) => {
  try {
    encodeKey(action.key, action.modifiers, false);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    context.addIssue({ code: "custom", message: error.message });
  }
}).describe(
  "Navigation and function keys accept all modifier subsets. Printable ASCII accepts Alt; Shift is unsupported: "
  + "supply the resulting character. Ctrl supports letters, space, @, [, backslash, ], ^, _, and ?. "
  + "Enter/Escape accept only Alt; Tab accepts only Shift; Backspace/Space accept Ctrl and Alt.",
);
const mousePosition = {
  row: rows,
  column: z.number().int().min(1).max(500),
  modifiers,
};
const mouseAction = z.discriminatedUnion("event", [
  z.strictObject({
    type: z.literal("mouse"), event: z.literal("click"), ...mousePosition,
    button: z.enum(["left", "middle", "right"]).default("left"),
  }),
  z.strictObject({
    type: z.literal("mouse"), event: z.literal("scroll"), ...mousePosition,
    direction: z.enum(["up", "down"]),
    count: z.number().int().min(1).max(100).default(1),
  }),
]);
const waitAction = z.union([
  z.strictObject({ type: z.literal("wait"), durationMs: milliseconds }),
  z.strictObject({ type: z.literal("wait"), ...ObservationShape }).superRefine(validateObservation),
]);
const focusAction = z.strictObject({ type: z.literal("focus"), focused: z.boolean() });
const rawAction = z.strictObject({
  type: z.literal("raw"),
  bytes: z.array(z.number().int().min(0).max(255)).max(inputByteLimit),
});

export const InputActionSchema = z.union([
  z.discriminatedUnion("type", [textAction, pasteAction, keyAction, mouseAction, focusAction, rawAction]),
  waitAction,
]);
export type InputAction = z.infer<typeof InputActionSchema>;

export const SessionIdShape = { sessionId: z.string().min(1) };
export const SessionIdSchema = z.strictObject(SessionIdShape);
export const StartShape = {
  command: z.string().min(1),
  cols: columns,
  rows,
  shell: z.string().min(1).optional(),
  login: z.boolean().default(true),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string().nullable()).refine(
    (env) => !Object.hasOwn(env, "TERM"), "TERM is fixed to xterm-256color and cannot be overridden",
  ).optional(),
  ...ObservationShape,
};
export const StartSchema = z.strictObject(StartShape).superRefine(validateObservation);
export type StartOptions = z.input<typeof StartSchema>;

export const SnapshotShape = {
  ...SessionIdShape,
  scrollbackLines: z.number().int().min(0).max(2000).optional(),
  ...ObservationShape,
};
export const SnapshotSchema = z.strictObject(SnapshotShape).superRefine(validateObservation);
export const InputShape = {
  ...SessionIdShape,
  actions: z.array(InputActionSchema).min(1).max(256),
  ...ObservationShape,
};
export const InputSchema = z.strictObject(InputShape).superRefine(validateObservation).superRefine((input, context) => {
  let bytes = 0;
  for (const action of input.actions) {
    if (action.type === "text" || action.type === "paste") bytes += Buffer.byteLength(action.text, "utf8");
    if (action.type === "raw") bytes += action.bytes.length;
  }
  if (bytes > inputByteLimit) {
    context.addIssue({ code: "custom", path: ["actions"], message: "Text, paste, and raw payload exceeds 1 MiB" });
  }
});
export const ResizeShape = { ...SessionIdShape, cols: columns, rows, ...ObservationShape };
export const ResizeSchema = z.strictObject(ResizeShape).superRefine(validateObservation);
