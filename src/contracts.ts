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
