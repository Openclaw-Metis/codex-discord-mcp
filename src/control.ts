import type { QueuedMessage } from './types.js'

// Relay control commands. They are handled immediately by the relay, outside
// the per-channel run queue, so they still work while a long run is busy.
export type ControlCommand = 'status' | 'stop' | 'new' | 'help'

const COMMAND_ALIASES: Record<string, ControlCommand> = {
  status: 'status',
  stop: 'stop',
  cancel: 'stop',
  new: 'new',
  reset: 'new',
  help: 'help',
}

// A control command is the whole message: `!status`, `/stop`, ... Leading
// user/role mentions are ignored so `@bot !stop` works in mention-gated
// channels. Anything else (e.g. "!stop the server please") is a normal prompt.
export function parseControlCommand(content: string): ControlCommand | undefined {
  const stripped = content.replace(/^(?:\s*<@[!&]?\d+>)+/, '').trim()
  const match = /^[!/]([a-z]+)$/i.exec(stripped)
  if (!match) return undefined
  return COMMAND_ALIASES[match[1].toLowerCase()]
}

// Split restart-time pending messages into ones fresh enough to replay and
// stale ones that should be dropped. Replaying an hours-old request (e.g.
// "restart the service") after a crash is more surprising than useful.
// maxAgeMs <= 0 disables replay entirely.
export function partitionReplay(
  messages: QueuedMessage[],
  now: number,
  maxAgeMs: number,
): { replay: QueuedMessage[]; stale: QueuedMessage[] } {
  const replay: QueuedMessage[] = []
  const stale: QueuedMessage[] = []
  for (const message of messages) {
    const receivedAt = Date.parse(message.receivedAt)
    const fresh =
      maxAgeMs > 0 && Number.isFinite(receivedAt) && now - receivedAt <= maxAgeMs
    ;(fresh ? replay : stale).push(message)
  }
  return { replay, stale }
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function controlHelpText(runnerName: string): string {
  return [
    `Relay commands (they work even while ${runnerName} is busy):`,
    '`!status` — what is running and how many messages are queued',
    '`!stop` — cancel the running task and drop queued messages',
    '`!new` — start a fresh conversation (forget the resumed thread)',
    '`!help` — this list',
  ].join('\n')
}
