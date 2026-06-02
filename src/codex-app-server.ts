import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { CodexNotification, SandboxMode } from "./types";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface CodexTurnOptions {
  cwd: string;
  input: string;
  model?: string;
  sandbox: SandboxMode;
  onNotification?: (notification: CodexNotification) => void;
}

export class CodexAppServerClient {
  private nextId = 1;
  private proc?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private pending = new Map<number, PendingRequest>();
  private activeNotificationHandler?: (notification: CodexNotification) => void;
  private activeTurn?: {
    resolve: () => void;
    reject: (error: Error) => void;
  };

  constructor(private readonly codexBin: string) {}

  async start(): Promise<void> {
    if (this.proc) {
      return;
    }

    this.proc = spawn(this.codexBin, ["app-server"], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.lines = createInterface({ input: this.proc.stdout });
    this.lines.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "tetherbox",
        title: "Tetherbox",
        version: "0.1.0",
      },
    });
    this.notify("initialized", {});
  }

  async runTurn(options: CodexTurnOptions): Promise<void> {
    await this.start();
    this.activeNotificationHandler = options.onNotification;

    const thread = (await this.request("thread/start", {
      model: options.model,
      cwd: options.cwd,
      sandbox: options.sandbox,
    })) as { thread?: { id?: string } };

    const threadId = thread.thread?.id;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id");
    }

    const completed = new Promise<void>((resolve, reject) => {
      this.activeTurn = { resolve, reject };
    });

    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: options.input }],
      cwd: options.cwd,
      sandbox: options.sandbox,
      model: options.model,
    });

    await completed;
  }

  stop(): void {
    this.lines?.close();
    this.proc?.kill();
    this.lines = undefined;
    this.proc = undefined;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const body = { method, id, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(body);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  private write(body: unknown): void {
    if (!this.proc) {
      throw new Error("Codex app-server process is not running");
    }
    this.proc.stdin.write(`${JSON.stringify(body)}\n`);
  }

  private handleLine(line: string): void {
    const message = JSON.parse(line) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
    };

    if (message.method) {
      this.handleNotification({
        method: message.method,
        params: message.params,
      });
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex app-server request failed"));
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
}
