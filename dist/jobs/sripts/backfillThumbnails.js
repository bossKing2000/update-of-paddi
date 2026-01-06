"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductImageService = void 0;
const prismaClient_1 = __importDefault(require("../../config/prismaClient")); // Use your shared prisma client
class ProductImageService {
    /**
     * Efficiently ensures thumbnail for multiple products
     */
    static async batchEnsureThumbnails(productIds) {
        if (productIds.length === 0)
            return;
        try {
            const products = await prismaClient_1.default.product.findMany({
                where: { id: { in: productIds } },
                select: { id: true, thumbnail: true, images: true }
            });
            const updates = products
                .filter(p => !p.thumbnail && p.images.length > 0)
                .map(p => prismaClient_1.default.product.update({
                where: { id: p.id },
                data: { thumbnail: p.images[0] }
            }));
            if (updates.length > 0) {
                await Promise.all(updates);
                console.log(`✅ Batch updated thumbnails for ${updates.length} products`);
            }
        }
        catch (error) {
            console.error('❌ Batch thumbnail update failed:', error);
            throw error;
        }
    }
    /**
     * Single product thumbnail ensure (use for real-time updates)
     */
    static async ensureThumbnail(productId) {
        try {
            // Optimized: Try to update directly without reading first
            const product = await prismaClient_1.default.product.findUnique({
                where: { id: productId },
                select: { images: true, thumbnail: true }
            });
            if (!product) {
                console.warn(`Product ${productId} not found`);
                return;
            }
            // Update if needed
            if (!product.thumbnail && product.images.length > 0) {
                await prismaClient_1.default.product.update({
                    where: { id: productId },
                    data: { thumbnail: product.images[0] }
                });
                console.log(`✅ Ensured thumbnail for product ${productId}`);
            }
        }
        catch (error) {
            console.error(`❌ Failed to ensure thumbnail for ${productId}:`, error);
            // Don't throw - this is a background operation
        }
    }
    /**
     * Server startup health check
     */
    static async healthCheck() {
        const total = await prismaClient_1.default.product.count();
        const healthy = await prismaClient_1.default.product.count({
            where: {
                OR: [
                    { thumbnail: { not: null } },
                    { images: { isEmpty: true } } // Products without images are "healthy"
                ]
            }
        });
        return {
            total,
            healthy,
            missing: total - healthy,
            percentage: Math.round((healthy / total) * 100)
        };
    }
}
exports.ProductImageService = ProductImageService;
