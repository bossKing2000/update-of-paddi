import { PrismaClient, OrderStatus, PaymentStatus } from '@prisma/client';
const prisma = new PrismaClient();

async function testRevenue() {
  try {
    const startOfYear = new Date(2026, 0, 1);
    const endOfYear = new Date(2027, 0, 1);
    
    console.log('Testing revenue groupBy...');
    const revenue = await prisma.order.groupBy({
      by: ['createdAt'],
      where: { status: OrderStatus.COMPLETED, paymentStatus: PaymentStatus.SUCCESS, createdAt: { gte: startOfYear, lt: endOfYear } },
      _sum: { totalPrice: true },
    });
    console.log('Revenue result count:', revenue.length);
  } catch (e: any) {
    console.error('Revenue error:', e.message);
  }
}

async function testRaw() {
  try {
    const startOfYear = new Date(2026, 0, 1);
    const endOfYear = new Date(2027, 0, 1);
    
    console.log('Testing raw query...');
    const raw = await prisma.$queryRaw<Array<{ dish_type_id: string; count: bigint; revenue: bigint }>>`
      SELECT p."dishTypeId" as dish_type_id, COUNT(DISTINCT o.id) as "count", COALESCE(SUM(o."totalPrice"), 0) as revenue
      FROM "Order" o
      JOIN "OrderItem" oi ON oi."orderId" = o.id
      JOIN "Product" p ON p.id = oi."productId"
      WHERE o."createdAt" >= ${startOfYear} AND o."createdAt" < ${endOfYear}
        AND o.status = ${OrderStatus.COMPLETED}
        AND o."paymentStatus" = ${PaymentStatus.SUCCESS}
      GROUP BY p."dishTypeId"
    `;
    console.log('Raw query result:', raw);
  } catch (e: any) {
    console.error('Raw query error:', e.message);
  }
}

testRevenue().then(() => testRaw()).catch(console.error).finally(() => prisma.$disconnect());