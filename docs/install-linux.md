# Linux systemd User Install

Install Tetherbox as the current user with `systemd --user`. Do not install it as root unless root also owns the Codex auth, GitHub auth, Git SSH keys, and local repository checkouts.

Default paths:

- Config: `~/.config/tetherbox/config.json`
- Optional env file: `~/.config/tetherbox/tetherbox.env`
- State: configure `state.path` in JSON, for example `~/.local/state/tetherbox/daemon.sqlite`
- Generated service: `~/.config/systemd/user/tetherbox.service`

Prepare config:

```bash
mkdir -p ~/.config/tetherbox ~/.local/state/tetherbox
cp examples/config.json ~/.config/tetherbox/config.json
```

Put Linear secrets in the optional env file:

```bash
cat > ~/.config/tetherbox/tetherbox.env <<'EOF'
LINEAR_WEBHOOK_SECRET=...
LINEAR_API_KEY=...
LINEAR_CLIENT_ID=...
LINEAR_CLIENT_SECRET=...
EOF
chmod 600 ~/.config/tetherbox/tetherbox.env
```

Preview the generated service and commands:

```bash
bun run install:linux -- --dry-run --config ~/.config/tetherbox/config.json --env-file ~/.config/tetherbox/tetherbox.env
```

Install and start:

```bash
bun run install:linux -- --config ~/.config/tetherbox/config.json --env-file ~/.config/tetherbox/tetherbox.env
```

Check status:

```bash
systemctl --user status tetherbox.service
journalctl --user -u tetherbox.service -f
```

Uninstall:

```bash
bun run uninstall:linux
```
