import { CodexRunner, codexOptionsFromEnv, type RunOptions } from './codex.js'
import {
  controlHelpText,
  formatDuration,
  parseControlCommand,
  partitionReplay,
  type ControlCommand,
} from './control.js'
import { DiscordBridge } from './discord.js'
import { parseBoolean, parseNonNegativeInt } from './env.js'
import { warnUnsafeBotMode } from './safety.js'
import { installShutdownHandlers } from './shutdown.js'
import {
  acquireProcessLock,
  getStatePaths,
  listPendingMessages,
  loadStateEnv,
  markMessageHandled,
  markMessagesHandled,
  pruneOldFiles,
} from './state.js'
import type { LocalAttachment, QueuedMessage, StatePaths } from './types.js'

const LABEL = 'codex-discord relay'
const RUNNER_NAME = 'Codex'
const QUEUED_REACTION = '⏳'
const TYPING_INTERVAL_MS = 9000
const SHUTDOWN_GRACE_MS = 2500
const INBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_REPLAY_MAX_AGE_MS = 60 * 60 * 1000

// Abort reasons. A shutdown leaves the message pending so a restart can
// replay it; a user !stop marks it handled.
const ABORT_SHUTDOWN = 'shutdown'
const ABORT_STOP = 'stop'

export type RelayBridge = Pick<
  DiscordBridge,
  'sendMessage' | 'sendTyping' | 'react' | 'unreact' | 'downloadAttachmentFiles'
>

export type RelayRunner = {
  runForMessage(
    message: QueuedMessage,
    options?: RunOptions,
  ): Promise<{ text: string; filePaths: string[] }>
  forgetThread(chatId: string): Promise<void>
  currentThread(chatId: string): string | undefined
}

export type RelayOptions = {
  resumeByChannel: boolean
  replayMaxAgeMs: number
  downloadAttachments: boolean
}

type ActiveRun = {
  message: QueuedMessage
  controller: AbortController
  startedAt: number
  done: Promise<void>
}

type ChannelState = {
  waiting: QueuedMessage[]
  active?: ActiveRun
  // Set synchronously before the drain loop starts and cleared synchronously
  // when it exits, so an enqueue can never observe a finished-but-flagged loop.
  draining: boolean
  idle?: Promise<void>
  resetRequested: boolean
  // Messages we put the queued reaction on, so it can be taken off again.
  reacted: Set<string>
}

export function relayOptionsFromEnv(
  resumeByChannel: boolean,
  env: NodeJS.ProcessEnv = process.env,
): RelayOptions {
  return {
    resumeByChannel,
    replayMaxAgeMs: parseNonNegativeInt(
      env.CODEX_DISCORD_REPLAY_MAX_AGE_MS,
      DEFAULT_REPLAY_MAX_AGE_MS,
    ),
    downloadAttachments: parseBoolean(env.CODEX_DISCORD_RELAY_DOWNLOAD_ATTACHMENTS, true),
  }
}

// Owns the per-channel run queues. Runs within one channel are serial; control
// commands (!status/!stop/!new/!help) bypass the queue and answer immediately.
export class RelayController {
  private readonly channels = new Map<string, ChannelState>()
  private readonly controlTasks = new Set<Promise<void>>()
  private stopping = false
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(
    private readonly bridge: RelayBridge,
    private readonly runner: RelayRunner,
    private readonly paths: StatePaths,
    private readonly options: RelayOptions,
    hooks: { now?: () => number; log?: (line: string) => void } = {},
  ) {
    this.now = hooks.now ?? Date.now
    this.log = hooks.log ?? (line => process.stderr.write(`${LABEL}: ${line}\n`))
  }

  // Entry point for live inbound messages.
  handle(message: QueuedMessage): void {
    const command = parseControlCommand(message.content)
    if (command) {
      const task = this.runControl(command, message).catch(err => {
        this.log(`control command failed: ${err}`)
      })
      this.controlTasks.add(task)
      void task.finally(() => this.controlTasks.delete(task))
      return
    }
    this.enqueue(message, true)
  }

  // Re-queue messages left pending by a previous process. Stale ones and
  // leftover control commands are marked handled instead of re-run.
  async replayPending(messages: QueuedMessage[]): Promise<void> {
    const { replay, stale } = partitionReplay(messages, this.now(), this.options.replayMaxAgeMs)
    const runnable = replay.filter(message => !parseControlCommand(message.content))
    const dropped = [...stale, ...replay.filter(message => parseControlCommand(message.content))]
    if (dropped.length > 0) {
      await markMessagesHandled(
        dropped.map(message => message.id),
        this.paths,
      )
      this.log(`skipped ${dropped.length} stale pending message(s) instead of replaying them`)
    }
    for (const message of runnable) this.enqueue(message, false)
  }

  // Cancel in-flight runs (killing their processes) and wait briefly for them
  // to settle. Unstarted and cancelled messages stay pending for replay.
  async shutdown(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    this.stopping = true
    const running: Promise<void>[] = []
    for (const channel of this.channels.values()) {
      channel.waiting.length = 0
      if (channel.active) {
        channel.active.controller.abort(ABORT_SHUTDOWN)
        running.push(channel.active.done)
      }
    }
    if (running.length === 0) return
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.allSettled(running),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, graceMs)
      }),
    ])
    if (timer) clearTimeout(timer)
  }

  // Resolves once the channel has no queued or running work and no control
  // command is still replying (for tests).
  async whenIdle(chatId: string): Promise<void> {
    const channel = this.channels.get(chatId)
    while (channel?.draining || this.controlTasks.size > 0) {
      await Promise.all([channel?.idle, ...this.controlTasks])
    }
  }

  private channel(chatId: string): ChannelState {
    let state = this.channels.get(chatId)
    if (!state) {
      state = { waiting: [], draining: false, resetRequested: false, reacted: new Set() }
      this.channels.set(chatId, state)
    }
    return state
  }

  private enqueue(message: QueuedMessage, live: boolean): void {
    if (this.stopping) return
    const channel = this.channel(message.chatId)
    const busy = channel.active !== undefined || channel.waiting.length > 0
    channel.waiting.push(message)

    // Tell the user a message is queued behind a running task, not lost.
    if (busy && live) {
      channel.reacted.add(message.id)
      void this.bridge
        .react(message.chatId, message.messageId, QUEUED_REACTION)
        .catch(() => channel.reacted.delete(message.id))
    }

    if (!channel.draining) {
      channel.draining = true
      channel.idle = this.drain(channel)
    }
  }

  private async drain(channel: ChannelState): Promise<void> {
    try {
      while (!this.stopping) {
        const next = channel.waiting.shift()
        if (!next) break
        await this.process(channel, next)
      }
    } finally {
      channel.draining = false
    }
  }

  private async process(channel: ChannelState, message: QueuedMessage): Promise<void> {
    const controller = new AbortController()
    let markDone = (): void => {}
    const done = new Promise<void>(resolve => {
      markDone = resolve
    })
    channel.active = { message, controller, startedAt: this.now(), done }
    this.clearQueuedReaction(channel, message)

    const typing = setInterval(() => {
      void this.bridge.sendTyping(message.chatId).catch(() => {})
    }, TYPING_INTERVAL_MS)
    typing.unref()

    try {
      void this.bridge.sendTyping(message.chatId).catch(() => {})
      const attachments = await this.fetchAttachments(message)
      const result = await this.runner.runForMessage(message, {
        signal: controller.signal,
        attachments,
      })
      await this.sendResult(message, result.text, result.filePaths)
      await markMessageHandled(message.id, this.paths)
    } catch (err) {
      const reason = controller.signal.aborted ? controller.signal.reason : undefined
      // Shutdown: leave it pending so the next process can replay it.
      if (reason === ABORT_SHUTDOWN) return
      // !stop already told the user; just close the message out.
      if (reason !== ABORT_STOP) {
        const text = err instanceof Error ? err.message : String(err)
        await this.bridge
          .sendMessage({
            chatId: message.chatId,
            text: `${RUNNER_NAME} run failed: ${trimForDiscord(text)}`,
            replyTo: message.messageId,
          })
          .catch(sendErr => {
            this.log(`failed to report error: ${sendErr}`)
          })
      }
      await markMessageHandled(message.id, this.paths)
    } finally {
      clearInterval(typing)
      channel.active = undefined
      markDone()
      // A !new that arrived mid-run: the run just re-saved its thread, so
      // forget it again now that it has finished.
      if (channel.resetRequested) {
        channel.resetRequested = false
        await this.runner.forgetThread(message.chatId).catch(err => {
          this.log(`failed to reset conversation: ${err}`)
        })
      }
    }
  }

  private async fetchAttachments(message: QueuedMessage): Promise<LocalAttachment[]> {
    if (!this.options.downloadAttachments || message.attachments.length === 0) return []
    try {
      const files = await this.bridge.downloadAttachmentFiles(message.chatId, message.messageId)
      pruneOldFiles(this.paths.inboxDir, INBOX_MAX_AGE_MS, this.now())
      return files
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return message.attachments.map(item => ({ id: item.id, name: item.name, error }))
    }
  }

  // Deliver the run result, falling back to a text-only reply if attaching
  // fails — a bad file must not swallow the answer itself.
  private async sendResult(message: QueuedMessage, text: string, files: string[]): Promise<void> {
    try {
      await this.bridge.sendMessage({
        chatId: message.chatId,
        text,
        replyTo: message.messageId,
        files: files.length > 0 ? files : undefined,
      })
    } catch (err) {
      if (files.length === 0) throw err
      this.log(`attaching ${files.length} file(s) failed, retrying text-only: ${err}`)
      await this.bridge.sendMessage({
        chatId: message.chatId,
        text: `${text}\n\n(${files.length} generated file(s) could not be attached)`,
        replyTo: message.messageId,
      })
    }
  }

  private async runControl(command: ControlCommand, message: QueuedMessage): Promise<void> {
    const channel = this.channel(message.chatId)
    let reply: string

    switch (command) {
      case 'status':
        reply = this.describeStatus(channel, message.chatId)
        break
      case 'stop': {
        // Drop the queue and abort synchronously, before any await, so a run
        // that starts meanwhile cannot be the one that gets cancelled.
        const dropped = channel.waiting.splice(0)
        const active = channel.active
        active?.controller.abort(ABORT_STOP)
        for (const item of dropped) this.clearQueuedReaction(channel, item)
        await markMessagesHandled(
          dropped.map(item => item.id),
          this.paths,
        )
        const droppedText =
          dropped.length > 0 ? ` and dropped ${dropped.length} queued message(s)` : ''
        if (active) {
          reply = `Stopped the running ${RUNNER_NAME} task${droppedText}.`
        } else {
          reply =
            dropped.length > 0
              ? `Nothing was running; dropped ${dropped.length} queued message(s).`
              : 'Nothing is running.'
        }
        break
      }
      case 'new':
        if (!this.options.resumeByChannel) {
          reply = `Conversation resume is off, so every message already starts a fresh ${RUNNER_NAME} conversation.`
          break
        }
        // Flag before awaiting: the active run re-saves its thread when it
        // finishes, so it must be forgotten again afterwards.
        if (channel.active) channel.resetRequested = true
        await this.runner.forgetThread(message.chatId)
        if (channel.resetRequested) {
          reply = 'OK — the current task will finish, then the next message starts a fresh conversation.'
        } else {
          reply = 'OK — the next message starts a fresh conversation.'
        }
        break
      case 'help':
        reply = controlHelpText(RUNNER_NAME)
        break
    }

    try {
      await this.bridge.sendMessage({
        chatId: message.chatId,
        text: reply,
        replyTo: message.messageId,
      })
    } finally {
      await markMessageHandled(message.id, this.paths)
    }
  }

  private describeStatus(channel: ChannelState, chatId: string): string {
    const lines: string[] = []
    if (channel.active) {
      lines.push(
        `Running for ${formatDuration(this.now() - channel.active.startedAt)}: "${preview(
          channel.active.message.content,
        )}"`,
      )
    } else {
      lines.push('Idle — nothing is running.')
    }
    lines.push(`Queued: ${channel.waiting.length}`)

    if (this.options.resumeByChannel) {
      const thread = this.runner.currentThread(chatId)
      lines.push(
        thread
          ? `Conversation: resuming \`${thread}\` (send \`!new\` to start fresh)`
          : 'Conversation: the next message starts a fresh one',
      )
    } else {
      lines.push('Conversation: resume off — each message starts fresh')
    }
    return lines.join('\n')
  }

  private clearQueuedReaction(channel: ChannelState, message: QueuedMessage): void {
    if (!channel.reacted.delete(message.id)) return
    void this.bridge
      .unreact(message.chatId, message.messageId, QUEUED_REACTION)
      .catch(() => {})
  }
}

export async function runRelay(): Promise<void> {
  const paths = getStatePaths()
  loadStateEnv(paths)

  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) {
    throw new Error(
      `DISCORD_BOT_TOKEN is required. Set it in ${paths.envFile} or the process environment.`,
    )
  }

  const lock = acquireProcessLock(paths.botPidFile, LABEL)
  const bridge = new DiscordBridge(token, paths)
  const codexOptions = codexOptionsFromEnv()
  warnUnsafeBotMode(codexOptions)
  const runner = new CodexRunner(codexOptions, paths)
  const relay = new RelayController(
    bridge,
    runner,
    paths,
    relayOptionsFromEnv(codexOptions.resumeByChannel),
  )

  pruneOldFiles(paths.inboxDir, INBOX_MAX_AGE_MS)
  bridge.on('message', message => relay.handle(message as QueuedMessage))
  await relay.replayPending(listPendingMessages(100, paths))

  installShutdownHandlers({
    label: LABEL,
    stop: async () => {
      try {
        await relay.shutdown()
        await bridge.stop()
      } finally {
        lock.release()
      }
    },
  })
  try {
    await bridge.start()
    process.stderr.write(`${LABEL}: ready\n`)
  } catch (err) {
    lock.release()
    throw err
  }
}

function preview(value: string, limit = 80): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine
}

function trimForDiscord(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > 1500 ? `${trimmed.slice(0, 1500)}...` : trimmed
}
