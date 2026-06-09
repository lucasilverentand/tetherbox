import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { ServerNotification } from "../generated/codex-app-server/types/ServerNotification";
import type { CodexNotification, SandboxMode } from "./types";

export type CodexAppServerFailureReason =
  | "startup_timeout"
  | "turn_timeout"
  | "process_exit"
  | "stderr"
  | "malformed_json"
  | "request_error"
  | "spawn_error"
  | "missing_thread_id";

export interface CodexAppServerLifecycleEvent {
  level: "info" | "warn" | "error";
  reason: CodexAppServerFailureReason;
  message: string;
}

export interface CodexAppServerClientOptions {
  startupTimeoutMs?: number;
  turnTimeoutMs?: number;
  onLifecycleEvent?: (event: CodexAppServerLifecycleEvent) => void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface CodexTurnOptions {
  cwd: string;
  input: string;
  threadId?: string;
  model?: string;
  sandbox: SandboxMode;
  onNotification?: (notification: CodexNotification) => void;
}

export class CodexAppServerError extends Error {
  constructor(
    public readonly reason: CodexAppServerFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "CodexAppServerError";
  }
}

export class CodexAppServerClient {
  private nextId = 1;
  private proc?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private pending = new Map<number, PendingRequest>();
  private stopped = false;
  private activeNotificationHandler?: (notification: CodexNotification) => void;
  private activeTurn?: {
    resolve: () => void;
    reject: (error: Error) => void;
  };

  constructor(
    private readonly codexBin: string,
    private readonly options: CodexAppServerClientOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.proc) {
      return;
    }

    this.stopped = false;
    this.proc = spawn(this.codexBin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.on("error", (error) => {
      this.failAll(new CodexAppServerError("spawn_error", `Codex app-server failed to start: ${error.message}`));
    });
    this.proc.on("close", (code, signal) => {
      if (this.stopped) {
        return;
      }
      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      this.failAll(new CodexAppServerError("process_exit", `Codex app-server exited unexpectedly with ${suffix}`));
    });
    this.proc.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        this.emitLifecycle("warn", "stderr", `Codex app-server stderr: ${message}`);
      }
    });

    this.lines = createInterface({ input: this.proc.stdout });
    this.lines.on("line", (line) => this.handleLine(line));

    try {
      await withTimeout(
        this.request("initialize", {
          clientInfo: {
            name: "tetherbox",
            title: "Tetherbox",
            version: "0.1.0",
          },
        }),
        this.options.startupTimeoutMs ?? 30_000,
        () => new CodexAppServerError("startup_timeout", "Timed out while starting Codex app-server"),
      );
    } catch (error) {
      if (error instanceof CodexAppServerError) {
        this.emitLifecycle("error", error.reason, error.message);
      }
      throw error;
    }
    this.notify("initialized", {});
  }

  async runTurn(options: CodexTurnOptions): Promise<string> {
    await this.start();
    this.activeNotificationHandler = options.onNotification;

    const thread =
      options.threadId ??
      ((await this.request("thread/start", {
        model: options.model,
        cwd: options.cwd,
        approvalPolicy: "never",
        sandbox: options.sandbox,
      })) as { thread?: { id?: string } }).thread?.id;

    if (!thread) {
      throw new CodexAppServerError("missing_thread_id", "Codex app-server did not return a thread id");
    }

    const completed = new Promise<void>((resolve, reject) => {
      this.activeTurn = { resolve, reject };
    });

    try {
      await this.request("turn/start", {
        threadId: thread,
        input: [{ type: "text", text: options.input }],
        cwd: options.cwd,
        approvalPolicy: "never",
        sandbox: options.sandbox,
        model: options.model,
      });
    } catch (error) {
      this.activeTurn = undefined;
      this.activeNotificationHandler = undefined;
      throw error;
    }

    try {
      await withTimeout(
        completed,
        this.options.turnTimeoutMs ?? 30 * 60_000,
        () => new CodexAppServerError("turn_timeout", "Timed out waiting for Codex turn completion"),
      );
    } catch (error) {
      if (error instanceof CodexAppServerError) {
        this.emitLifecycle("error", error.reason, error.message);
      }
      throw error;
    }
    return thread;
  }

  stop(): void {
    this.stopped = true;
    this.lines?.close();
    this.rejectPending(new CodexAppServerError("process_exit", "Codex app-server stopped"));
    this.activeTurn?.reject(new CodexAppServerError("process_exit", "Codex app-server stopped"));
    this.activeTurn = undefined;
    this.activeNotificationHandler = undefined;
    this.proc?.kill();
    this.lines = undefined;
    this.proc = undefined;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const body = { method, id, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try {
        this.write(body);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  private write(body: unknown): void {
    if (!this.proc) {
      throw new CodexAppServerError("process_exit", "Codex app-server process is not running");
    }
    this.proc.stdin.write(`${JSON.stringify(body)}\n`);
  }

  private handleLine(line: string): void {
    let message: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
    };

    try {
      message = JSON.parse(line);
    } catch {
      this.failAll(new CodexAppServerError("malformed_json", `Codex app-server emitted malformed JSON: ${line}`));
      return;
    }

    if (message.method && typeof message.id === "number") {
      this.handleServerRequest(message.id, message.method);
      return;
    }

    if (message.method) {
      this.handleNotification({
        method: message.method,
        params: message.params,
      } as ServerNotification);
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        const detail = message.error.message ?? `${pending.method} failed`;
        const error = new CodexAppServerError("request_error", `Codex app-server request failed: ${detail}`);
        this.emitLifecycle("error", error.reason, error.message);
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private handleNotification(notification: CodexNotification): void {
    this.activeNotificationHandler?.(notification);

    if (notification.method === "turn/completed") {
      this.activeTurn?.resolve();
      this.activeTurn = undefined;
      this.activeNotificationHandler = undefined;
    }
  }

  private handleServerRequest(id: number, method: string): void {
    if (method === "mcpServer/elicitation/request") {
      this.write({
        id,
        result: {
          action: "cancel",
          content: null,
          _meta: null,
        },
      });
      return;
    }

    const error = new CodexAppServerError(
      "request_error",
      `Codex app-server requested unsupported interaction: ${method}`,
    );
    this.emitLifecycle("error", error.reason, error.message);
    this.write({
      id,
      error: {
        message: "Tetherbox runs Codex non-interactively and cannot satisfy approval requests.",
      },
    });
    this.activeTurn?.reject(error);
    this.activeTurn = undefined;
    this.activeNotificationHandler = undefined;
  }

  private failAll(error: CodexAppServerError): void {
    this.emitLifecycle("error", error.reason, error.message);
    this.rejectPending(error);
    this.activeTurn?.reject(error);
    this.activeTurn = undefined;
    this.activeNotificationHandler = undefined;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private emitLifecycle(
    level: CodexAppServerLifecycleEvent["level"],
    reason: CodexAppServerFailureReason,
    message: string,
  ): void {
    this.options.onLifecycleEvent?.({ level, reason, message });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorFactory: () => Error): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(errorFactory()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
