# Tetherbox

Open-source bridge for delegating Linear agent sessions to Codex running locally on a Linux or macOS host.

The bridge receives Linear agent webhooks, applies local policy, starts `codex app-server`, streams progress back to Linear, and prepares the path for branches, validation, commits, and pull requests.

## Status

Early scaffold. The current app includes:

- Linear webhook HTTP endpoint.
- Linear webhook signature verification.
- Basic agent-session event parsing.
- Repository routing from local config.
- Deterministic policy decisions.
- Daemon state persisted to local SQLite.
- `/healthz` and `/api/status` daemon endpoints.
- Terminal UI for watching jobs and events.
- Per-job Git worktrees under the configured daemon state directory.
- Generated Codex App Server protocol bindings.
- Codex App Server JSON-RPC client over `stdio`.
- Local job runner that starts a Codex thread and turn.

## Requirements

- macOS or Linux.
- Bun 1.3+.
- Codex CLI installed and authenticated.
- Git installed.
- GitHub CLI installed and authenticated when PR creation is enabled.

## Quick Start

Copy the example config:

```bash
cp examples/config.json config.local.json
```

Edit `config.local.json`, then run:

```bash
bun run src/index.ts daemon --config config.local.json
```

The daemon listens on the configured host and port. Use a tunnel such as Cloudflare Tunnel, Tailscale Funnel, or ngrok during development so Linear can reach `/webhooks/linear`.
Set `server.publicUrl` to the externally reachable tunnel URL when you want Linear Agent Sessions to link back to Tetherbox status.

Open the terminal UI in another shell:

```bash
bun run src/index.ts tui --url http://127.0.0.1:8787
```

Press `q` to quit.

`serve` remains as an alias for `daemon`.

## Codex Protocol Bindings

Regenerate the checked-in Codex App Server TypeScript bindings and JSON schemas with:

```bash
bun run generate:codex-protocol
```

The command writes output under `generated/codex-app-server/` and records the Codex CLI version in `metadata.json` and `metadata.ts`. Daemon startup checks the installed Codex CLI against `codex.minSupportedVersion` when configured, otherwise against the generated protocol metadata.

Completed and failed job worktrees are retained by default for seven days. Run explicit garbage collection with:

```bash
bun run src/index.ts gc-worktrees --config config.local.json
```

## Service Mode

Example service definitions live in `examples/`:

- `dev.tetherbox.plist` for macOS `launchd`.
- `tetherbox.service` for Linux `systemd --user`.

Run the daemon as the same user that owns Codex auth, GitHub auth, SSH keys, and local repository checkouts.

## Linear Webhook

Create a Linear OAuth application for the agent and install it with `actor=app`. Request `app:assignable` so issues can be delegated to the agent and `app:mentionable` so users can mention it in comments, documents, and other editor surfaces. Enable the Agent session events webhook category.

Configure the Linear agent app webhook URL:

```text
https://your-public-host.example.com/webhooks/linear
```

The bridge verifies `Linear-Signature` with HMAC-SHA256 over the raw request body.
Set `LINEAR_API_KEY` (or the env var named by `linear.apiKeyEnv`) to the app actor token. When configured, Tetherbox emits Linear Agent Activities for thoughts, actions, responses, errors, and elicitation prompts, and updates the Agent Session plan/external URL. Without the token, those calls are logged locally as a dry-run fallback.

When a webhook includes an issue ID, Tetherbox asks Linear's repository suggestion API to rank the configured candidate repos using the issue, session, guidance, and Linear context. Explicit repo mentions still win; low-confidence or unavailable suggestions fall back to the static team mapping. Tune the threshold with `linear.repositorySuggestionMinConfidence`.

## Design

See [docs/design.md](docs/design.md).

## License

MIT
