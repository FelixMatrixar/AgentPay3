import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  WASocket,
  proto,
  isJidBroadcast,
  delay,
  AnyMessageContent
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import { SessionManager } from './SessionManager'
import { UserSession, WhatsAppMessage, MessageHandler } from '../types'
import { logger, createUserLogger } from '../utils/logger'

export class WhatsAppManager {
  private sessionManager: SessionManager
  private msgRetryCounterCache: NodeCache
  private messageHandler?: MessageHandler
  private activeSockets: Map<string, WASocket> = new Map()
  private reconnectAttempts: Map<string, number> = new Map()
  private maxReconnectAttempts: number = 5

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager
    this.msgRetryCounterCache = new NodeCache()
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  async createConnection(userId: string, phoneNumber?: string, usePairingCode: boolean = true): Promise<UserSession> {
    const userLogger = createUserLogger(userId)
    
    try {
      // Create or get session
      let session = this.sessionManager.getSession(userId)
      if (!session) {
        session = await this.sessionManager.createSession(userId, phoneNumber)
      } else if (phoneNumber && session.phoneNumber !== phoneNumber) {
        // Update phoneNumber if provided and different
        session.phoneNumber = phoneNumber
      }

      // Fetch latest Baileys version
      const { version, isLatest } = await fetchLatestBaileysVersion()
      userLogger.info(`Using WA v${version.join('.')}, isLatest: ${isLatest}`)

      // Create socket
      const socket = makeWASocket({
        version,
        logger: userLogger,
        auth: {
          creds: session.state.creds,
          keys: makeCacheableSignalKeyStore(session.state.keys, userLogger),
        },
        msgRetryCounterCache: this.msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        shouldIgnoreJid: jid => isJidBroadcast(jid),
        getMessage: async (key) => {
          // Implement message retrieval logic if needed
          return undefined
        }
      })

      // Store socket reference
      session.socket = socket
      this.activeSockets.set(userId, socket)

      // Set up event handlers first
      this.setupEventHandlers(socket, session, userLogger, phoneNumber, usePairingCode)

      return session
    } catch (error) {
      userLogger.error({ error }, 'Failed to create WhatsApp connection')
      throw error
    }
  }

  private setupEventHandlers(socket: WASocket, session: UserSession, userLogger: any, phoneNumber?: string, usePairingCode: boolean = true): void {
    socket.ev.process(async (events) => {
      // Connection updates
      if (events['connection.update']) {
        const update = events['connection.update']
        const { connection, lastDisconnect, qr } = update
        
        userLogger.info({ connection, lastDisconnect: lastDisconnect?.error?.message }, 'Connection update')

        // Handle QR code generation
        if (qr) {
          session.qrCode = qr
          try {
            // Generate QR code for terminal display
            qrcode.generate(qr, { small: true })
            // Generate base64 QR code for API
            const qrBase64 = await QRCode.toDataURL(qr)
            session.qrCodeBase64 = qrBase64
            userLogger.info('QR Code generated for user')
            
            if (this.messageHandler?.onQRCode) {
              await this.messageHandler.onQRCode(session.id, qr)
            }
          } catch (error) {
            userLogger.error({ error }, 'Failed to generate QR code')
          }
        }

        // Handle pairing code - wait for connecting state as per documentation
        if (connection === 'connecting' && usePairingCode && !qr && !socket.authState.creds.registered && phoneNumber) {
          try {
            const code = await socket.requestPairingCode(phoneNumber)
            session.pairingCode = code
            userLogger.info(`Pairing code generated: ${code}`)
            
            if (this.messageHandler?.onPairingCode) {
              await this.messageHandler.onPairingCode(session.id, code)
            }
          } catch (error) {
            userLogger.error({ error }, 'Failed to generate pairing code')
          }
        }

        // Handle connection close
        if (connection === 'close') {
          session.isConnected = false
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
          
          // Handle restart required scenario as per documentation
          if (statusCode === DisconnectReason.restartRequired) {
            userLogger.info('Restart required - creating new socket')
            this.activeSockets.delete(session.id)
            // Create new socket immediately for restart required
            setTimeout(() => this.createConnection(session.id, session.phoneNumber, usePairingCode), 1000)
            return
          }
          
          // Handle other disconnection reasons
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut
          
          if (shouldReconnect) {
            const attempts = this.reconnectAttempts.get(session.id) || 0
            if (attempts < this.maxReconnectAttempts) {
              this.reconnectAttempts.set(session.id, attempts + 1)
              const delay = Math.min(1000 * Math.pow(2, attempts), 30000) // Exponential backoff, max 30s
              userLogger.info(`Connection closed, attempting reconnect ${attempts + 1}/${this.maxReconnectAttempts} in ${delay}ms`)
              setTimeout(() => this.createConnection(session.id, session.phoneNumber, usePairingCode), delay)
            } else {
              userLogger.error('Max reconnection attempts reached')
              this.activeSockets.delete(session.id)
              this.reconnectAttempts.delete(session.id)
            }
          } else {
            userLogger.info('Connection closed - logged out')
            this.activeSockets.delete(session.id)
            this.reconnectAttempts.delete(session.id)
          }
        } else if (connection === 'open') {
          session.isConnected = true
          this.reconnectAttempts.delete(session.id) // Reset reconnect attempts on successful connection
          userLogger.info('WhatsApp connection opened successfully')
        }

        if (this.messageHandler?.onConnectionUpdate) {
          await this.messageHandler.onConnectionUpdate(session.id, update as any)
        }
      }

      // Credentials update
      if (events['creds.update']) {
        // Save credentials automatically handled by useMultiFileAuthState
        userLogger.debug('Credentials updated')
      }

      // New messages
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert']
        
        if (upsert.type === 'notify') {
          for (const msg of upsert.messages) {
            if (!msg.key.fromMe && msg.message) {
              const whatsappMessage = this.parseMessage(msg, session.id)
              if (whatsappMessage && this.messageHandler?.onMessage) {
                await this.messageHandler.onMessage(whatsappMessage)
              }
            }
          }
        }
      }

      // Message updates (delivery, read receipts, etc.)
      if (events['messages.update']) {
        userLogger.debug('Messages updated:', events['messages.update'])
      }

      // Message receipts
      if (events['message-receipt.update']) {
        userLogger.debug('Message receipt update:', events['message-receipt.update'])
      }

      // Presence updates
      if (events['presence.update']) {
        userLogger.debug('Presence update:', events['presence.update'])
      }

      // Chat updates
      if (events['chats.update']) {
        userLogger.debug('Chats updated:', events['chats.update'])
      }
    })
  }

  private parseMessage(msg: any, userId: string): WhatsAppMessage | null {
    try {
      const messageContent = msg.message?.conversation || 
                           msg.message?.extendedTextMessage?.text ||
                           msg.message?.imageMessage?.caption ||
                           msg.message?.videoMessage?.caption ||
                           ''

      if (!messageContent && !msg.message?.imageMessage && !msg.message?.videoMessage && !msg.message?.audioMessage) {
        return null
      }

      return {
        id: msg.key.id || '',
        from: msg.key.remoteJid || '',
        to: userId,
        message: messageContent,
        timestamp: new Date(msg.messageTimestamp * 1000),
        messageType: this.getMessageType(msg.message),
        userId
      }
    } catch (error) {
      logger.error({ error }, 'Failed to parse message')
      return null
    }
  }

  private getMessageType(message: any): 'text' | 'image' | 'video' | 'audio' | 'document' {
    if (message.imageMessage) return 'image'
    if (message.videoMessage) return 'video'
    if (message.audioMessage) return 'audio'
    if (message.documentMessage) return 'document'
    return 'text'
  }

  async sendMessage(userId: string, to: string, content: string): Promise<boolean> {
    const userLogger = createUserLogger(userId)
    
    try {
      const socket = this.activeSockets.get(userId)
      if (!socket) {
        userLogger.error('No active socket found for user')
        return false
      }

      const session = this.sessionManager.getSession(userId)
      if (!session?.isConnected) {
        userLogger.error('User session is not connected')
        return false
      }

      // Send typing indicator
      await socket.presenceSubscribe(to)
      await delay(500)
      await socket.sendPresenceUpdate('composing', to)
      await delay(1000)
      await socket.sendPresenceUpdate('paused', to)

      // Send message
      const messageContent: AnyMessageContent = { text: content }
      await socket.sendMessage(to, messageContent)
      
      this.sessionManager.updateSessionActivity(userId)
      userLogger.info(`Message sent to ${to}`)
      
      return true
    } catch (error) {
      userLogger.error({ error }, 'Failed to send message')
      return false
    }
  }

  async disconnectUser(userId: string): Promise<boolean> {
    try {
      const socket = this.activeSockets.get(userId)
      if (socket) {
        socket.end(undefined)
        this.activeSockets.delete(userId)
      }

      const session = this.sessionManager.getSession(userId)
      if (session) {
        session.isConnected = false
        session.socket = null
      }

      logger.info(`Disconnected user: ${userId}`)
      return true
    } catch (error) {
      logger.error({ error, userId }, `Failed to disconnect user ${userId}`)
      return false
    }
  }

  getActiveConnections(): string[] {
    return Array.from(this.activeSockets.keys())
  }

  isUserConnected(userId: string): boolean {
    const session = this.sessionManager.getSession(userId)
    return session?.isConnected || false
  }
}