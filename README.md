# Local Linear Codex Bridge

Open-source bridge for delegating Linear agent sessions to Codex running locally on a Linux or macOS host.

The bridge receives Linear agent webhooks, applies local policy, starts `codex app-server`, streams progress back to Linear, and prepares the path for branches, validation, commits, and pull requests.

## Status

Early scaffold. The current app includes:

- Linear webhook HTTP endpoint.
- Linear webhook signature verification.
- Basic agent-session event parsing.
- Repository routing from local config.
- Deterministic policy decisions.
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
bun run src/index.ts serve --config config.local.json
```

The daemon listens on the configured host and port. Use a tunnel such as Cloudflare Tunnel, Tailscale Funnel, or ngrok during development so Linear can reach `/webhooks/linear`.

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
