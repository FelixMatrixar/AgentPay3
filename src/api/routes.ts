import { Router, Request, Response } from 'express'
import { WhatsAppManager } from '../services/WhatsAppManager'
import { SessionManager } from '../services/SessionManager'
import { logger } from '../utils/logger'

export function createRoutes(whatsappManager: WhatsAppManager, sessionManager: SessionManager): Router {
  const router = Router()

  // Health check
  router.get('/health', (req: Request, res: Response) => {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      activeConnections: whatsappManager.getActiveConnections().length
    })
  })

  // Create new WhatsApp session
  router.post('/sessions', async (req: Request, res: Response) => {
    try {
      const { userId, phoneNumber, usePairingCode = true } = req.body

      if (!userId) {
        return res.status(400).json({ error: 'userId is required' })
      }

      // Check if session already exists
      const existingSession = sessionManager.getSession(userId)
      if (existingSession?.isConnected) {
        return res.status(409).json({ error: 'Session already exists and is connected' })
      }

      const session = await whatsappManager.createConnection(userId, phoneNumber, usePairingCode)
      
      res.json({
        success: true,
        session: {
          id: session.id,
          phoneNumber: session.phoneNumber,
          isConnected: session.isConnected,
          qrCode: session.qrCode,
          pairingCode: session.pairingCode
        }
      })
    } catch (error) {
      logger.error({ error }, 'Failed to create session')
      res.status(500).json({ error: 'Failed to create session' })
    }
  })

  // Get session status
  router.get('/sessions/:userId', (req: Request, res: Response) => {
    try {
      const { userId } = req.params
      const session = sessionManager.getSession(userId)

      if (!session) {
        return res.status(404).json({ error: 'Session not found' })
      }

      res.json({
        id: session.id,
        phoneNumber: session.phoneNumber,
        isConnected: session.isConnected,
        lastActivity: session.lastActivity,
        qrCode: session.qrCode,
        pairingCode: session.pairingCode
      })
    } catch (error) {
      logger.error({ error }, 'Failed to get session')
      res.status(500).json({ error: 'Failed to get session' })
    }
  })

  // List all sessions
  router.get('/sessions', (req: Request, res: Response) => {
    try {
      const sessions = sessionManager.getAllSessions().map(session => ({
        id: session.id,
        phoneNumber: session.phoneNumber,
        isConnected: session.isConnected,
        lastActivity: session.lastActivity
      }))

      res.json({ sessions })
    } catch (error) {
      logger.error({ error }, 'Failed to list sessions')
      res.status(500).json({ error: 'Failed to list sessions' })
    }
  })

  // Send message
  router.post('/sessions/:userId/messages', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params
      const { to, message } = req.body

      if (!to || !message) {
        return res.status(400).json({ error: 'to and message are required' })
      }

      // Validate phone number format (basic validation)
      const phoneRegex = /^\d{10,15}@s\.whatsapp\.net$|^\d{10,15}@c\.us$/
      if (!phoneRegex.test(to)) {
        // Try to format the number if it's just digits
        const digitsOnly = to.replace(/\D/g, '')
        if (digitsOnly.length >= 10 && digitsOnly.length <= 15) {
          const formattedTo = `${digitsOnly}@s.whatsapp.net`
          const success = await whatsappManager.sendMessage(userId, formattedTo, message)
          return res.json({ success, to: formattedTo })
        } else {
          return res.status(400).json({ error: 'Invalid phone number format' })
        }
      }

      const success = await whatsappManager.sendMessage(userId, to, message)
      
      if (success) {
        res.json({ success: true, to, message })
      } else {
        res.status(500).json({ error: 'Failed to send message' })
      }
    } catch (error) {
      logger.error({ error }, 'Failed to send message')
      res.status(500).json({ error: 'Failed to send message' })
    }
  })

  // Disconnect session
  router.delete('/sessions/:userId', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params
      
      const success = await whatsappManager.disconnectUser(userId)
      
      if (success) {
        res.json({ success: true })
      } else {
        res.status(500).json({ error: 'Failed to disconnect session' })
      }
    } catch (error) {
      logger.error({ error }, 'Failed to disconnect session')
      res.status(500).json({ error: 'Failed to disconnect session' })
    }
  })

  // Remove session completely
  router.delete('/sessions/:userId/remove', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params
      
      // First disconnect
      await whatsappManager.disconnectUser(userId)
      
      // Then remove session data
      const success = await sessionManager.removeSession(userId)
      
      if (success) {
        res.json({ success: true })
      } else {
        res.status(500).json({ error: 'Failed to remove session' })
      }
    } catch (error) {
      logger.error({ error }, 'Failed to remove session')
      res.status(500).json({ error: 'Failed to remove session' })
    }
  })

  // Get QR code for session
  router.get('/sessions/:userId/qr', (req: Request, res: Response) => {
    try {
      const { userId } = req.params
      const session = sessionManager.getSession(userId)

      if (!session) {
        return res.status(404).json({ error: 'Session not found' })
      }

      if (!session.qrCode) {
        return res.status(404).json({ error: 'QR code not available' })
      }

      res.json({ qrCode: session.qrCode })
    } catch (error) {
      logger.error({ error }, 'Failed to get QR code')
      res.status(500).json({ error: 'Failed to get QR code' })
    }
  })

  // Get pairing code for session
  router.get('/sessions/:userId/pairing-code', (req: Request, res: Response) => {
    try {
      const { userId } = req.params
      const session = sessionManager.getSession(userId)

      if (!session) {
        return res.status(404).json({ error: 'Session not found' })
      }

      if (!session.pairingCode) {
        return res.status(404).json({ error: 'Pairing code not available' })
      }

      res.json({ pairingCode: session.pairingCode })
    } catch (error) {
      logger.error({ error }, 'Failed to get pairing code')
      res.status(500).json({ error: 'Failed to get pairing code' })
    }
  })

  return router
}