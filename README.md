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
- Daemon state persisted to a local JSON file.
- `/healthz` and `/api/status` daemon endpoints.
- Terminal UI for watching jobs and events.
- Per-job Git worktrees under the configured daemon state directory.
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

Open the terminal UI in another shell:

```bash
bun run src/index.ts tui --url http://127.0.0.1:8787
```

Press `q` to quit.

`serve` remains as an alias for `daemon`.

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

Configure the Linear agent app webhook URL:

```text
https://your-public-host.example.com/webhooks/linear
```

The bridge verifies `Linear-Signature` with HMAC-SHA256 over the raw request body.

## Design

See [docs/design.md](docs/design.md).

## License

MIT
