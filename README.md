# vibingnow

The open source command line tool behind [vibingnow.online](https://vibingnow.online), a live globe of people coding with AI.

It has no runtime dependencies. Everything it does on your computer is in this repo.

```
npx vibingnow@latest
```

Pin a version if you prefer, for example `npx vibingnow@0.3.1`. Each release is tagged here with the same number.

Your browser opens, you click **Approve**, and you're on the map.

## Read before you run it

### What it changes on your computer

- **Claude Code:** adds two hooks to `~/.claude/settings.json`. A backup is written first and your other settings are kept.
- **Codex:** if installed, adds one `notify` line to `~/.codex/config.toml`.
- **A once-a-minute job:** Task Scheduler on Windows, a LaunchAgent on macOS, a systemd user timer or crontab line on Linux.
- **Its own files:** a config file holding this computer's token, and a state file.
- **One backup of each settings file it edits**, next to the original (for example `settings.json.vibingnow-backup-<date>`). Settings can hold API keys, so the backup is private to your user, there is only ever one, and `disconnect` deletes it.

### What it reads

It reads your AI tools' local session logs to count usage. Those logs contain your conversations, so this is the part worth checking in the code.

| Tool | Location |
| --- | --- |
| Claude Code | `~/.claude/projects` |
| Codex | `~/.codex/sessions` |
| Gemini CLI | `~/.gemini/tmp` |
| OpenCode | `~/.local/share/opencode` |

It looks at them only to work out the numbers below. To count failed tests, it scans tool output for patterns like `3 failed`. That text is never stored or sent.

### What it sends

One small JSON message to `https://vibingnow.online/api/ingest`. This is the whole shape, from [`src/hook.ts`](src/hook.ts):

```jsonc
{
  "tokensDelta": 1240,          // new tokens since the last send
  "reread": 58000,              // cached tokens re-read
  "model": "claude-opus-4",     // model name
  "activeSeconds": 60,
  "tool": "claude-code",
  "signals": { "errors": 1, "retries": 0, "testsFailed": 0, "interrupts": 0 }
}
```

**Never sent:** prompts, replies, code, file names, project names, paths, keys or your location.

### What's public

Your token numbers, model, mood and city appear on the globe. You can hide your token numbers in Edit profile.

## Commands

```
npx vibingnow status      # what's connected and the last send
npx vibingnow test        # send a test ping
npx vibingnow disconnect  # remove the hooks and the job, and revoke this computer
```

`disconnect` puts things back as they were, and deletes the backups and its own files.

## Build from source

```
npm install typescript @types/node --no-save
npx tsc -p tsconfig.json
```

## Licence

MIT
