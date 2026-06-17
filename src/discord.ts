import { EventEmitter } from 'node:events'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Attachment,
  type Message,
} from 'discord.js'
import { sanitizeOneLine, splitDiscordText } from './chunk.js'
import {
  appendQueuedMessage,
  loadAccess,
  pruneExpiredPending,
  saveAccess,
} from './state.js'
import type { AttachmentMeta, QueuedMessage, StatePaths } from './types.js'

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const RECENT_SENT_CAP = 200

export type DiscordBridgeEvents = {
  message: [QueuedMessage]
}

export class DiscordBridge extends EventEmitter {
  readonly client: Client
  private readonly recentSentIds = new Set<string>()
  private readonly dmChannelUsers = new Map<string, string>()
  private approvalTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly token: string,
    private readonly paths: StatePaths,
  ) {
    super()
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    })

    this.client.on('messageCreate', message => {
      if (message.author.bot) return
      this.handleInbound(message).catch(err => {
        process.stderr.write(`discord bridge: inbound handling failed: ${err}\n`)
      })
    })

    this.client.on('error', err => {
      process.stderr.write(`discord bridge: client error: ${err}\n`)
    })
  }

  async start(): Promise<void> {
    this.client.once('ready', client => {
      process.stderr.write(`discord bridge: connected as ${client.user.tag}\n`)
    })
    this.approvalTimer = setInterval(() => this.checkApprovals(), 5000)
    this.approvalTimer.unref()
    await this.client.login(this.token)
  }

  async stop(): Promise<void> {
    if (this.approvalTimer) clearInterval(this.approvalTimer)
    await this.client.destroy()
  }

  async sendMessage(params: {
    chatId: string
    text: string
    replyTo?: string
    files?: string[]
  }): Promise<string[]> {
    const channel = await this.fetchAllowedChannel(params.chatId)
    if (!('send' in channel)) throw new Error('channel is not sendable')

    const access = loadAccess(this.paths)
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? 2000, 2000))
    const chunks = splitDiscordText(params.text, limit, access.chunkMode ?? 'newline')
    const files = params.files ?? []

    if (files.length > 10) throw new Error('Discord allows at most 10 files per message')
    for (const file of files) {
      this.assertSendable(file)
      const stat = statSync(file)
      if (stat.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${file} (${Math.ceil(stat.size / 1024 / 1024)}MB)`)
      }
    }

    const sentIds: string[] = []
    const replyMode = access.replyToMode ?? 'first'

    for (let i = 0; i < chunks.length; i += 1) {
      const shouldReply =
        params.replyTo != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
      const sent = await channel.send({
        content: chunks[i],
        ...(i === 0 && files.length > 0 ? { files } : {}),
        ...(shouldReply
          ? { reply: { messageReference: params.replyTo, failIfNotExists: false } }
          : {}),
      })
      this.noteSent(sent.id)
      sentIds.push(sent.id)
    }

    return sentIds
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.fetchAllowedChannel(chatId)
    const message = await channel.messages.fetch(messageId)
    await message.react(emoji)
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<string> {
    const channel = await this.fetchAllowedChannel(chatId)
    const message = await channel.messages.fetch(messageId)
    const edited = await message.edit(text)
    this.noteSent(edited.id)
    return edited.id
  }

  async fetchMessages(channelId: string, limit = 20): Promise<string> {
    const channel = await this.fetchAllowedChannel(channelId)
    const messages = await channel.messages.fetch({ limit: Math.max(1, Math.min(limit, 100)) })
    const me = this.client.user?.id
    const rows = [...messages.values()].reverse()

    if (rows.length === 0) return '(no messages)'

    return rows
      .map(message => {
        const who = message.author.id === me ? 'me' : message.author.username
        const attachments = message.attachments.size > 0 ? ` +${message.attachments.size}att` : ''
        const text = sanitizeOneLine(message.content)
        return `[${message.createdAt.toISOString()}] ${who}: ${text} (id: ${message.id}${attachments})`
      })
      .join('\n')
  }

  async downloadAttachments(chatId: string, messageId: string): Promise<string[]> {
    const channel = await this.fetchAllowedChannel(chatId)
    const message = await channel.messages.fetch(messageId)
    const paths: string[] = []

    for (const attachment of message.attachments.values()) {
      paths.push(await this.downloadAttachment(attachment))
    }

    return paths
  }

  async sendTyping(chatId: string): Promise<void> {
    const channel = await this.fetchTextChannel(chatId)
    if ('sendTyping' in channel) {
      await channel.sendTyping()
    }
  }

  private async handleInbound(message: Message): Promise<void> {
    const gate = await this.gate(message)
    if (gate.action === 'drop') return

    if (gate.action === 'pair') {
      const lead = gate.isResend ? 'Still pending' : 'Pairing required'
      await message
        .reply(
          `${lead}. Run this on the Codex host:\n\ncodex-discord-mcp access pair ${gate.code}`,
        )
        .catch(err => {
          process.stderr.write(`discord bridge: failed to send pairing code: ${err}\n`)
        })
      return
    }

    if (message.channel.type === ChannelType.DM) {
      this.dmChannelUsers.set(message.channelId, message.author.id)
    }

    if ('sendTyping' in message.channel) {
      void message.channel.sendTyping().catch(() => {})
    }

    if (gate.access.ackReaction) {
      void message.react(gate.access.ackReaction).catch(() => {})
    }

    const queued = this.toQueuedMessage(message)
    appendQueuedMessage(queued, this.paths)
    this.emit('message', queued)
  }

  private async gate(message: Message): Promise<
    | { action: 'deliver'; access: ReturnType<typeof loadAccess> }
    | { action: 'drop' }
    | { action: 'pair'; code: string; isResend: boolean }
  > {
    const access = loadAccess(this.paths)
    if (pruneExpiredPending(access)) saveAccess(access, this.paths)

    if (access.dmPolicy === 'disabled') return { action: 'drop' }

    const senderId = message.author.id
    const isDm = message.channel.type === ChannelType.DM

    if (isDm) {
      if (access.allowUsers.includes(senderId)) return { action: 'deliver', access }
      if (access.dmPolicy === 'allowlist') return { action: 'drop' }

      for (const [code, pending] of Object.entries(access.pending)) {
        if (pending.senderId !== senderId) continue
        if ((pending.replies ?? 1) >= 2) return { action: 'drop' }
        pending.replies = (pending.replies ?? 1) + 1
        saveAccess(access, this.paths)
        return { action: 'pair', code, isResend: true }
      }

      if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

      const code = randomBytes(3).toString('hex')
      const now = Date.now()
      access.pending[code] = {
        senderId,
        chatId: message.channelId,
        username: message.author.username,
        createdAt: now,
        expiresAt: now + 60 * 60 * 1000,
        replies: 1,
      }
      saveAccess(access, this.paths)
      return { action: 'pair', code, isResend: false }
    }

    const channelId = this.policyChannelId(message)
    const policy = access.channels[channelId]
    if (!policy) return { action: 'drop' }
    if (policy.allowUsers.length > 0 && !policy.allowUsers.includes(senderId)) {
      return { action: 'drop' }
    }
    if (policy.requireMention && !(await this.isMentioned(message, access.mentionPatterns))) {
      return { action: 'drop' }
    }

    return { action: 'deliver', access }
  }

  private async isMentioned(message: Message, patterns: string[] | undefined): Promise<boolean> {
    if (this.client.user && message.mentions.has(this.client.user)) return true

    const referencedMessageId = message.reference?.messageId
    if (referencedMessageId) {
      if (this.recentSentIds.has(referencedMessageId)) return true
      try {
        const referenced = await message.fetchReference()
        if (referenced.author.id === this.client.user?.id) return true
      } catch {}
    }

    for (const pattern of patterns ?? []) {
      try {
        if (new RegExp(pattern, 'i').test(message.content)) return true
      } catch {}
    }

    return false
  }

  private policyChannelId(message: Message): string {
    if (message.channel.isThread()) {
      return message.channel.parentId ?? message.channelId
    }
    return message.channelId
  }

  private toQueuedMessage(message: Message): QueuedMessage {
    const attachments = [...message.attachments.values()].map(toAttachmentMeta)
    return {
      id: message.id,
      chatId: message.channelId,
      messageId: message.id,
      userId: message.author.id,
      user: message.author.username,
      content: message.content || (attachments.length > 0 ? '(attachment)' : ''),
      createdAt: message.createdAt.toISOString(),
      receivedAt: new Date().toISOString(),
      source: 'discord',
      attachments,
      status: 'pending',
    }
  }

  private async fetchTextChannel(id: string): Promise<any> {
    const channel = await this.client.channels.fetch(id)
    if (!channel || !channel.isTextBased()) {
      throw new Error(`channel ${id} not found or not text-based`)
    }
    return channel
  }

  private async fetchAllowedChannel(id: string): Promise<any> {
    const channel = await this.fetchTextChannel(id)
    const access = loadAccess(this.paths)

    if (channel.type === ChannelType.DM) {
      const userId = channel.recipientId ?? channel.recipient?.id ?? this.dmChannelUsers.get(id)
      if (userId && access.allowUsers.includes(userId)) return channel
    } else {
      const channelId = channel.isThread() ? channel.parentId ?? channel.id : channel.id
      if (access.channels[channelId]) return channel
    }

    throw new Error(`channel ${id} is not allowlisted`)
  }

  private async downloadAttachment(attachment: Attachment): Promise<string> {
    if (attachment.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large: ${Math.ceil(attachment.size / 1024 / 1024)}MB`)
    }

    const response = await fetch(attachment.url)
    if (!response.ok) {
      throw new Error(`download failed for ${attachment.id}: HTTP ${response.status}`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    const extension = safeExtension(attachment.name ?? attachment.id)
    mkdirSync(this.paths.inboxDir, { recursive: true, mode: 0o700 })
    const path = join(this.paths.inboxDir, `${Date.now()}-${attachment.id}.${extension}`)
    writeFileSync(path, buffer, { mode: 0o600 })
    return path
  }

  private checkApprovals(): void {
    let files: string[]
    try {
      files = readdirSync(this.paths.approvedDir)
    } catch {
      return
    }

    for (const senderId of files) {
      const file = join(this.paths.approvedDir, senderId)
      let chatId = ''
      try {
        chatId = readFileSync(file, 'utf8').trim()
      } catch {
        rmSync(file, { force: true })
        continue
      }

      if (!chatId) {
        rmSync(file, { force: true })
        continue
      }

      this.fetchTextChannel(chatId)
        .then(channel => {
          if ('send' in channel) return channel.send('Paired. Send a message to Codex.')
          return undefined
        })
        .catch(err => {
          process.stderr.write(`discord bridge: failed to confirm pairing: ${err}\n`)
        })
        .finally(() => rmSync(file, { force: true }))
    }
  }

  private assertSendable(file: string): void {
    let realFile = ''
    let realState = ''
    try {
      realFile = realpathSync(file)
      realState = realpathSync(this.paths.stateDir)
    } catch {
      return
    }

    const inbox = join(realState, 'inbox')
    if (realFile.startsWith(realState + sep) && !realFile.startsWith(inbox + sep)) {
      throw new Error(`refusing to send bridge state file: ${file}`)
    }
  }

  private noteSent(messageId: string): void {
    this.recentSentIds.add(messageId)
    if (this.recentSentIds.size <= RECENT_SENT_CAP) return
    const first = this.recentSentIds.values().next().value
    if (first) this.recentSentIds.delete(first)
  }
}

function toAttachmentMeta(attachment: Attachment): AttachmentMeta {
  return {
    id: attachment.id,
    name: safeAttachmentName(attachment),
    contentType: attachment.contentType ?? undefined,
    size: attachment.size,
    url: attachment.url,
  }
}

function safeAttachmentName(attachment: Attachment): string {
  return (attachment.name ?? attachment.id).replace(/[\[\]\r\n;]/g, '_')
}

function safeExtension(name: string): string {
  const raw = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
  return raw.replace(/[^A-Za-z0-9]/g, '') || 'bin'
}
