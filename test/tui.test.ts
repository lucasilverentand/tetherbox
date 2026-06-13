import { describe, expect, test } from "bun:test";
import { renderTui, type TuiUiState } from "../src/tui";
import type { DaemonState } from "../src/types";

describe("TUI rendering", () => {
  test("renders daemon health, queue state, jobs, and available actions", () => {
    const output = renderTui(stateFixture(), { view: "jobs", selectedJob: 0, selectedEvent: 0 }, options);

    expect(output).toContain("Daemon:");
    expect(output).toContain("Linear: installed | app app-user-1");
    expect(output).toContain("Queue: accepting | running 1/2 | queued 1");
    expect(output).toContain("OSS-241");
    expect(output).toContain("c cancel");
    expect(output).toContain("a approve");
    expect(output).toContain("d deny");
  });

  test("renders job detail and related events", () => {
    const ui: TuiUiState = { view: "job", selectedJob: 1, selectedEvent: 0 };
    const output = renderTui(stateFixture(), ui, options);

    expect(output).toContain("Job Detail");
    expect(output).toContain("ID: job-failed");
    expect(output).toContain("Retry: eligible");
    expect(output).toContain("r retry");
    expect(output).toContain("Validation failed");
  });

  test("renders event detail", () => {
    const output = renderTui(stateFixture(), { view: "event", selectedJob: 0, selectedEvent: 1 }, options);

    expect(output).toContain("Event Detail");
    expect(output).toContain("Source: validation");
    expect(output).toContain("Validation failed");
  });
});

const options = {
  url: "http://127.0.0.1:8787",
  intervalMs: 2000,
};

function stateFixture(): DaemonState {
  return {
    startedAt: "2026-06-02T17:00:00.000Z",
    queue: {
      accepting: true,
      concurrency: 2,
      running: 1,
      queued: 1,
    },
    linear: {
      installed: true,
      workspaceId: "default",
      appUserId: "app-user-1",
      scope: "read write app:assignable app:mentionable",
      expiresAt: "2026-06-03T17:00:00.000Z",
    },
    jobs: [
      {
        id: "job-waiting",
        sessionId: "sess-1",
        status: "waiting_approval",
        repo: "lucasilverentand/tetherbox",
        issueIdentifier: "OSS-241",
        issueTitle: "Expand TUI into operational console",
        policyRule: "approval-required",
        policyDecision: "require_approval",
        createdAt: "2026-06-02T17:01:00.000Z",
        updatedAt: "2026-06-02T17:02:00.000Z",
        lastMessage: "Approval required",
        retryEligible: false,
        retryCount: 0,
      },
      {
        id: "job-failed",
        sessionId: "sess-2",
        status: "failed",
        repo: "lucasilverentand/tetherbox",
        issueIdentifier: "OSS-240",
        issueTitle: "Package daemon",
        policyRule: "docs-auto",
        policyDecision: "allow_auto",
        createdAt: "2026-06-02T17:03:00.000Z",
        updatedAt: "2026-06-02T17:04:00.000Z",
        lastMessage: "Validation failed",
        retryEligible: true,
        retryCount: 1,
        failureReason: "Validation failed",
      },
    ],
    events: [
      {
        id: "event-1",
        jobId: "job-waiting",
        source: "approval",
        level: "info",
        message: "Approval required",
        createdAt: "2026-06-02T17:02:00.000Z",
      },
      {
        id: "event-2",
        jobId: "job-failed",
        source: "validation",
        level: "error",
        message: "Validation failed",
        createdAt: "2026-06-02T17:04:00.000Z",
      },
    ],
  };
}
