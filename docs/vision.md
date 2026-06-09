# Tetherbox Vision

## Working Vision

Tetherbox should become the open-source bridge for teams that want Linear to be the control surface for agentic coding while the actual coding agent runs on hardware they control.

The project exists for developers and teams who like the workflow shape of delegating work from Linear, but who need local execution: local repositories, local credentials, local tools, local skills, local MCP servers, local policies, and local operational accountability. Tetherbox should make that model practical enough that a maintainer can delegate a real issue, watch the work from Linear or a local operator surface, and receive a reviewable pull request without giving up control of the machine that does the work.

The long-term product should feel less like a hosted coding agent and more like dependable automation around a trusted local Codex worker.

## Why This Exists

Linear is already where many teams describe, prioritize, assign, and review product work. Codex is good at turning that context into edits, tests, explanations, and pull requests. The missing piece is a self-hostable connector that lets Linear start and steer Codex without moving repository execution to a cloud worker.

Tetherbox fills that gap by accepting Linear agent sessions, applying deterministic local policy, running Codex through `codex app-server` on a Linux or macOS host, and reporting progress back to Linear. It should make Linear feel like the front door for local coding automation while preserving the security and debuggability of a daemon that lives under the user's control.

The project should be useful for:

- Solo maintainers who want to delegate small open-source issues from Linear without keeping a desktop app open.
- Small teams that want a shared always-on host for codebase maintenance, bug fixes, and pull-request preparation.
- Infrastructure and homelab users who need strict control over exposed routes, secrets, local networks, and machine identity.
- Agent-tool builders who want a clear reference implementation for Linear Agent Sessions backed by local Codex execution.

## Product Promise

Tetherbox should reliably answer this request:

> "Take this Linear issue, run the right local Codex workflow for the right repository, follow our rules, and come back with a traceable result."

A traceable result can be a plan, a blocker, a validation failure, a canceled job, or a pull request. It should never be a silent process, a mysterious branch, or a half-hidden side effect.

The product should be judged by whether a maintainer can understand:

- What Linear asked Tetherbox to do.
- Which repository and worktree were selected.
- Which policy rule allowed, paused, narrowed, or denied the work.
- What Codex did locally.
- Which commands passed or failed.
- Which branch, commit, and pull request were created.
- What still needs a human decision.

## Design Principles

### Local First

The Codex run happens on the user's machine or server. Repository access, auth state, SSH keys, GitHub CLI state, local tools, and host-specific capabilities stay there. Tetherbox should not require a hosted execution service to provide its core value.

### Linear Is The Control Surface

Linear should be where work is delegated, clarified, approved, stopped, resumed, and linked back to review. Tetherbox should respect Linear's agent-session model and keep useful progress in Linear, but avoid dumping local logs or secret-bearing output into issue comments.

### Policy Before Automation

Tetherbox should decide what is allowed before Codex starts. Linear text is task input, not authority over local policy. Sensitive work should be plan-only, approval-gated, or denied according to deterministic rules that operators can inspect.

### Small Public Surface

The public network boundary is the Tetherbox daemon webhook route, not Codex App Server. A safe deployment should be able to expose only the exact Linear webhook endpoint publicly while keeping dashboards, status, OAuth, and operator actions private or explicitly protected.

### Reviewable Output

The preferred successful coding outcome is a branch, signed commit, validation record, and pull request that a human can review. Tetherbox should optimize for understandable diffs and narrow scope, not broad autonomous rewrites.

### Honest State

Jobs should have durable, inspectable state. Restarts, duplicate webhooks, missing auth, failed validation, canceled issues, and stale worktrees should produce clear states and recovery paths. The daemon should be boring to operate.

### Open-Source By Default

The project should be easy to inspect, run locally, package, fork, and deploy. Important behavior should live in code and docs, not in a private service. Defaults should make sense for public repositories and individual operators.

## Product Shape

Tetherbox has five main product surfaces.

### 1. Linear Agent App

The Linear app is the user-facing entry point. Users should be able to mention the agent, delegate an issue, add follow-up prompts, approve gated work, stop work, and see final results from Linear.

This surface should provide:

- Fast acknowledgement when Linear starts a session.
- Clear activity for queueing, policy decisions, work start, validation, PR creation, blockers, and completion.
- Continuation of the same local Codex thread for follow-up prompts.
- Links back to the local job view and GitHub pull request when available.
- Respect for Linear issue lifecycle signals, including unassignment and completed or canceled states.

### 2. Local Daemon

The daemon is the durable automation service. It receives webhooks, verifies signatures, persists state, routes work, enforces policy, starts Codex, runs validation, and coordinates GitHub and Linear updates.

The daemon should be able to run as:

- A user service on macOS.
- A user service on Linux.
- A container with mounted config, state, repositories, auth, and SSH material.
- A homelab service behind a narrow reverse proxy or tunnel.

The single-host model should remain excellent before the project expands to multi-host routing.

### 3. Operator Surfaces

Operators need local visibility and control without spelunking through SQLite or logs.

The browser dashboard and terminal UI should make it possible to:

- See daemon health and Linear installation status.
- Inspect queued, running, waiting, failed, completed, and canceled jobs.
- Read redacted job events.
- Cancel, retry, approve, or deny work.
- See selected repositories, worktree paths, branches, PR links, and validation results.

These surfaces are operational tools. They should be compact, direct, and careful with sensitive data.

### 4. Worktree And GitHub Automation

Each coding job should happen in an isolated Git worktree created from the configured base branch. Tetherbox should run repo-specific validation, create signed and co-authored commits, push a branch with a meaningful issue-derived name, and open or update a pull request.

This surface should avoid surprises:

- No agent-prefixed branch names.
- No commits when validation fails.
- No unsigned commits when signing is required by the repo.
- No unrelated dirty changes from the source checkout.
- No PR without a clear description of changes, validation, known gaps, and Linear context.

### 5. Configuration And Policy

Configuration is the contract between the operator and the daemon. It should stay explicit enough that a maintainer can audit what Tetherbox can touch.

The config should cover:

- Linear webhook and OAuth settings.
- Local state paths.
- Repository mappings.
- Test and validation commands.
- Signing and GitHub publishing behavior.
- Operator access controls.
- Policy rules for automatic, plan-only, approval-required, and denied work.

Policy should remain deterministic and easy to explain in Linear activity.

## Near-Term Direction

The current project should align around a strong single-host MVP before chasing fleet features. The most important near-term work is to make one daemon trustworthy from intake to pull request.

### Foundation

- Keep Linear webhook verification, deduplication, and fast acknowledgement solid.
- Keep SQLite state durable across daemon restarts.
- Keep Codex App Server bindings versioned and validated against the installed Codex CLI.
- Keep redaction and audit behavior conservative.
- Keep local operator surfaces useful for real debugging.

### Coding Workflow

- Make repository routing predictable, with explicit repo mentions and Linear repository suggestions feeding into stable config mappings.
- Preserve Linear context in Codex prompts without treating it as policy authority.
- Run Codex in isolated worktrees.
- Run configured validation before commits.
- Create signed, co-authored commits.
- Push meaningful branches and open useful PRs.
- Report PR links and review state back to Linear.

### Control And Safety

- Make plan-only mode a first-class outcome.
- Make approval-required work easy to approve or deny from Linear and local operator surfaces.
- Cancel local work when Linear says the issue is no longer delegated or active.
- Keep public ingress minimal and document safe deployment shapes.
- Treat missing GitHub auth, missing Codex auth, stale tokens, and broken repo mappings as recoverable operator problems.

### Release Readiness

- Land the single-host feature stack on `main`.
- Add repository CI so local validation is not the only release gate.
- Cut a signed `v0.1.0` release with installation docs, security docs, setup docs, and a tested container image.
- Use the first release to invite maintainers to try the exact workflow: delegate a small Linear issue and get a real PR.

## Later Direction

Multi-host support should come after the single-host path is proven. The likely expansion path is:

- Host registration and capability reporting.
- Repo availability checks per host.
- Queue assignment across hosts.
- Optional relay for teams that need public ingress separated from worker hosts.
- GitHub API integration beyond `gh` when daemon environments need fewer CLI assumptions.
- Additional forge support if real users need GitLab, Forgejo, or Gitea.
- Stronger secret storage using OS keychains or external secret stores.
- Better release packaging for macOS, Linux, and containers.
- A richer local web UI for job logs, policy inspection, and setup checks.

The project should resist becoming a generic hosted agent platform too early. Tetherbox's strongest identity is local execution with Linear coordination.

## Non-Goals

Tetherbox should not try to do these in the first public shape:

- Replace Codex cloud integrations for users who want hosted execution.
- Expose Codex App Server directly to the internet.
- Act as a general public SaaS for arbitrary users and repositories.
- Store production secrets in Linear comments, issue descriptions, or generated PR bodies.
- Hide local policy decisions behind model output.
- Turn every Linear issue into automatic code changes.
- Treat passing tests as enough when the job clearly needs human review.
- Manage every forge, chat system, CI provider, and ticket tracker from day one.

## Alignment Checklist

Use this checklist when planning new work. A feature aligns with the vision when most answers are yes.

- Does it make Linear a better control surface for local Codex work?
- Does it preserve local ownership of repos, credentials, tools, and execution?
- Does it make policy more deterministic or more visible?
- Does it improve traceability from Linear issue to job to branch to PR?
- Does it reduce operator confusion during failure, restart, auth, or validation problems?
- Does it keep the public surface small?
- Does it help the single-host open-source product before adding platform complexity?
- Does it produce reviewable output rather than hidden automation?

If a feature mainly makes Tetherbox broader, hosted, or more magical without improving control and traceability, it should wait.

## Success Metrics

The project is moving in the right direction when:

- A new maintainer can install Tetherbox on a Mac or Linux host from the docs and delegate a small issue within an hour.
- A delegated issue can produce a branch, signed commit, passing validation, and pull request through the real workflow.
- Failed jobs explain the next operator action clearly.
- Restarting the daemon does not lose active or retryable work.
- Linear shows enough progress that teammates know what happened without needing host access.
- Operators can verify the public exposure and confirm Codex App Server is not exposed.
- The repository has CI, signed releases, clear setup docs, and enough tests to make external contributions safe to review.

## Open Questions For Planning

- Should the first public release market Tetherbox mainly to solo maintainers, small teams, or homelab-style operators?
- How much of the local dashboard should be private-only by default versus protected and shareable?
- Should GitHub CLI remain the default PR implementation after `v0.1.0`, or should the project move quickly to GitHub API calls?
- What is the cleanest setup check that proves Codex auth, GitHub auth, repo mapping, signing, and Linear auth before a real issue is delegated?
- Which policy presets would help new users without hiding the underlying rule model?
- What is the minimum multi-host model that preserves the local-first identity?
