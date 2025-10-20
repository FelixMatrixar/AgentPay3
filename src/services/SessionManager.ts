import { useMultiFileAuthState } from '@whiskeysockets/baileys'
import { UserSession } from '../types'
import { logger } from '../utils/logger'
import path from 'path'
import fs from 'fs/promises'
import { v4 as uuidv4 } from 'uuid'

export class SessionManager {
  private sessionsDir: string
  private sessions: Map<string, UserSession> = new Map()

  constructor(sessionsDir: string = './sessions') {
    this.sessionsDir = sessionsDir
    this.ensureSessionsDir()
  }

  private async ensureSessionsDir(): Promise<void> {
    try {
      await fs.access(this.sessionsDir)
    } catch {
      await fs.mkdir(this.sessionsDir, { recursive: true })
      logger.info(`Created sessions directory: ${this.sessionsDir}`)
    }
  }

  async createSession(userId: string, phoneNumber?: string): Promise<UserSession> {
    const sessionPath = path.join(this.sessionsDir, userId)
    
    try {
      // Create session directory if it doesn't exist
      await fs.mkdir(sessionPath, { recursive: true })
      
      // Initialize auth state
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
      
      const session: UserSession = {
        id: userId,
        phoneNumber: phoneNumber || '',
        socket: null,
        state,
        isConnected: false,
        lastActivity: new Date()
      }

      this.sessions.set(userId, session)
      logger.info(`Created session for user: ${userId}`)
      
      return session
    } catch (error) {
      logger.error({ error, userId }, `Failed to create session for user ${userId}`)
      throw error
    }
  }

  async removeSession(userId: string): Promise<boolean> {
    try {
      const session = this.sessions.get(userId)
      if (session?.socket) {
        session.socket.end(undefined)
      }
      
      this.sessions.delete(userId)
      
      // Optionally remove session files
      const sessionPath = path.join(this.sessionsDir, userId)
      await fs.rm(sessionPath, { recursive: true, force: true })
      
      logger.info(`Removed session for user: ${userId}`)
      return true
    } catch (error) {
      logger.error({ error, userId }, `Failed to remove session for user ${userId}`)
      return false
    }
  }

  getSession(userId: string): UserSession | undefined {
    return this.sessions.get(userId)
  }

  getAllSessions(): UserSession[] {
    return Array.from(this.sessions.values())
  }

  updateSessionActivity(userId: string): void {
    const session = this.sessions.get(userId)
    if (session) {
      session.lastActivity = new Date()
    }
  }

  async loadExistingSessions(): Promise<void> {
    try {
      const sessionDirs = await fs.readdir(this.sessionsDir, { withFileTypes: true })
      
      for (const dir of sessionDirs) {
        if (dir.isDirectory()) {
          const userId = dir.name
          try {
            await this.createSession(userId)
            logger.info(`Loaded existing session for user: ${userId}`)
          } catch (error) {
            logger.error({ error, userId }, `Failed to load session for user ${userId}`)
          }
        }
      }
    } catch (error) {
      logger.error({ error }, 'Failed to load existing sessions')
    }
  }
}