# Tetherbox Setup

This guide covers a single Tetherbox daemon running on one macOS or Linux host with local repository checkouts, Codex auth, GitHub auth, and a public HTTPS tunnel for Linear webhooks.

## Prerequisites

- Bun 1.3 or newer.
- Codex CLI installed and authenticated for the same user that runs Tetherbox.
- Git installed.
- GitHub CLI installed and authenticated if Tetherbox should create pull requests.
- Local checkouts for every repository listed in `repos`.
- A public HTTPS URL that forwards to the daemon.

## Single-Host Quickstart

Copy the example config:

```bash
cp examples/config.json config.local.json
```

Edit `config.local.json`:

- Set `server.publicUrl` to the public tunnel URL.
- Set `state.path` to a durable local path.
- Set `linear.webhookSecretEnv`, `linear.apiKeyEnv`, `linear.oauthClientIdEnv`, and `linear.oauthClientSecretEnv`.
- Add one `repos` entry for each local checkout.
- Add policy rules under `policies`.

Export the configured secrets:

```bash
export LINEAR_WEBHOOK_SECRET=...
export LINEAR_API_KEY=...
export LINEAR_CLIENT_ID=...
export LINEAR_CLIENT_SECRET=...
```

Start the daemon:

```bash
bun run src/index.ts daemon --config config.local.json
```

Open the TUI from another shell:

```bash
bun run src/index.ts tui --url http://127.0.0.1:8787
```

## Linear App Setup

Create a Linear OAuth application for Tetherbox.

Use these settings:

- Redirect URL: `${server.publicUrl}/oauth/linear/callback`
- Webhook URL: `${server.publicUrl}/webhooks/linear`
- Webhook categories: Agent session events, Inbox Notifications, Permission changes, OAuth app
- OAuth scopes: `read`, `write`, `app:assignable`, `app:mentionable`

Install the app actor by opening:

```text
https://your-public-host.example.com/oauth/linear/start
```

Tetherbox redirects to Linear with `actor=app`, validates callback state, exchanges the OAuth code, and stores the app actor token in SQLite.
That stored app user ID is also used to set the issue delegate when a session starts. If the delegated issue is still in backlog or another non-started state, Tetherbox moves it to the team's first started workflow state before queueing local Codex work.
When API access is available, Tetherbox reads Agent Session activities and includes their frozen prompt/action/response history in the local Codex prompt so follow-up work is not dependent on editable comments alone.
After successful implementation, created or updated GitHub pull requests are added to the Linear Agent Session `externalUrls`. When `server.publicUrl` is configured, the session also keeps a link back to the local Tetherbox job status.

## Webhook Configuration

Set Linear's webhook signing secret in the env var named by `linear.webhookSecretEnv`.

Tetherbox verifies `Linear-Signature` with HMAC-SHA256 over the raw request body. Invalid signatures are rejected before parsing JSON.
Agent Session webhooks can queue or steer local Codex jobs. Inbox Notification webhooks record local audit events for direct app-user involvement, and `issueUnassignedFromYou` cancels matching active local jobs. Permission-change webhooks only record local audit events, and OAuth app revocation webhooks remove the stored app actor token so the daemon will require reinstall before it can post Linear activity or update delegated issues again.

## Tunnel Options

Linear must reach `/webhooks/linear` over HTTPS. Common options are:

- Cloudflare Tunnel.
- Tailscale Funnel.
- ngrok.
- A reverse proxy on a public host that forwards only the Tetherbox HTTP routes.

Only expose the Tetherbox daemon HTTP server. Do not expose `codex app-server`.

## Codex And GitHub Auth

Run Tetherbox as the same user that owns:

- Codex CLI auth.
- Git remotes and SSH keys.
- GitHub CLI auth.
- Local repository checkouts.

Check Codex before enabling webhooks:

```bash
codex --version
codex app-server generate-json-schema --help
```

Check GitHub CLI auth before enabling PR creation:

```bash
gh auth status
```

## Repository Mappings

Each `repos` entry maps Linear work to a local checkout:

```json
{
  "linearTeams": ["ENG"],
  "github": "lucasilverentand/example",
  "localPath": "/Users/luca/Developer/example",
  "defaultBase": "main",
  "testCommands": ["bun test"]
}
```

Routing order:

1. Explicit GitHub repo mentions in the Linear prompt.
2. Linear repository suggestions when `linear.apiKeyEnv` is configured.
3. Static `linearTeams` mapping.
4. The only configured repo, when there is exactly one.

If routing is ambiguous, Tetherbox asks Linear for a repository selection instead of guessing.

## Policy Config

Policies live under `policies` in config order. The first matching rule wins. Every matcher present on a rule must match.

Supported matchers:

- `labels`
- `paths`
- `repos`
- `teams`
- `priorities`

Supported decisions:

- `allow_auto`
- `allow_plan_only`
- `require_approval`
- `deny`

`allow_plan_only` runs Codex in read-only mode and does not open a pull request. `require_approval` creates a pending approval and waits for a Linear reply. Pending approvals expire after `queue.approvalTimeoutMs`.

## Validation Commands

Each repo mapping can define `testCommands`. Tetherbox runs those commands in the isolated job worktree after Codex returns and before committing:

```json
{
  "testCommands": ["bun test", "bun run lint"]
}
```

Passing and failing command summaries are stored as `validation` job events. A failed validation command fails the job and posts a Linear error activity with the failed command and summarized output.

## Git Commit Signing

Tetherbox creates commits from the isolated job worktree after configured validation commands pass. Set `git.signingKeyPath` to an SSH signing key if the daemon should force a specific key:

```json
{
  "git": {
    "signingKeyPath": "~/.ssh/codex_signing_key"
  }
}
```

When the key exists, Tetherbox runs `git -c gpg.format=ssh -c user.signingKey=<path> commit -S ...` and includes `Co-authored-by: Codex <codex@openai.com>`. If the configured key is missing or signing fails, Tetherbox records a warning and creates an unsigned co-authored commit so the job can still open a pull request.

## Service Install

Tetherbox installs as a user service. Install and run it as the same user that owns Codex auth, GitHub auth, SSH keys, and local repository checkouts.

Default local paths:

- Config: `~/.config/tetherbox/config.json`
- Optional env file: `~/.config/tetherbox/tetherbox.env`
- SQLite state: set `state.path` to a durable user-owned path such as `~/.local/state/tetherbox/daemon.sqlite`
- Job worktrees: stored under the configured state directory, in `worktrees/`

Install docs:

- macOS `launchd`: [docs/install-macos.md](install-macos.md)
- Linux `systemd --user`: [docs/install-linux.md](install-linux.md)

Template service definitions live in `examples/`, while the install scripts generate host-specific files from the current repo path and config path.

## Operator TUI

Open the terminal UI against the daemon:

```bash
bun run src/index.ts tui --url http://127.0.0.1:8787
```

The TUI has job, job detail, event, and event detail views. It shows daemon health and queue state from `/api/status`. Use `tab` to switch jobs/events, `enter` for detail, `esc` to go back, `j`/`k` to move, `c` to cancel active work, `r` to retry eligible failures, `a` to approve waiting jobs, `d` to deny waiting jobs, and `q` to quit.

Job action endpoints are accepted on loopback URLs. If the operator TUI needs to control a non-loopback daemon URL, set `server.operatorTokenEnv` in config, export that token in the daemon environment, and pass it to the TUI:

```bash
export TETHERBOX_OPERATOR_TOKEN=...
bun run src/index.ts tui --url https://your-public-host.example.com --operator-token "$TETHERBOX_OPERATOR_TOKEN"
```

## Local Integration Harness

Run the local integration harness with:

```bash
bun test test/integration-harness.test.ts
```

The harness does not call real Linear, real Codex, or GitHub. It signs fake Linear webhook payloads, runs the real Tetherbox request handler and job queue, creates temporary Git repositories, and starts a fake `codex app-server` executable over stdio.

Covered paths:

- Webhook intake to queued local job.
- Successful App Server turn completion.
- App Server request failure.
- Approval-required jobs waiting before Codex starts.
- PR-disabled completion when Codex leaves the worktree unchanged.
