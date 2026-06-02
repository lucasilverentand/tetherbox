# macOS launchd Install

Install Tetherbox as the current user. Do not use `sudo`; the daemon needs the same Codex, GitHub, Git, SSH, and repository access as the interactive developer account.

Default paths:

- Config: `~/.config/tetherbox/config.json`
- Optional env file: `~/.config/tetherbox/tetherbox.env`
- State: configure `state.path` in JSON, for example `~/.local/state/tetherbox/daemon.sqlite`
- Generated plist: `~/Library/LaunchAgents/dev.tetherbox.plist`
- Logs: `~/Library/Logs/tetherbox.log` and `~/Library/Logs/tetherbox.err.log`

Prepare config:

```bash
mkdir -p ~/.config/tetherbox ~/.local/state/tetherbox
cp examples/config.json ~/.config/tetherbox/config.json
```

Put Linear secrets in the optional env file if you do not provide them through `launchctl setenv`:

```bash
cat > ~/.config/tetherbox/tetherbox.env <<'EOF'
export LINEAR_WEBHOOK_SECRET=...
export LINEAR_API_KEY=...
export LINEAR_CLIENT_ID=...
export LINEAR_CLIENT_SECRET=...
EOF
chmod 600 ~/.config/tetherbox/tetherbox.env
```

Preview the generated plist and commands:

```bash
bun run install:macos -- --dry-run --config ~/.config/tetherbox/config.json --env-file ~/.config/tetherbox/tetherbox.env
```

Install and start:

```bash
bun run install:macos -- --config ~/.config/tetherbox/config.json --env-file ~/.config/tetherbox/tetherbox.env
```

Check status:

```bash
launchctl print gui/$(id -u)/dev.tetherbox
tail -f ~/Library/Logs/tetherbox.log ~/Library/Logs/tetherbox.err.log
```

Uninstall:

```bash
bun run uninstall:macos
```
