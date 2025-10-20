import pino from 'pino'
import path from 'path'

const logLevel = process.env.LOG_LEVEL || 'info'

export const logger = pino({
  level: logLevel,
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        options: { 
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname'
        },
        level: logLevel,
      },
      {
        target: 'pino/file',
        options: { 
          destination: path.join(process.cwd(), 'logs', 'whatsapp.log'),
          mkdir: true
        },
        level: logLevel,
      },
    ],
  },
})

export const createUserLogger = (userId: string) => {
  return logger.child({ userId })
}