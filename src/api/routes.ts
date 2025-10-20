import { Router, Request, Response } from 'express'
import { WhatsAppManager } from '../services/WhatsAppManager'
import { SessionManager } from '../services/SessionManager'
import { logger } from '../utils/logger'
import { QRCodeGenerator } from '../utils/qrCodeGenerator'

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
      
      // For new sessions, wait a bit for QR generation
      if (!session.state.creds.registered && !session.qrCode) {
        logger.info(`Waiting for QR generation for new session: ${userId}`)
        
        // Wait up to 5 seconds for QR code generation
        let attempts = 0
        const maxAttempts = 10 // 5 seconds total (500ms * 10)
        
        while (attempts < maxAttempts && !session.qrCode && !session.isConnected) {
          await new Promise(resolve => setTimeout(resolve, 500))
          attempts++
        }
        
        if (session.qrCode) {
          logger.info(`QR code generated for session: ${userId}`)
        } else {
          logger.warn(`QR code not generated within timeout for session: ${userId}`)
        }
      }
      
      res.json({
        success: true,
        session: {
          id: session.id,
          phoneNumber: session.phoneNumber,
          isConnected: session.isConnected,
          qrCode: session.qrCode,
          pairingCode: session.pairingCode
        },
        message: session.qrCode ? 'Session created with QR code' : 'Session created - QR code will be available shortly'
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

  // Trigger QR generation for session
  router.post('/sessions/:userId/generate-qr', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params
      const session = sessionManager.getSession(userId)

      if (!session) {
        return res.status(404).json({ error: 'Session not found' })
      }

      if (session.isConnected) {
        return res.status(400).json({ error: 'Session is already connected' })
      }

      if (session.qrCode) {
        return res.json({ 
          success: true, 
          qrCode: session.qrCode,
          message: 'QR code already available'
        })
      }

      // Wait for QR generation
      logger.info(`Triggering QR generation for session: ${userId}`)
      
      let attempts = 0
      const maxAttempts = 20 // 10 seconds total (500ms * 20)
      
      while (attempts < maxAttempts && !session.qrCode && !session.isConnected) {
        await new Promise(resolve => setTimeout(resolve, 500))
        attempts++
      }

      if (session.qrCode) {
        res.json({ 
          success: true, 
          qrCode: session.qrCode,
          message: 'QR code generated successfully'
        })
      } else {
        res.status(408).json({ 
          error: 'QR code generation timeout',
          message: 'QR code not available after waiting. Try creating a new session.'
        })
      }
    } catch (error) {
      logger.error({ error }, 'Failed to generate QR code')
      res.status(500).json({ error: 'Failed to generate QR code' })
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

  // Get QR code as PNG image
  router.get('/sessions/:userId/qr/image', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params
      const { width, margin } = req.query
      const session = sessionManager.getSession(userId)

      if (!session) {
        return res.status(404).json({ error: 'Session not found' })
      }

      if (!session.qrCode) {
        return res.status(404).json({ error: 'QR code not available' })
      }

      const options = {
        width: width ? parseInt(width as string) : 256,
        margin: margin ? parseInt(margin as string) : 2
      }

      const imageBuffer = await QRCodeGenerator.generatePNG(session.qrCode, options)
      
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Content-Disposition', `inline; filename="qr-${userId}.png"`)
      res.send(imageBuffer)
    } catch (error) {
      logger.error({ error }, 'Failed to generate QR code image')
      res.status(500).json({ error: 'Failed to generate QR code image' })
    }
  })

  // Get QR code as SVG
  router.get('/sessions/:userId/qr/svg', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params
      const { width, margin } = req.query
      const session = sessionManager.getSession(userId)

      if (!session) {
        return res.status(404).json({ error: 'Session not found' })
      }

      if (!session.qrCode) {
        return res.status(404).json({ error: 'QR code not available' })
      }

      const options = {
        width: width ? parseInt(width as string) : 256,
        margin: margin ? parseInt(margin as string) : 2
      }

      const svgString = await QRCodeGenerator.generateSVG(session.qrCode, options)
      
      res.setHeader('Content-Type', 'image/svg+xml')
      res.setHeader('Content-Disposition', `inline; filename="qr-${userId}.svg"`)
      res.send(svgString)
    } catch (error) {
      logger.error({ error }, 'Failed to generate QR code SVG')
      res.status(500).json({ error: 'Failed to generate QR code SVG' })
    }
  })

  // Get QR code as Data URL (base64)
  router.get('/sessions/:userId/qr/dataurl', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params
      const { width, margin } = req.query
      const session = sessionManager.getSession(userId)

      if (!session) {
        return res.status(404).json({ error: 'Session not found' })
      }

      if (!session.qrCode) {
        return res.status(404).json({ error: 'QR code not available' })
      }

      const options = {
        width: width ? parseInt(width as string) : 256,
        margin: margin ? parseInt(margin as string) : 2
      }

      const dataURL = await QRCodeGenerator.generateDataURL(session.qrCode, options)
      
      res.json({ dataURL })
    } catch (error) {
      logger.error({ error }, 'Failed to generate QR code Data URL')
      res.status(500).json({ error: 'Failed to generate QR code Data URL' })
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