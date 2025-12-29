import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

// Graceful disconnect
export async function connectDB() {
  try {
    await prisma.$connect()
    console.log('✅ Database connected')
  } catch (error) {
    console.error('❌ Database connection error:', error)
    process.exit(1)
  }

  process.on('SIGINT', async () => {
    await prisma.$disconnect()
    console.log('Database disconnected (SIGINT)')
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await prisma.$disconnect()
    console.log('Database disconnected (SIGTERM)')
    process.exit(0)
  })
}

// 👇 THIS restores default export support
export default prisma;
