import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CodexAppServerClient, CodexAppServerError, type CodexAppServerLifecycleEvent } from "../src/codex-app-server";

describe("CodexAppServerClient", () => {
  test("runs a turn and streams notifications", async () => {
    const notifications: string[] = [];
    const client = new CodexAppServerClient(await fakeCodex("success"));

    const threadId = await client.runTurn({
      cwd: "/tmp",
      input: "hello",
      sandbox: "workspace-write",
      onNotification: (notification) => {
        if (notification.method) {
          notifications.push(notification.method);
        }
      },
    });
    client.stop();

    expect(threadId).toBe("thread-1");
    expect(notifications).toContain("turn/completed");
  });

  test("continues an existing thread without starting a new one", async () => {
    const client = new CodexAppServerClient(await fakeCodex("resume-thread"));

    const threadId = await client.runTurn({
      cwd: "/tmp",
      input: "follow up",
      threadId: "thread-42",
      sandbox: "workspace-write",
    });
    client.stop();

    expect(threadId).toBe("thread-42");
  });

  test("starts and runs turns with non-interactive approvals", async () => {
    const client = new CodexAppServerClient(await fakeCodex("require-never-policy"));

    const threadId = await client.runTurn({
      cwd: "/tmp",
      input: "hello",
      sandbox: "read-only",
    });
    client.stop();

    expect(threadId).toBe("thread-1");
  });

  test("fails fast when Codex requests unsupported interactive approval", async () => {
    const events: CodexAppServerLifecycleEvent[] = [];
    const client = new CodexAppServerClient(await fakeCodex("approval-request"), {
      turnTimeoutMs: 1_000,
      onLifecycleEvent: (event) => events.push(event),
    });

    await expect(
      client.runTurn({
        cwd: "/tmp",
        input: "hello",
        sandbox: "read-only",
      }),
    ).rejects.toMatchObject({
      reason: "request_error",
      message: "Codex app-server requested unsupported interaction: item/commandExecution/requestApproval",
    });
    client.stop();

    expect(events).toContainEqual(expect.objectContaining({
      level: "error",
      reason: "request_error",
      message: "Codex app-server requested unsupported interaction: item/commandExecution/requestApproval",
    }));
  });

  test("declines MCP elicitations without failing the turn", async () => {
    const events: CodexAppServerLifecycleEvent[] = [];
    const client = new CodexAppServerClient(await fakeCodex("elicitation-request"), {
      turnTimeoutMs: 1_000,
      onLifecycleEvent: (event) => events.push(event),
    });

    const threadId = await client.runTurn({
      cwd: "/tmp",
      input: "hello",
      sandbox: "read-only",
    });
    client.stop();

    expect(threadId).toBe("thread-1");
    expect(events).toContainEqual({
      level: "warn",
      reason: "request_error",
      message: "Declined Codex app-server MCP elicitation request in non-interactive mode",
    });
  });

  test("fails startup with a structured timeout reason", async () => {
    const client = new CodexAppServerClient(await fakeCodex("startup-timeout"), { startupTimeoutMs: 5 });

    await expect(client.start()).rejects.toMatchObject({ reason: "startup_timeout" });
    client.stop();
  });

  test("fails turns with a structured timeout reason", async () => {
    const client = new CodexAppServerClient(await fakeCodex("turn-timeout"), { turnTimeoutMs: 5 });

    await expect(
      client.runTurn({
        cwd: "/tmp",
        input: "hello",
        sandbox: "workspace-write",
      }),
    ).rejects.toMatchObject({ reason: "turn_timeout" });
    client.stop();
  });

  test("maps stderr to lifecycle events without failing the turn", async () => {
    const events: CodexAppServerLifecycleEvent[] = [];
    const client = new CodexAppServerClient(await fakeCodex("stderr"), {
      onLifecycleEvent: (event) => events.push(event),
    });

    await client.runTurn({ cwd: "/tmp", input: "hello", sandbox: "workspace-write" });
    client.stop();

    expect(events).toContainEqual({
      level: "warn",
      reason: "stderr",
      message: "Codex app-server stderr: noisy warning",
    });
  });

  test("fails malformed JSON with a structured reason", async () => {
    const client = new CodexAppServerClient(await fakeCodex("malformed-json"));

    await expect(client.start()).rejects.toMatchObject({ reason: "malformed_json" });
    client.stop();
  });

  test("fails request errors with a structured reason", async () => {
    const client = new CodexAppServerClient(await fakeCodex("request-error"));

    await expect(
      client.runTurn({
        cwd: "/tmp",
        input: "hello",
        sandbox: "workspace-write",
      }),
    ).rejects.toMatchObject({ reason: "request_error" });
    client.stop();
  });

  test("fails unexpected process exit with a structured reason", async () => {
    const client = new CodexAppServerClient(await fakeCodex("process-exit"));

    try {
      await client.runTurn({
        cwd: "/tmp",
        input: "hello",
        sandbox: "workspace-write",
      });
      throw new Error("Expected process exit failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexAppServerError);
      expect((error as CodexAppServerError).reason).toBe("process_exit");
    } finally {
      client.stop();
    }
  });
});

async function fakeCodex(scenario: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fake-app-server-"));
  const bin = join(dir, "codex");
  await writeFile(
    bin,
    `#!/usr/bin/env bun
import { createInterface } from "node:readline";

const scenario = ${JSON.stringify(scenario)};
const lines = createInterface({ input: process.stdin });

if (scenario === "stderr") {
  console.error("noisy warning");
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (scenario === "startup-timeout") {
    return;
  }
  if (scenario === "malformed-json") {
    console.log("{not-json");
    return;
  }

  if (message.method === "initialize") {
    respond(message.id, {});
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "thread/start") {
    if (scenario === "resume-thread") {
      process.exit(8);
    }
    if (scenario === "request-error") {
      console.log(JSON.stringify({ id: message.id, error: { message: "thread failed" } }));
      return;
    }
    if (scenario === "require-never-policy" && message.params.approvalPolicy !== "never") {
      console.log(JSON.stringify({ id: message.id, error: { message: "expected never thread approval policy" } }));
      return;
    }
    respond(message.id, { thread: { id: "thread-1" } });
    return;
  }
  if (message.method === "turn/start") {
    if (scenario === "require-never-policy" && message.params.approvalPolicy !== "never") {
      console.log(JSON.stringify({ id: message.id, error: { message: "expected never turn approval policy" } }));
      return;
    }
    respond(message.id, {});
    if (scenario === "process-exit") {
      process.exit(2);
    }
    if (scenario === "approval-request") {
      console.log(JSON.stringify({
        id: 900,
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "item-1",
          approvalId: "approval-1",
          command: ["rg", "TODO"],
          cwd: "/tmp",
          reason: "search repo",
          parsedCmd: [],
        },
      }));
      return;
    }
    if (scenario === "elicitation-request") {
      console.log(JSON.stringify({
        id: 901,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "linear",
          mode: "form",
          message: "Need input",
          requestedSchema: { type: "object", properties: {} },
          _meta: null,
        },
      }));
      return;
    }
    if (scenario !== "turn-timeout") {
      console.log(JSON.stringify({ method: "turn/completed", params: {} }));
    }
    return;
  }
  if (scenario === "elicitation-request" && message.id === 901) {
    if (
      message.result?.action !== "decline" ||
      message.result?.content !== null ||
      message.result?._meta !== null
    ) {
      console.log(JSON.stringify({ id: 902, error: { message: "expected declined elicitation result" } }));
      return;
    }
    console.log(JSON.stringify({ method: "turn/completed", params: {} }));
  }
});

function respond(id, result) {
  console.log(JSON.stringify({ id, result }));
}
`,
  );
  await chmod(bin, 0o755);
  return bin;
}
