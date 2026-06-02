# Single-Host MVP Release Readiness

Target release: `v0.1.0`

Linear issue: [OSS-243](https://linear.app/seventwo/issue/OSS-243/cut-first-single-host-mvp-release)

## Current Status

The implementation stack is ready for review but not yet releasable from `main`. GitHub currently has no Tetherbox tags or releases.

Open prerequisite stack:

- PR #3: SQLite daemon persistence.
- PR #4: daemon job queue.
- PR #5: Codex App Server protocol generation.
- PR #6: Codex App Server client hardening.
- PR #7: Linear Agent Activity API.
- PR #8: Linear repository suggestions.
- PR #9: Codex thread resume for Linear sessions.
- PR #10: Linear OAuth app actor installation.
- PR #11: fast webhook acknowledgement.
- PR #12: validation, commit, push, and PR automation.
- PR #13: gated job resume from Linear replies.
- PR #14: rich Linear issue context in Codex prompts.
- PR #15: Linear event validation.
- PR #16: Linear stop signal handling.
- PR #17: ambiguous repo selection via Linear.
- PR #18: GitHub PR check reporting.
- PR #19: plan-only policy enforcement.
- PR #20: policy config v1.
- PR #21: approval expiration.
- PR #22: setup and security docs.
- PR #23: local integration harness.

The stack was checked as clean through PR #23. GitHub currently reports no checks for these branches, so local validation is the authoritative gate until repository CI exists.

## Acceptance Evidence

| Requirement | Evidence | Status |
| --- | --- | --- |
| Linear delegation can run local Codex on one host | `test/integration-harness.test.ts` signs a fake Linear webhook, runs the real request handler and queue, starts a fake `codex app-server`, prepares a real Git worktree, and completes a job. | Ready in stack |
| Daemon state persists across restart | `test/state-store.test.ts` covers SQLite job/event durability, Codex thread IDs, approvals, repo selections, pull requests, and TUI-compatible snapshots. | Ready in stack |
| Progress streams back to Linear | `src/linear.ts`, `src/job-runner.ts`, and server tests cover Agent Activity creation and Agent Session plan updates, with fallback logging when no Linear token is configured. | Ready in stack |
| Repo routing works for configured repos | `test/policy.test.ts` and `test/server.test.ts` cover explicit repo mentions, Linear repository suggestions, static team routing, ambiguous repo selection, and selected repo resume. | Ready in stack |
| Policy config v1 is available | PR #20 adds deterministic first-match policy rules for labels, paths, repos, teams, and priorities. | Ready in stack |
| GitHub PR creation works when configured | `test/pr-automation.test.ts` covers validation commands, signed/co-authored commits, push, PR creation, and PR check watching. | Ready in stack |
| Install and security docs are published | PR #22 adds `docs/setup.md` and `docs/security.md`, linked from `README.md`. | Ready in stack |
| A GitHub release is tagged and linked from Linear | No tag or GitHub release exists yet. This must happen after the prerequisite stack lands on `main`. | Pending |

## Final Release Steps

Run these only after PR #3 through PR #23 have landed on `main` and `main` passes validation.

```bash
git switch main
git pull --ff-only
bun run check
git tag -s v0.1.0 -m "Tetherbox v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --repo lucasilverentand/tetherbox --title "Tetherbox v0.1.0" --notes-file docs/release-readiness.md
```

After the release is created, attach the GitHub release URL to `OSS-243` and move the issue to Done.
