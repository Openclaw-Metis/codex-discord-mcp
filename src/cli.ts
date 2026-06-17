#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { accessSync, constants } from 'node:fs'
import {
  approvePendingCode,
  defaultAccess,
  getStatePaths,
  loadAccess,
  loadStateEnv,
  saveAccess,
  writeToken,
} from './state.js'
import { runMcpServer } from './mcp.js'
import { runRelay } from './relay.js'
import type { DmPolicy } from './types.js'

async function main(): Promise<void> {
  const [command = 'mcp', ...args] = process.argv.slice(2)

  switch (command) {
    case 'mcp':
      await runMcpServer()
      return
    case 'bot':
      await runRelay()
      return
    case 'configure':
      configure(args)
      return
    case 'access':
      accessCommand(args)
      return
    case 'print-config':
      printConfig()
      return
    case 'doctor':
      doctor()
      return
    case '-h':
    case '--help':
    case 'help':
      printHelp()
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

function configure(args: string[]): void {
  const token = args[0]
  if (!token) throw new Error('Usage: codex-discord-mcp configure <discord-bot-token>')
  const paths = getStatePaths()
  writeToken(token, paths)
  process.stdout.write(`Wrote token to ${paths.envFile}\n`)
}

function accessCommand(args: string[]): void {
  const [subcommand, ...rest] = args
  const paths = getStatePaths()
  const access = loadAccess(paths)

  switch (subcommand) {
    case 'show':
    case undefined:
      process.stdout.write(`${JSON.stringify(access, null, 2)}\n`)
      return
    case 'reset':
      saveAccess(defaultAccess(), paths)
      process.stdout.write(`Reset access policy in ${paths.accessFile}\n`)
      return
    case 'pair': {
      const code = rest[0]
      if (!code) throw new Error('Usage: codex-discord-mcp access pair <code>')
      const approved = approvePendingCode(code, paths)
      process.stdout.write(
        `Approved ${approved.username ?? approved.senderId} (${approved.senderId})\n`,
      )
      return
    }
    case 'policy': {
      const policy = rest[0] as DmPolicy | undefined
      if (policy !== 'pairing' && policy !== 'allowlist' && policy !== 'disabled') {
        throw new Error('Usage: codex-discord-mcp access policy <pairing|allowlist|disabled>')
      }
      access.dmPolicy = policy
      saveAccess(access, paths)
      process.stdout.write(`DM policy set to ${policy}\n`)
      return
    }
    case 'allow-user': {
      const userId = rest[0]
      if (!userId) throw new Error('Usage: codex-discord-mcp access allow-user <discord-user-id>')
      if (!access.allowUsers.includes(userId)) access.allowUsers.push(userId)
      saveAccess(access, paths)
      process.stdout.write(`Allowed user ${userId}\n`)
      return
    }
    case 'remove-user': {
      const userId = rest[0]
      if (!userId) throw new Error('Usage: codex-discord-mcp access remove-user <discord-user-id>')
      access.allowUsers = access.allowUsers.filter(id => id !== userId)
      saveAccess(access, paths)
      process.stdout.write(`Removed user ${userId}\n`)
      return
    }
    case 'allow-channel': {
      const channelId = rest[0]
      if (!channelId) {
        throw new Error(
          'Usage: codex-discord-mcp access allow-channel <channel-id> [--no-mention] [--allow-user <user-id>...]',
        )
      }
      const allowUsers = valuesAfter(rest, '--allow-user')
      access.channels[channelId] = {
        requireMention: !rest.includes('--no-mention'),
        allowUsers,
      }
      saveAccess(access, paths)
      process.stdout.write(`Allowed channel ${channelId}\n`)
      return
    }
    case 'remove-channel': {
      const channelId = rest[0]
      if (!channelId) {
        throw new Error('Usage: codex-discord-mcp access remove-channel <channel-id>')
      }
      delete access.channels[channelId]
      saveAccess(access, paths)
      process.stdout.write(`Removed channel ${channelId}\n`)
      return
    }
    case 'ack': {
      const value = rest[0]
      if (!value) throw new Error('Usage: codex-discord-mcp access ack <emoji|off>')
      access.ackReaction = value === 'off' ? undefined : value
      saveAccess(access, paths)
      process.stdout.write(value === 'off' ? 'Ack reaction disabled\n' : `Ack reaction set to ${value}\n`)
      return
    }
    case 'mention-pattern': {
      mentionPatternCommand(rest)
      return
    }
    case 'help':
    case '-h':
    case '--help':
      printAccessHelp()
      return
    default:
      throw new Error(`Unknown access command: ${subcommand}`)
  }
}

function mentionPatternCommand(args: string[]): void {
  const [action, pattern] = args
  const paths = getStatePaths()
  const access = loadAccess(paths)
  access.mentionPatterns ??= []

  if (action === 'list' || action == null) {
    process.stdout.write(`${JSON.stringify(access.mentionPatterns, null, 2)}\n`)
    return
  }

  if (action === 'add') {
    if (!pattern) throw new Error('Usage: codex-discord-mcp access mention-pattern add <regex>')
    if (!access.mentionPatterns.includes(pattern)) access.mentionPatterns.push(pattern)
    saveAccess(access, paths)
    process.stdout.write(`Added mention pattern ${pattern}\n`)
    return
  }

  if (action === 'remove') {
    if (!pattern) throw new Error('Usage: codex-discord-mcp access mention-pattern remove <regex>')
    access.mentionPatterns = access.mentionPatterns.filter(item => item !== pattern)
    saveAccess(access, paths)
    process.stdout.write(`Removed mention pattern ${pattern}\n`)
    return
  }

  throw new Error('Usage: codex-discord-mcp access mention-pattern <list|add|remove>')
}

function printConfig(): void {
  const cliPath = fileURLToPath(import.meta.url)
  process.stdout.write(`# Add this to ~/.codex/config.toml or .codex/config.toml:

[mcp_servers.discord]
command = "node"
args = [${tomlString(cliPath)}, "mcp"]
startup_timeout_sec = 20
tool_timeout_sec = 60

# Token can live in ${getStatePaths().envFile}, or you can forward env instead:
# env_vars = ["DISCORD_BOT_TOKEN"]
`)
}

function doctor(): void {
  const paths = getStatePaths()
  loadStateEnv(paths)
  const rows = [
    ['stateDir', paths.stateDir],
    ['envFile', exists(paths.envFile) ? 'present' : 'missing'],
    ['DISCORD_BOT_TOKEN', process.env.DISCORD_BOT_TOKEN ? 'set' : 'missing'],
    ['accessFile', exists(paths.accessFile) ? 'present' : 'missing'],
  ]

  for (const [key, value] of rows) {
    process.stdout.write(`${key}: ${value}\n`)
  }
}

function printHelp(): void {
  process.stdout.write(`codex-discord-mcp

Commands:
  mcp                       Run the Discord MCP server over stdio
  bot                       Run Discord -> codex exec relay mode
  configure <token>          Store DISCORD_BOT_TOKEN in the state .env file
  access <command>           Manage local allowlist and pairing
  print-config               Print a Codex config.toml MCP snippet
  doctor                     Show basic local configuration status

Run "codex-discord-mcp access help" for access commands.
`)
}

function printAccessHelp(): void {
  process.stdout.write(`codex-discord-mcp access commands:

  show
  reset
  pair <code>
  policy <pairing|allowlist|disabled>
  allow-user <discord-user-id>
  remove-user <discord-user-id>
  allow-channel <channel-id> [--no-mention] [--allow-user <user-id>...]
  remove-channel <channel-id>
  ack <emoji|off>
  mention-pattern <list|add|remove> [regex]
`)
}

function valuesAfter(args: string[], flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1]) {
      values.push(args[i + 1])
      i += 1
    }
  }
  return values
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function exists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
