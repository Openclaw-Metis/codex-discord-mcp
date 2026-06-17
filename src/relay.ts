import { CodexRunner, codexOptionsFromEnv } from './codex.js'
import { DiscordBridge } from './discord.js'
import {
  getStatePaths,
  listPendingMessages,
  loadStateEnv,
  markMessageHandled,
} from './state.js'
import type { QueuedMessage, StatePaths } from './types.js'

export async function runRelay(): Promise<void> {
  const paths = getStatePaths()
  loadStateEnv(paths)

  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) {
    throw new Error(
      `DISCORD_BOT_TOKEN is required. Set it in ${paths.envFile} or the process environment.`,
    )
  }

  const bridge = new DiscordBridge(token, paths)
  const runner = new CodexRunner(codexOptionsFromEnv(), paths)
  const chains = new Map<string, Promise<void>>()

  function enqueue(message: QueuedMessage): void {
    const previous = chains.get(message.chatId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => processMessage(bridge, runner, message, paths))

    chains.set(message.chatId, next)
    void next.finally(() => {
      if (chains.get(message.chatId) === next) chains.delete(message.chatId)
    })
  }

  bridge.on('message', message => enqueue(message as QueuedMessage))

  for (const pending of listPendingMessages(100, paths)) {
    enqueue(pending)
  }

  installShutdownHandlers(bridge)
  await bridge.start()
  process.stderr.write('codex-discord relay: ready\n')
}

async function processMessage(
  bridge: DiscordBridge,
  runner: CodexRunner,
  message: QueuedMessage,
  paths: StatePaths,
): Promise<void> {
  const typing = setInterval(() => {
    void bridge.sendTyping(message.chatId).catch(() => {})
  }, 9000)
  typing.unref()

  try {
    void bridge.sendTyping(message.chatId).catch(() => {})
    const result = await runner.runForMessage(message)
    await bridge.sendMessage({
      chatId: message.chatId,
      text: result.text,
      replyTo: message.messageId,
    })
    markMessageHandled(message.id, paths)
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    await bridge
      .sendMessage({
        chatId: message.chatId,
        text: `Codex run failed: ${trimForDiscord(text)}`,
        replyTo: message.messageId,
      })
      .catch(sendErr => {
        process.stderr.write(`codex-discord relay: failed to report error: ${sendErr}\n`)
      })
    markMessageHandled(message.id, paths)
  } finally {
    clearInterval(typing)
  }
}

function trimForDiscord(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > 1500 ? `${trimmed.slice(0, 1500)}...` : trimmed
}

function installShutdownHandlers(bridge: DiscordBridge): void {
  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write('codex-discord relay: shutting down\n')
    void bridge.stop().finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
