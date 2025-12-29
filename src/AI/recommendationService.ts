// src/services/recommendationService.ts
import OpenAI from 'openai';
import prisma from '../config/prismaClient';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Generate embeddings for a text
const getEmbedding = async (text: string): Promise<number[]> => {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small', // free/small model
    input: text,
  });
  return response.data[0].embedding;
};

// Calculate cosine similarity between two vectors
const cosineSimilarity = (vecA: number[], vecB: number[]) => {
  const dot = vecA.reduce((acc, val, i) => acc + val * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((acc, val) => acc + val * val, 0));
  const magB = Math.sqrt(vecB.reduce((acc, val) => acc + val * val, 0));
  return dot / (magA * magB);
};

// Get AI-based personalized recommendations
export const getRecommendations = async (userId: string) => {
  const pastOrders = await prisma.orderItem.findMany({
    where: { order: { customerId: userId } },
    include: { product: true },
  });

  // fallback: return 5 latest products if no past orders
  if (!pastOrders.length) {
    return prisma.product.findMany({ take: 5, orderBy: { createdAt: 'desc' } });
  }

  // Combine all past product names into a single string
  const pastProductNames = pastOrders.map(o => o.product.name).join(' ');
  const userEmbedding = await getEmbedding(pastProductNames);

  // Get all products
  const allProducts = await prisma.product.findMany();

  // Compute similarity scores
  const similarities: { productId: string; score: number }[] = [];
  for (const product of allProducts) {
    const emb = await getEmbedding(product.name);
    const score = cosineSimilarity(userEmbedding, emb);
    similarities.push({ productId: product.id, score });
  }

  // Sort descending and return top 5
  similarities.sort((a, b) => b.score - a.score);
  const topProducts = similarities
    .slice(0, 5)
    .map(s => allProducts.find(p => p.id === s.productId)!);

  return topProducts;
};
export function correctSearchQuery(query: string) {
    throw new Error('Function not implemented.');
}

