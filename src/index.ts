import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { SessionManager } from './services/SessionManager'
import { WhatsAppManager } from './services/WhatsAppManager'
import { DefaultMessageHandler } from './services/MessageHandler'
import { createRoutes } from './api/routes'
import { logger } from './utils/logger'

// Load environment variables
dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Request logging middleware
app.use((req, res, next) => {
  logger.info({ 
    ip: req.ip, 
    userAgent: req.get('User-Agent') 
  }, `${req.method} ${req.path}`)
  next()
})

async function startServer() {
  try {
    // Initialize services
    const sessionManager = new SessionManager(process.env.SESSION_DIR || './sessions')
    const whatsappManager = new WhatsAppManager(sessionManager)
    
    // Initialize message handler
    const messageHandler = new DefaultMessageHandler(
      process.env.AUTO_REPLY === 'true',
      process.env.WEBHOOK_URL
    )
    
    whatsappManager.setMessageHandler(messageHandler)

    // Set up message handler events
    messageHandler.on('message', (message) => {
      logger.info(`New message: ${message.from} -> ${message.message}`)
    })

    messageHandler.on('autoReply', async (data) => {
      const { userId, to, originalMessage } = data
      const replyMessage = `Hello! I received your message: "${originalMessage}". This is an automated response.`
      await whatsappManager.sendMessage(userId, to, replyMessage)
    })

    messageHandler.on('connectionUpdate', (data) => {
      logger.info(`Connection update for ${data.userId}:`, data.state)
    })

    messageHandler.on('qrCode', (data) => {
      logger.info(`QR Code available for user ${data.userId}`)
    })

    messageHandler.on('pairingCode', (data) => {
      logger.info(`Pairing code for user ${data.userId}: ${data.code}`)
    })

    // Load existing sessions
    await sessionManager.loadExistingSessions()

    // Set up routes
    const apiRoutes = createRoutes(whatsappManager, sessionManager)
    app.use('/api', apiRoutes)

    // Root endpoint
    app.get('/', (req, res) => {
      res.json({
        name: 'AgentPay WhatsApp Integration',
        version: '1.0.0',
        status: 'running',
        endpoints: {
          health: '/api/health',
          sessions: '/api/sessions',
          createSession: 'POST /api/sessions',
          sendMessage: 'POST /api/sessions/:userId/messages',
          getQR: '/api/sessions/:userId/qr',
          getPairingCode: '/api/sessions/:userId/pairing-code'
        }
      })
    })

    // Error handling middleware
    app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.error({ error }, 'Unhandled error')
      res.status(500).json({ error: 'Internal server error' })
    })

    // 404 handler
    app.use((req, res) => {
      res.status(404).json({ error: 'Endpoint not found' })
    })

    // Start server
    app.listen(PORT, () => {
      logger.info(`🚀 AgentPay WhatsApp Integration server running on port ${PORT}`)
      logger.info(`📱 API Documentation available at http://localhost:${PORT}`)
      logger.info(`🔗 Health check: http://localhost:${PORT}/api/health`)
    })

    // Graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Shutting down gracefully...')
      
      // Disconnect all active sessions
      const activeSessions = whatsappManager.getActiveConnections()
      for (const userId of activeSessions) {
        await whatsappManager.disconnectUser(userId)
      }
      
      process.exit(0)
    })

  } catch (error) {
    logger.error({ error }, 'Failed to start server')
    process.exit(1)
  }
}

// Start the server
startServer().catch((error) => {
  logger.error('Fatal error during startup:', error)
  process.exit(1)
})