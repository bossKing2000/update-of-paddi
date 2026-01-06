"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
exports.connectDB = connectDB;
const client_1 = require("@prisma/client");
const globalForPrisma = globalThis;
exports.prisma = globalForPrisma.prisma ??
    new client_1.PrismaClient({
        log: ['warn', 'error'],
    });
if (process.env.NODE_ENV !== 'production')
    globalForPrisma.prisma = exports.prisma;
// Graceful disconnect
async function connectDB() {
    try {
        await exports.prisma.$connect();
        console.log('✅ Database connected');
    }
    catch (error) {
        console.error('❌ Database connection error:', error);
        process.exit(1);
    }
    process.on('SIGINT', async () => {
        await exports.prisma.$disconnect();
        console.log('Database disconnected (SIGINT)');
        process.exit(0);
    });
    process.on('SIGTERM', async () => {
        await exports.prisma.$disconnect();
        console.log('Database disconnected (SIGTERM)');
        process.exit(0);
    });
}
// 👇 THIS restores default export support
exports.default = exports.prisma;
