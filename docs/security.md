# Tetherbox Security

Tetherbox is a local bridge between Linear Agent Sessions and Codex running on a developer-controlled host. Treat it as an automation service with access to local repositories, Codex auth, GitHub auth, and any files visible to the service user.

## Trust Boundaries

Trusted:

- The local host and service user.
- The configured repository checkouts.
- The configured Tetherbox SQLite state path.
- Codex CLI auth for the service user.
- GitHub CLI auth for the service user.

Untrusted:

- Linear issue text, comments, guidance, and prompt context.
- Webhook requests without a valid Linear signature.
- Any generated code or shell command suggested by model output.

Linear text is task input, not policy authority. Tetherbox adds that reminder to Codex prompts and evaluates local policy before starting Codex.

## Why Codex App Server Stays Local

`codex app-server` is a local stdio JSON-RPC process. Tetherbox starts it as a child process and talks to it over pipes.

Do not expose Codex App Server on the public internet or behind a tunnel. It is not the public ingress point. The public ingress point is Tetherbox's HTTP server, which verifies Linear webhook signatures, applies routing and policy, persists state, and controls when Codex starts.

## Secrets

Tetherbox uses these secrets:

- Linear webhook signing secret.
- Linear OAuth client secret.
- Linear app actor access and refresh tokens.
- Codex CLI auth stored by the Codex CLI.
- GitHub CLI auth or SSH keys used by Git and `gh`.

Store config files and SQLite state with permissions appropriate for the service user. The SQLite database can contain Linear tokens, issue metadata, prompts, job events, branch names, pull request URLs, and Codex thread IDs.

Do not commit local config files with real secrets. Keep `examples/config.json` as shape-only documentation.

## Redaction And Audit Limits

Tetherbox redacts likely secrets before posting Linear activity/session updates, writing daemon audit events, or returning status snapshots used by the TUI.

The redactor targets common secret shapes: sensitive key names such as `access_token`, `refresh_token`, `api_key`, `client_secret`, `password`, and `private_key`; bearer tokens; common service token prefixes; and URL credentials.

This is a safety net, not a guarantee. User-provided text, tool output, file contents, model output, and unusual token formats may still contain sensitive data. Treat `/api/status`, logs, and SQLite state as sensitive operational data.

Local audit events persist a source, timestamp, job ID, severity, and redacted message. The source is a coarse subsystem label such as `queue`, `job`, `worktree`, `codex`, `linear`, or `daemon`.

## Approval Boundaries

Policy decisions define how much automation is allowed:

- `allow_auto`: run Codex and continue to validation/PR automation.
- `allow_plan_only`: run Codex in read-only mode and do not create a worktree, commit, push, or pull request.
- `require_approval`: post a Linear approval prompt and wait.
- `deny`: refuse the job before Codex starts.

Approval-required jobs persist a pending approval in SQLite. Replies such as `approve` continue the job; `deny`, `cancel`, or a Linear stop signal cancel it. Pending approvals expire after `queue.approvalTimeoutMs`.

Approving a job changes the local policy decision for that resumed job to an approved auto run. Use `require_approval` for work that can be allowed after explicit human confirmation, and `deny` for work that should never run through this daemon.
GitHub authentication failures during pull request publishing also pause the job and emit a Linear `auth` elicitation. Configure `git.githubAuthUrl` only to a trusted GitHub or internal setup page, because users may click it from Linear before retrying the job.

## Webhook Handling

Tetherbox verifies `Linear-Signature` before parsing webhook JSON, then rejects missing, malformed, or stale `webhookTimestamp` values before handling the event. Accepted Linear deliveries are recorded in SQLite by payload `webhookId`, falling back to the `Linear-Delivery` header, so Linear retries are acknowledged without repeating side effects. Malformed JSON and unsupported Agent Session actions are recorded as local audit events and do not enqueue work.

The daemon returns a fast acknowledgement for valid webhooks, then processes the job asynchronously. This keeps Linear webhook delivery responsive while local Codex work runs separately.
Inbox Notification webhooks are accepted without queueing Codex work and are written to the local audit trail. If Linear reports `issueUnassignedFromYou`, or an `issueStatusChanged` notification with a completed or canceled status type, Tetherbox cancels active local jobs matching that Linear issue because the app should stop local work that is no longer active in Linear.
Permission-change webhooks are accepted without queueing Codex work and are written to the local audit trail. OAuth app revocation webhooks remove the stored Linear installation token and record a warning, so the daemon stops using stale app credentials until the app is installed again.

## Network Exposure

Expose only the daemon HTTP routes needed by Linear:

- `/webhooks/linear`
- `/oauth/linear/start`
- `/oauth/linear/callback`
- `/healthz`
- `/api/status`
- `/api/jobs/:id/cancel`

If `/api/status` is reachable outside your private network, assume job metadata is visible to anyone with access to that URL. Prefer a private tunnel or reverse proxy access controls for status and TUI use.

## Operational Checks

Before delegating real issues:

1. Confirm `server.publicUrl` points at the Tetherbox daemon, not Codex App Server.
2. Confirm Linear webhook signature verification is enabled with the expected secret.
3. Confirm `codex.minSupportedVersion` is set or generated protocol metadata is current.
4. Confirm each repo mapping points at the intended local checkout.
5. Confirm policies default to approval or deny for sensitive work.
6. Run `bun run check`.
