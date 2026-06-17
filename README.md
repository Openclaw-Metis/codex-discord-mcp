# codex-discord-mcp

Connect a Discord bot to Codex CLI.

This project intentionally differs from Anthropic's Discord channel plugin: Claude Code has a custom `claude/channel` MCP notification path, while Codex documents standard MCP tools plus `codex exec` / `codex mcp-server`. This bridge therefore supports two modes:

- `bot`: a Discord gateway bot receives allowed messages, runs `codex exec --json`, then posts the final Codex answer back to Discord.
- `mcp`: a standard MCP stdio server that gives Codex Discord tools such as `reply`, `fetch_messages`, and `download_attachment`. Inbound Discord messages are stored in a local queue and can be polled with `list_pending_messages`.

## Requirements

- Node.js 20 or newer.
- Codex CLI installed and authenticated for `bot` mode.
- A Discord application with a bot token.
- Discord bot privileged **Message Content Intent** enabled.

## Install

```powershell
npm install
npm run build
```

From this directory, the CLI is available as:

```powershell
node .\dist\cli.js --help
```

If you install it globally or link it with `npm link`, use `codex-discord-mcp`.

## Discord Bot Setup

1. Create a Discord application in the Discord Developer Portal.
2. Add a bot and copy its token.
3. Enable **Message Content Intent** for the bot.
4. Invite the bot to a server if you want guild channels. Useful permissions:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - Attach Files
   - Add Reactions

Store the token locally:

```powershell
node .\dist\cli.js configure "YOUR_DISCORD_BOT_TOKEN"
```

The token is written to `~/.codex/discord/.env` by default. Override the state directory with `CODEX_DISCORD_STATE_DIR`.

## Mode 1: Discord to Codex Relay

Run:

```powershell
node .\dist\cli.js bot
```

Default behavior:

- Unknown DM users receive a pairing code.
- Pair locally with `node .\dist\cli.js access pair <code>`.
- After pairing, each DM message triggers `codex exec --json`.
- The final Codex message is posted as a Discord reply.

Useful environment variables:

```powershell
$env:CODEX_WORKDIR="C:\path\to\repo"
$env:CODEX_SANDBOX="workspace-write"
$env:CODEX_APPROVAL_POLICY="never"
$env:CODEX_RESUME_BY_CHANNEL="true"
node .\dist\cli.js bot
```

Keep `CODEX_APPROVAL_POLICY=never` for unattended relay mode. Use the least permissive sandbox that fits your use case.

Attachment uploads are restricted by default to the bridge process working directory, `CODEX_WORKDIR`, and the bridge inbox. To allow generated files from other roots, set `CODEX_DISCORD_ATTACHMENT_ROOTS` to a path-list using your platform delimiter:

```powershell
$env:CODEX_DISCORD_ATTACHMENT_ROOTS="C:\path\to\repo;C:\path\to\exports"
```

## Mode 2: Codex MCP Tools

Build first, then print a config snippet:

```powershell
node .\dist\cli.js print-config
```

Add the snippet to `~/.codex/config.toml` or a trusted project `.codex/config.toml`. A typical local config looks like:

```toml
[mcp_servers.discord]
command = "node"
args = ["C:\\path\\to\\codex-discord-mcp\\dist\\cli.js", "mcp"]
startup_timeout_sec = 20
tool_timeout_sec = 60
```

Then start Codex and run `/mcp` to confirm the Discord tools are loaded.

Available MCP tools:

- `reply` / `send_message`
- `react`
- `edit_message`
- `fetch_messages`
- `download_attachment`
- `list_pending_messages`
- `mark_message_handled`
- `bridge_status`

## Access Control

Access is managed by local CLI commands, not MCP tools.

```powershell
node .\dist\cli.js access show
node .\dist\cli.js access policy allowlist
node .\dist\cli.js access allow-user 123456789012345678
node .\dist\cli.js access allow-channel 234567890123456789
node .\dist\cli.js access allow-channel 234567890123456789 --no-mention
```

DM policy values:

- `pairing`: unknown DM users get a one-hour pairing code. This is the default.
- `allowlist`: unknown DM users are silently ignored.
- `disabled`: all DMs are ignored.

Guild channels are opt-in by channel ID. By default, the bot only responds in an allowed guild channel when it is mentioned or when the user replies to a recent bot message. Use `--no-mention` only for dedicated bot channels.

## Security Notes

- Discord messages are untrusted input. The relay prompt tells Codex not to follow requests to approve pairings, reveal secrets, or alter bridge policy.
- The bridge refuses to attach its own state files, except files downloaded into the inbox. It also blocks attachment paths outside the configured attachment roots.
- `bot` mode is unattended automation. Keep Codex sandboxing restrictive unless the bot is running in an isolated workspace.
- Access changes require local terminal commands.

## Troubleshooting

```powershell
node .\dist\cli.js doctor
node .\dist\cli.js access show
```

If the bot receives empty message content, enable Message Content Intent in the Discord Developer Portal.

If `bot` mode cannot launch Codex, set `CODEX_COMMAND` to the full executable path or run the bridge from the same shell where `codex exec "hello"` works.
