import xterm from "@xterm/headless";
import type { IDisposable } from "@xterm/headless";
import { ToolError, type InputModes, type MouseEncoding, type ScreenState } from "./contracts.js";
import { captureScreen, visibleFingerprint } from "./snapshot.js";

interface DrainWaiter {
  sequence: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class TerminalModel {
  private readonly terminal: xterm.Terminal;
  private received = 0;
  private parsed = 0;
  private pendingBytes = 0;
  private disposed = false;
  private cursorVisible = true;
  private mouseEncoding: MouseEncoding = "legacy";
  private fingerprint: string;
  private readonly drainWaiters = new Set<DrainWaiter>();
  private readonly responseListeners = new Set<(data: string) => void>();
  private readonly pendingBytesListeners = new Set<(bytes: number) => void>();
  private readonly listeners: IDisposable[];

  constructor(cols: number, rows: number) {
    this.terminal = new xterm.Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
    this.fingerprint = visibleFingerprint(this.capture());
    const parser = this.terminal.parser;
    this.listeners = [
      this.terminal.onData((data) => {
        for (const listener of this.responseListeners) listener(data);
      }),
      parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => this.observeModes(params, true)),
      parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => this.observeModes(params, false)),
      parser.registerEscHandler({ final: "c" }, () => {
        // Headless 6.0.0 preserves cursor visibility on a full reset.
        this.mouseEncoding = "legacy";
        return false;
      }),
      parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
        this.cursorVisible = true;
        return false;
      }),
    ];
  }

  write(data: string): void {
    this.assertOpen();
    const sequence = ++this.received;
    const bytes = Buffer.byteLength(data, "utf8");
    this.pendingBytes += bytes;
    this.terminal.write(data, () => {
      if (this.disposed) return;
      this.parsed = sequence;
      this.pendingBytes -= bytes;
      this.fingerprint = visibleFingerprint(this.capture());
      this.notifyPendingBytes();
      for (const waiter of this.drainWaiters) {
        if (waiter.sequence <= this.parsed) {
          waiter.resolve();
        }
      }
    });
    this.notifyPendingBytes();
  }

  drain(signal?: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.reject(new ToolError("SESSION_CLOSED", "The terminal is closed."));
    if (signal?.aborted) return Promise.reject(new ToolError("REQUEST_CANCELLED", "The request was cancelled."));
    const sequence = this.received;
    if (sequence <= this.parsed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        this.drainWaiters.delete(waiter);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new ToolError("REQUEST_CANCELLED", "The request was cancelled."));
      const waiter = { sequence, resolve: () => finish(), reject: finish };
      this.drainWaiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  capture(scrollbackLines = 0): ScreenState {
    this.assertOpen();
    return captureScreen(this.terminal, this.cursorVisible, this.mouseEncoding, scrollbackLines);
  }

  getInputModes(): InputModes {
    this.assertOpen();
    const modes = this.terminal.modes;
    return {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      applicationCursorKeys: modes.applicationCursorKeysMode,
      bracketedPaste: modes.bracketedPasteMode,
      focusReporting: modes.sendFocusMode,
      mouseTracking: modes.mouseTrackingMode,
      mouseEncoding: this.mouseEncoding,
    };
  }

  resize(cols: number, rows: number): void {
    this.assertOpen();
    this.terminal.resize(cols, rows);
    this.fingerprint = visibleFingerprint(this.capture());
  }

  onResponse(listener: (data: string) => void): () => void {
    this.assertOpen();
    this.responseListeners.add(listener);
    return () => { this.responseListeners.delete(listener); };
  }

  onPendingBytes(listener: (bytes: number) => void): () => void {
    this.assertOpen();
    this.pendingBytesListeners.add(listener);
    return () => { this.pendingBytesListeners.delete(listener); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of this.drainWaiters) {
      waiter.reject(new ToolError("SESSION_CLOSED", "The terminal is closed."));
    }
    this.drainWaiters.clear();
    for (const listener of this.listeners) listener.dispose();
    this.responseListeners.clear();
    this.pendingBytesListeners.clear();
    this.terminal.dispose();
  }

  private observeModes(params: (number | number[])[], enabled: boolean): false {
    for (const mode of params) {
      if (mode === 25) this.cursorVisible = enabled;
      if (mode === 1006) this.mouseEncoding = enabled ? "sgr" : "legacy";
      if (mode === 1016) this.mouseEncoding = enabled ? "sgr-pixels" : "legacy";
    }
    return false;
  }

  private notifyPendingBytes(): void {
    for (const listener of this.pendingBytesListeners) listener(this.pendingBytes);
  }

  private assertOpen(): void {
    if (this.disposed) throw new ToolError("SESSION_CLOSED", "The terminal is closed.");
  }
}
