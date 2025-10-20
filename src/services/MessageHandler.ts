import { WhatsAppMessage, MessageHandler } from '../types'
import { logger } from '../utils/logger'
import { EventEmitter } from 'events'

export class DefaultMessageHandler extends EventEmitter implements MessageHandler {
  private autoReply: boolean
  private webhookUrl?: string

  constructor(autoReply: boolean = false, webhookUrl?: string) {
    super()
    this.autoReply = autoReply
    this.webhookUrl = webhookUrl
  }

  async onMessage(message: WhatsAppMessage): Promise<void> {
    try {
      logger.info(`Received message from ${message.from}: ${message.message}`)
      
      // Emit event for external listeners
      this.emit('message', message)
      
      // Send to webhook if configured
      if (this.webhookUrl) {
        await this.sendToWebhook('message', message)
      }

      // Auto-reply if enabled
      if (this.autoReply && message.messageType === 'text') {
        this.emit('autoReply', {
          userId: message.userId,
          to: message.from,
          originalMessage: message.message
        })
      }
    } catch (error) {
      logger.error({ error }, 'Error handling message')
    }
  }

  async onConnectionUpdate(userId: string, state: any): Promise<void> {
    try {
      logger.info(`Connection update for user ${userId}:`, state)
      
      // Emit event for external listeners
      this.emit('connectionUpdate', { userId, state })
      
      // Send to webhook if configured
      if (this.webhookUrl) {
        await this.sendToWebhook('connectionUpdate', { userId, state })
      }
    } catch (error) {
      logger.error({ error }, 'Error handling connection update')
    }
  }

  async onQRCode(userId: string, qr: string): Promise<void> {
    try {
      logger.info(`QR Code generated for user ${userId}`)
      
      // Emit event for external listeners
      this.emit('qrCode', { userId, qr })
      
      // Send to webhook if configured
      if (this.webhookUrl) {
        await this.sendToWebhook('qrCode', { userId, qr })
      }
    } catch (error) {
      logger.error({ error }, 'Error handling QR code')
    }
  }

  async onPairingCode(userId: string, code: string): Promise<void> {
    try {
      logger.info(`Pairing code generated for user ${userId}: ${code}`)
      
      // Emit event for external listeners
      this.emit('pairingCode', { userId, code })
      
      // Send to webhook if configured
      if (this.webhookUrl) {
        await this.sendToWebhook('pairingCode', { userId, code })
      }
    } catch (error) {
      logger.error({ error }, 'Error handling pairing code')
    }
  }

  private async sendToWebhook(event: string, data: any): Promise<void> {
    if (!this.webhookUrl) return

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event,
          data,
          timestamp: new Date().toISOString()
        })
      })

      if (!response.ok) {
        logger.error(`Webhook failed with status ${response.status}`)
      }
    } catch (error) {
      logger.error({ error }, 'Failed to send webhook')
    }
  }

  setAutoReply(enabled: boolean): void {
    this.autoReply = enabled
  }

  setWebhookUrl(url: string): void {
    this.webhookUrl = url
  }
}