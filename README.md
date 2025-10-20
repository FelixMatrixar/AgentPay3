# AgentPay WhatsApp Integration

A robust multi-user WhatsApp integration built with Baileys for serving multiple users simultaneously.

## Features

- 🔄 **Multi-User Support**: Handle multiple WhatsApp accounts simultaneously
- 📱 **QR Code & Pairing Code**: Support for both QR code and pairing code authentication
- 🔌 **RESTful API**: Complete REST API for managing sessions and sending messages
- 📨 **Message Handling**: Comprehensive message processing with webhook support
- 🔄 **Auto-Reconnection**: Automatic reconnection on connection drops
- 📊 **Logging**: Structured logging with user-specific logs
- 🔒 **Session Management**: Persistent session storage and management

## Quick Start

### 1. Installation

```bash
# Install dependencies
npm install

# Copy environment configuration
cp .env.example .env

# Build the project
npm run build
```

### 2. Configuration

Edit `.env` file with your settings:

```env
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
SESSION_DIR=./sessions
AUTO_REPLY=false
ENABLE_PAIRING_CODE=true
WEBHOOK_URL=http://localhost:3000/webhook
```

### 3. Start the Server

```bash
# Development mode
npm run dev

# Production mode
npm start
```

## API Endpoints

### Health Check
```http
GET /api/health
```

### Session Management

#### Create New Session
```http
POST /api/sessions
Content-Type: application/json

{
  "userId": "user123",
  "phoneNumber": "1234567890",
  "usePairingCode": true
}
```

#### Get Session Status
```http
GET /api/sessions/{userId}
```

#### List All Sessions
```http
GET /api/sessions
```

#### Get QR Code
```http
GET /api/sessions/{userId}/qr
```

#### Get Pairing Code
```http
GET /api/sessions/{userId}/pairing-code
```

### Message Operations

#### Send Message
```http
POST /api/sessions/{userId}/messages
Content-Type: application/json

{
  "to": "1234567890@s.whatsapp.net",
  "message": "Hello from AgentPay!"
}
```

### Session Control

#### Disconnect Session
```http
DELETE /api/sessions/{userId}
```

#### Remove Session Completely
```http
DELETE /api/sessions/{userId}/remove
```

## Usage Examples

### 1. Create a New WhatsApp Session

```javascript
const response = await fetch('http://localhost:3000/api/sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: 'user123',
    phoneNumber: '1234567890',
    usePairingCode: true
  })
})

const result = await response.json()
console.log('Pairing Code:', result.session.pairingCode)
```

### 2. Send a Message

```javascript
const response = await fetch('http://localhost:3000/api/sessions/user123/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    to: '1234567890',  // Will be automatically formatted
    message: 'Hello from AgentPay!'
  })
})

const result = await response.json()
console.log('Message sent:', result.success)
```

### 3. Check Session Status

```javascript
const response = await fetch('http://localhost:3000/api/sessions/user123')
const session = await response.json()
console.log('Connected:', session.isConnected)
```

## Phone Number Formats

The API accepts phone numbers in various formats:

- `1234567890` (digits only - automatically formatted)
- `1234567890@s.whatsapp.net` (WhatsApp format)
- `1234567890@c.us` (Legacy format)

## Webhook Integration

Configure `WEBHOOK_URL` in your environment to receive real-time events:

```json
{
  "event": "message",
  "data": {
    "id": "message_id",
    "from": "1234567890@s.whatsapp.net",
    "message": "Hello!",
    "timestamp": "2024-01-15T10:30:00.000Z",
    "messageType": "text",
    "userId": "user123"
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Event Types

- `message` - New incoming message
- `connectionUpdate` - Connection status changes
- `qrCode` - QR code generated
- `pairingCode` - Pairing code generated

## File Structure

```
src/
├── api/
│   └── routes.ts          # API route definitions
├── services/
│   ├── SessionManager.ts  # Session management
│   ├── WhatsAppManager.ts # WhatsApp connection handling
│   └── MessageHandler.ts  # Message processing
├── types/
│   └── index.ts          # TypeScript type definitions
├── utils/
│   └── logger.ts         # Logging utilities
└── index.ts              # Application entry point
```

## Production Deployment

1. Set `NODE_ENV=production`
2. Configure proper logging levels
3. Set up process manager (PM2, Docker, etc.)
4. Configure reverse proxy (nginx)
5. Set up SSL certificates
6. Configure webhook endpoints

## Troubleshooting

### Common Issues

1. **Session not connecting**: Check phone number format and network connectivity
2. **QR code not generating**: Ensure `usePairingCode` is set to `false`
3. **Messages not sending**: Verify the recipient number format and session status
4. **Session keeps disconnecting**: Check WhatsApp Web limitations and rate limits

### Logs

Check the logs directory for detailed information:
- `logs/whatsapp.log` - Application logs
- Console output for real-time debugging

## License

MIT License - see LICENSE file for details.