"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRecommendations = void 0;
exports.correctSearchQuery = correctSearchQuery;
// src/services/recommendationService.ts
const openai_1 = __importDefault(require("openai"));
const prismaClient_1 = __importDefault(require("../config/prismaClient"));
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new openai_1.default({ apiKey: OPENAI_API_KEY });
// Generate embeddings for a text
const getEmbedding = async (text) => {
    const response = await openai.embeddings.create({
        model: 'text-embedding-3-small', // free/small model
        input: text,
    });
    return response.data[0].embedding;
};
// Calculate cosine similarity between two vectors
const cosineSimilarity = (vecA, vecB) => {
    const dot = vecA.reduce((acc, val, i) => acc + val * vecB[i], 0);
    const magA = Math.sqrt(vecA.reduce((acc, val) => acc + val * val, 0));
    const magB = Math.sqrt(vecB.reduce((acc, val) => acc + val * val, 0));
    return dot / (magA * magB);
};
// Get AI-based personalized recommendations
const getRecommendations = async (userId) => {
    const pastOrders = await prismaClient_1.default.orderItem.findMany({
        where: { order: { customerId: userId } },
        include: { product: true },
    });
    // fallback: return 5 latest products if no past orders
    if (!pastOrders.length) {
        return prismaClient_1.default.product.findMany({ take: 5, orderBy: { createdAt: 'desc' } });
    }
    // Combine all past product names into a single string
    const pastProductNames = pastOrders.map(o => o.product.name).join(' ');
    const userEmbedding = await getEmbedding(pastProductNames);
    // Get all products
    const allProducts = await prismaClient_1.default.product.findMany();
    // Compute similarity scores
    const similarities = [];
    for (const product of allProducts) {
        const emb = await getEmbedding(product.name);
        const score = cosineSimilarity(userEmbedding, emb);
        similarities.push({ productId: product.id, score });
    }
    // Sort descending and return top 5
    similarities.sort((a, b) => b.score - a.score);
    const topProducts = similarities
        .slice(0, 5)
        .map(s => allProducts.find(p => p.id === s.productId));
    return topProducts;
};
exports.getRecommendations = getRecommendations;
function correctSearchQuery(query) {
    throw new Error('Function not implemented.');
}
