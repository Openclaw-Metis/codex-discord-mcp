# codex-discord-mcp

A local-first Discord bridge for Codex CLI.

Use it in three ways:

1. Discord -> Codex: mention or DM your bot, run `codex exec --json`, and post the final answer back to Discord.
2. Codex -> Discord: expose Discord tools to Codex through MCP, including `reply`, `fetch_messages`, `react`, `edit_message`, and `download_attachment`.
3. Hybrid workflow: receive Discord messages into a local queue, then let Codex inspect and respond through MCP tools.

This is not an official OpenAI plugin. It is a local bridge designed around Codex CLI, MCP, and Discord bot APIs.

## Which Mode Should I Use?

| Goal | Use |
| --- | --- |
| DM Codex from Discord | `bot` mode |
| Let Codex send Discord replies | `mcp` mode |
| Let Codex read recent Discord messages | `mcp` mode |
| Queue Discord messages for Codex to inspect | `mcp` mode with `list_pending_messages` |
| Fully automatic Discord -> Codex -> Discord | `bot` mode |

## Security Model

This bridge treats Discord as untrusted input.

Discord users cannot:

- approve pairings
- allow users
- allow channels
- change bridge policy
- read bridge state files
- bypass Codex sandbox or approval settings

Only local terminal commands can change access policy. MCP tools can read and reply through allowlisted Discord channels, but they cannot modify the allowlist or approve pairings.

Default safety posture:

- Default sandbox: `read-only`
- Default approval policy: `never`, because `bot` mode is non-interactive
- Recommended first run: `read-only`
- Use `workspace-write` only in an isolated repository or disposable worktree
- Never use `danger-full-access` for a public Discord channel

When `bot` mode starts with `CODEX_SANDBOX=workspace-write` or `CODEX_SANDBOX=danger-full-access` and `CODEX_APPROVAL_POLICY=never`, the bridge prints a runtime warning. Set `CODEX_DISCORD_ASSUME_YES=true` to suppress the warning in controlled automation.

## Requirements

- Node.js 20 or newer.
- Codex CLI installed and authenticated for `bot` mode.
- A Discord application with a bot token.
- Discord bot privileged **Message Content Intent** enabled.

## Install

Global install:

```bash
npm install -g codex-discord-mcp
codex-discord-mcp doctor
codex-discord-mcp init
```

Run through `npx` without a global install:

```bash
npx -y codex-discord-mcp doctor
```

Local development install:

```bash
npm install
npm run build
node ./dist/cli.js --help
```

## Discord Bot Setup

1. Create a Discord application in the Discord Developer Portal.
2. Add a bot and copy its token.
3. Enable **Message Content Intent** for the bot.
4. Invite the bot to a server if you want guild channels.

Useful bot permissions:

- View Channels
- Send Messages
- Send Messages in Threads
- Read Message History
- Attach Files
- Add Reactions

Print an invite URL:

```bash
codex-discord-mcp invite-url <client-id>
```

Store the token locally:

```bash
codex-discord-mcp configure
```

The token is written to `~/.codex/discord/.env` by default. Override the state directory with `CODEX_DISCORD_STATE_DIR`.

You can also read the token from an existing environment variable:

```bash
codex-discord-mcp configure --token-env DISCORD_BOT_TOKEN
```

## Quick Start

Interactive setup:

```bash
codex-discord-mcp init
```

Check local configuration:

```bash
codex-discord-mcp doctor
codex-discord-mcp doctor --json
```

## Mode 1: Discord To Codex Relay

Run:

```bash
codex-discord-mcp bot
```

Default behavior:

- Unknown DM users receive a one-hour pairing code.
- Pair locally with `codex-discord-mcp access pair <code>`.
- After pairing, each DM message triggers `codex exec --json`.
- The final Codex message is posted as a Discord reply.

Useful environment variables:

```bash
export CODEX_WORKDIR="/path/to/repo"
export CODEX_SANDBOX="read-only"
export CODEX_APPROVAL_POLICY="never"
export CODEX_RESUME_BY_CHANNEL="true"
codex-discord-mcp bot
```

For unattended relay mode, keep `CODEX_APPROVAL_POLICY=never` and use the least permissive sandbox that fits the channel.

## Mode 2: Codex MCP Tools

Print a local config snippet:

```bash
codex-discord-mcp print-config
```

Print an `npx` based config snippet:

```bash
codex-discord-mcp print-config --npx
```

Add the snippet to `~/.codex/config.toml` or a trusted project `.codex/config.toml`. A typical `npx` config looks like:

```toml
[mcp_servers.discord]
command = "npx"
args = ["-y", "codex-discord-mcp", "mcp"]
startup_timeout_sec = 20
tool_timeout_sec = 60
```

Then start Codex and run `/mcp` to confirm the Discord tools are loaded.

Available MCP tools:

| Tool | Risk | Notes |
| --- | --- | --- |
| `fetch_messages` | Low | Reads recent allowlisted channel history |
| `list_pending_messages` | Low | Reads local queue entries |
| `bridge_status` | Low | Reads local bridge status |
| `react` | Low | Adds a reaction |
| `reply` | Medium | Sends a Discord message |
| `send_message` | Medium | Sends a Discord message |
| `edit_message` | Medium | Edits a message previously sent by the bot |
| `download_attachment` | Medium | Downloads Discord attachments into the local inbox |
| `mark_message_handled` | Medium | Mutates local queue state |

## Access Control

Access is managed by local CLI commands, not MCP tools.

```bash
codex-discord-mcp access show
codex-discord-mcp access policy allowlist
codex-discord-mcp access allow-user 123456789012345678
codex-discord-mcp access allow-channel 234567890123456789
codex-discord-mcp access allow-channel 234567890123456789 --no-mention
```

DM policy values:

- `pairing`: unknown DM users get a one-hour pairing code. This is the default.
- `allowlist`: unknown DM users are silently ignored.
- `disabled`: all DMs are ignored.

Guild channels are opt-in by channel ID. By default, the bot only responds in an allowed guild channel when it is mentioned or when the user replies to a recent bot message. Use `--no-mention` only for dedicated bot channels.

## Attachment Safety

The bridge refuses to attach its own state files, except files downloaded into the inbox. It also blocks attachment paths outside the configured attachment roots.

Attachment uploads are restricted by default to:

- the bridge process working directory
- `CODEX_WORKDIR`
- the bridge inbox

To allow generated files from other roots, set `CODEX_DISCORD_ATTACHMENT_ROOTS` using your platform path delimiter:

```bash
export CODEX_DISCORD_ATTACHMENT_ROOTS="/path/to/repo:/path/to/exports"
```

On Windows PowerShell:

```powershell
$env:CODEX_DISCORD_ATTACHMENT_ROOTS="C:\path\to\repo;C:\path\to\exports"
```

## Configuration Reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | required | Discord bot token |
| `CODEX_DISCORD_STATE_DIR` | `~/.codex/discord` | Bridge state directory |
| `CODEX_COMMAND` | `codex` | Codex executable |
| `CODEX_WORKDIR` | process cwd | Working directory for Codex |
| `CODEX_SANDBOX` | `read-only` | Codex sandbox mode |
| `CODEX_APPROVAL_POLICY` | `never` | Codex approval policy for non-interactive bot mode |
| `CODEX_MODEL` | unset | Override Codex model |
| `CODEX_PROFILE` | unset | Use a Codex profile |
| `CODEX_RESUME_BY_CHANNEL` | `false` | Resume one Codex thread per Discord channel |
| `CODEX_TIMEOUT_MS` | `900000` | Codex process timeout in milliseconds |
| `CODEX_EXTRA_ARGS` | unset | Extra arguments passed to Codex |
| `CODEX_SKIP_GIT_REPO_CHECK` | `true` | Pass `--skip-git-repo-check` to `codex exec` |
| `CODEX_DISCORD_ATTACHMENT_ROOTS` | cwd, workdir, inbox | Allowed outbound file roots |
| `CODEX_DISCORD_ASSUME_YES` | `false` | Suppress writable unattended bot warning |

## Troubleshooting

```bash
codex-discord-mcp doctor
codex-discord-mcp access show
```

If the bot receives empty message content, enable Message Content Intent in the Discord Developer Portal.

If `bot` mode cannot launch Codex, set `CODEX_COMMAND` to the full executable path or run the bridge from the same shell where `codex exec "hello"` works.

If MCP tools do not appear, run:

```bash
codex-discord-mcp print-config --npx
```

Then add the printed snippet to Codex config and restart Codex.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Development commands:

```bash
npm run dev:mcp
npm run dev:bot
```

## Release

The package is prepared for npm publishing with:

- `bin` entry: `codex-discord-mcp`
- `files` whitelist for published package contents
- `prepublishOnly` validation: typecheck, tests, build
- Linux and Windows GitHub Actions CI
