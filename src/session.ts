import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pty, { type IPty } from "node-pty";
import {
  SnapshotSchema, StartSchema, ToolError, type ErrorCode, type ObservationOptions,
  type SessionInfo, type StartOptions, type TerminalSnapshot,
} from "./contracts.js";
import { TerminalModel } from "./terminal.js";

export class Session {
  private readonly sessionId = randomUUID();
  private readonly lifetime = new AbortController();
  private readonly subscriptions: Array<() => void>;
  private readonly exited: Promise<void>;
  private exit?: { exitCode: number; signal?: number };
  private closePromise?: Promise<void>;
  private disposed = false;
  private ioFailure?: string;

  private constructor(
    private readonly options: StartOptions,
    private readonly cwd: string,
    private readonly child: IPty,
    private readonly model: TerminalModel,
  ) {
    let paused = false;
    let resolveExit!: () => void;
    this.exited = new Promise((resolve) => { resolveExit = resolve; });
    const data = child.onData((bytes) => model.write(bytes));
    const exit = child.onExit(({ exitCode, signal }) => {
      this.exit = { exitCode, ...(signal ? { signal } : {}) };
      resolveExit();
    });
    this.subscriptions = [
      () => data.dispose(),
      () => exit.dispose(),
      model.onResponse((response) => {
        if (this.exit || this.lifetime.signal.aborted) return;
        try {
          child.write(response);
        } catch (error) {
          this.ioFailure = `Could not send a terminal response: ${String(error)}`;
        }
      }),
      model.onPendingBytes((bytes) => {
        try {
          if (!paused && bytes >= 1_048_576) {
            child.pause();
            paused = true;
          } else if (paused && bytes <= 262_144) {
            child.resume();
            paused = false;
          }
        } catch (error) {
          this.ioFailure = `Could not control terminal output: ${String(error)}`;
        }
      }),
    ];
  }

  static start(options: StartOptions): Session {
    const validated = StartSchema.safeParse(options);
    if (!validated.success) throw new ToolError("INVALID_INPUT", validated.error.message);
    options = validated.data;
    const strings = [options.command, options.shell, options.cwd, ...Object.values(options.env ?? {})];
    if (strings.some((value) => value?.includes("\0"))) {
      throw new ToolError("INVALID_INPUT", "Process configuration cannot contain NUL characters.");
    }
    if (Object.keys(options.env ?? {}).some((key) => !key || /[=\0]/.test(key))) {
      throw new ToolError("INVALID_INPUT", "Environment names must be nonempty and cannot contain '=' or NUL.");
    }
    const cwd = resolve(options.cwd ?? process.cwd());
    const env = { ...process.env };
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    env.TERM = "xterm-256color";
    const model = new TerminalModel(options.cols, options.rows);
    try {
      const args = options.login ? ["-l", "-c", options.command] : ["-c", options.command];
      const child = pty.spawn(options.shell ?? (process.env.SHELL || "/bin/sh"), args, {
        name: "xterm-256color", cols: options.cols, rows: options.rows, cwd, env, handleFlowControl: false,
      });
      return new Session(options, cwd, child, model);
    } catch (error) {
      model.dispose();
      throw new ToolError("SPAWN_FAILED", `Could not start the terminal process: ${String(error)}`);
    }
  }

  info(): SessionInfo {
    return {
      sessionId: this.sessionId, command: this.options.command, cwd: this.cwd,
      cols: this.child.cols, rows: this.child.rows, status: this.exit ? "exited" : "running", ...this.exit,
    };
  }

  async snapshot(
    options: ObservationOptions = {}, scrollbackLines = 0, signal?: AbortSignal,
  ): Promise<TerminalSnapshot> {
    if (this.lifetime.signal.aborted) throw this.error("SESSION_CLOSED", "The terminal session is closed.");
    const validated = SnapshotSchema.safeParse({ ...options, scrollbackLines, sessionId: this.sessionId });
    if (!validated.success) throw this.error("INVALID_INPUT", validated.error.message);
    const cancellation = AbortSignal.any(signal ? [signal, this.lifetime.signal] : [this.lifetime.signal]);
    try {
      const screen = await this.model.observe(options, scrollbackLines, cancellation);
      const snapshot: TerminalSnapshot = {
        ...screen, sessionId: this.sessionId, status: this.exit ? "exited" : "running", ...this.exit,
      };
      if (this.ioFailure) throw this.error("IO_ERROR", this.ioFailure);
      if (!screen.settled && options.settleTimeoutMs !== undefined) {
        throw new ToolError("SCREEN_NOT_SETTLED", "The screen did not settle before the deadline.", {
          sessionId: this.sessionId, latestSnapshot: snapshot,
        });
      }
      return snapshot;
    } catch (error) {
      if (cancellation.aborted) {
        if (cancellation.reason === this.lifetime.signal.reason) {
          throw this.error("SESSION_CLOSED", "The terminal session is closed.");
        }
        throw this.error("REQUEST_CANCELLED", "The request was cancelled.");
      }
      if (error instanceof ToolError) {
        if (error.details.sessionId) throw error;
        throw this.error(error.code, error.message);
      }
      throw this.error("IO_ERROR", `Could not observe the terminal: ${String(error)}`);
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.lifetime.abort(new ToolError("SESSION_CLOSED", "The terminal session is closed."));
      this.closePromise = this.cleanup();
    }
    return this.closePromise;
  }

  private async cleanup(): Promise<void> {
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), 1000);
    let failure: ToolError | undefined;
    try {
      // forkpty can return before the child has established its process group.
      let signaled = this.signalGroup("SIGHUP");
      while (!signaled && !this.exit) {
        await delay(10, undefined, { signal: budget.signal });
        signaled = this.signalGroup("SIGHUP");
      }
      if (signaled) {
        await delay(500, undefined, { signal: budget.signal });
        if (this.signalGroup(0)) this.signalGroup("SIGKILL");
      }
      await this.waitForExit(budget.signal);
    } catch (error) {
      failure = this.error("IO_ERROR", `Could not close the terminal process group: ${String(error)}`);
    } finally {
      try {
        await this.model.drain(budget.signal);
      } catch (error) {
        if (!budget.signal.aborted) {
          failure ??= this.error("IO_ERROR", `Could not drain terminal output: ${String(error)}`);
        }
      }
      clearTimeout(timer);
      for (const unsubscribe of this.subscriptions) unsubscribe();
      this.model.dispose();
      this.disposed = true;
    }
    if (failure) throw failure;
  }

  private signalGroup(signal: NodeJS.Signals | 0): boolean {
    try {
      process.kill(-this.child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  private waitForExit(signal: AbortSignal): Promise<void> {
    if (this.exit) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error("Timed out waiting for terminal process exit."));
      const finish = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        void this.exited.then(finish);
      }
    });
  }

  private error(code: ErrorCode, message: string): ToolError {
    const latestSnapshot: TerminalSnapshot | undefined = this.disposed ? undefined : {
      ...this.model.capture(), settled: false,
      sessionId: this.sessionId, status: this.exit ? "exited" : "running", ...this.exit,
    };
    return new ToolError(code, message, { sessionId: this.sessionId, latestSnapshot });
  }
}
