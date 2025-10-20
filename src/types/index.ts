import { WASocket, ConnectionState, AuthenticationState } from '@whiskeysockets/baileys'

export interface UserSession {
  id: string
  phoneNumber: string
  socket: WASocket | null
  state: AuthenticationState
  isConnected: boolean
  lastActivity: Date
  qrCode?: string
  qrCodeBase64?: string
  pairingCode?: string
}

export interface WhatsAppMessage {
  id: string
  from: string
  to: string
  message: string
  timestamp: Date
  messageType: 'text' | 'image' | 'video' | 'audio' | 'document'
  userId: string
}

export interface ConnectionManager {
  sessions: Map<string, UserSession>
  createSession(userId: string, phoneNumber?: string): Promise<UserSession>
  removeSession(userId: string): Promise<boolean>
  getSession(userId: string): UserSession | undefined
  sendMessage(userId: string, to: string, message: string): Promise<boolean>
}

export interface MessageHandler {
  onMessage: (message: WhatsAppMessage) => Promise<void>
  onConnectionUpdate: (userId: string, state: ConnectionState) => Promise<void>
  onQRCode: (userId: string, qr: string) => Promise<void>
  onPairingCode: (userId: string, code: string) => Promise<void>
}