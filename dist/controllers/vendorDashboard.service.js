"use strict";
// import { PrismaClient, OrderStatus } from "@prisma/client";
// import { 
//   startOfDay, 
//   endOfDay, 
//   subDays, 
//   format,
//   addDays
// } from "date-fns";
// import { clearProductCache } from "../services/clearCaches";
// import { redisProducts } from "../lib/redis";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VendorDashboardService = void 0;
// const prisma = new PrismaClient();
// export class VendorDashboardService {
//   constructor(private vendorId: string) {}
// async getDashboardSummary() {
//   const cacheKey = `vendor:${this.vendorId}:dashboardSummary`;
//   // STEP 0: Try fetching from cache
//   const cached = await redisProducts.get(cacheKey);
//   if (cached) {
//     return JSON.parse(cached);
//   }
//   // STEP 1: Fetch all data if not cached
//   const [
//     totalRevenue,
//     revenueToday,
//     revenueThisWeek,
//     revenueLastWeek,
//     totalOrders,
//     ordersToday,
//     ordersThisWeek,
//     ordersLastWeek,
//     pendingOrders,
//     averageRating,
//     onlineProducts,
//     totalProducts,
//     revenueOverview,
//     productPerformance,
//     recentActivity,
//     reviewCount
//   ] = await Promise.all([
//     this.getRevenueAllTime(),
//     this.getRevenueToday(),
//     this.getRevenueForPeriod("thisWeek"),
//     this.getRevenueForPeriod("lastWeek"),
//     this.getOrdersAllTime(),
//     this.getOrdersToday(),
//     this.getOrdersForPeriod("thisWeek"),
//     this.getOrdersForPeriod("lastWeek"),
//     this.getPendingOrdersCount(),
//     this.getAverageVendorRating(),
//     this.getOnlineProductsCount(),
//     this.getTotalProductsCount(),
//     this.getRevenueOverview(),
//     this.getProductPerformance(),
//     this.getRecentActivity(),
//     this.getReviewCount()
//   ]);
//   const revenueGrowth = this.calculateGrowthPercentage(revenueThisWeek, revenueLastWeek);
//   const orderGrowth = this.calculateGrowthPercentage(ordersThisWeek, ordersLastWeek);
//   const summary = {
//     stats: {
//       revenue: {
//         value: `N${this.formatNumber(totalRevenue)}`,
//         subtitle: revenueGrowth !== null ? 
//                   (revenueGrowth > 0 ? `+${revenueGrowth.toFixed(0)}% this week` : 
//                    revenueGrowth < 0 ? `${revenueGrowth.toFixed(0)}% this week` : 
//                    'No change this week') : 'No previous data',
//         today: `N${this.formatNumber(revenueToday)}`
//       },
//       orders: {
//         value: totalOrders.toString(),
//         subtitle: orderGrowth !== null ?
//                   (orderGrowth > 0 ? `+${orderGrowth.toFixed(0)}% this week` : 
//                    orderGrowth < 0 ? `${orderGrowth.toFixed(0)}% this week` : 
//                    'No change this week') : 'No previous data',
//         today: ordersToday.toString()
//       },
//       pending: {
//         value: pendingOrders.toString(),
//         subtitle: pendingOrders > 0 ? 'Need attention' : 'All caught up'
//       },
//       rating: {
//         value: averageRating.toFixed(1),
//         subtitle: `${reviewCount} reviews`
//       }
//     },
//     onlineStatus: {
//       online: onlineProducts,
//       total: totalProducts,
//       displayText: `${onlineProducts}/${totalProducts} Products`
//     },
//     revenueChart: revenueOverview,
//     productPerformance,
//     recentActivity,
//     productLiveControl: await this.getProductLiveControl()
//   };
//   // STEP 2: Cache the result for faster future response
//   await redisProducts.set(cacheKey, JSON.stringify(summary), { EX: 60 * 5 }); // cache for 5 minutes
//   return summary;
// }
//   // ==================== REVENUE METHODS ====================
//   async getRevenueToday(): Promise<number> {
//     const todayStart = startOfDay(new Date());
//     const todayEnd = endOfDay(new Date());
//     const revenue = await prisma.order.aggregate({
//       where: {
//         vendorId: this.vendorId,
//         status: OrderStatus.COMPLETED,
//         createdAt: { gte: todayStart, lte: todayEnd }
//       },
//       _sum: { totalPrice: true }
//     });
//     return revenue._sum.totalPrice || 0;
//   }
//   async getRevenueForPeriod(period: "thisWeek" | "lastWeek" | "lastMonth"): Promise<number> {
//     const now = new Date();
//     let startDate: Date;
//     let endDate: Date;
//     if (period === "thisWeek") {
//       // This week (Monday to today)
//       const today = new Date();
//       const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
//       const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
//       startDate = new Date(today);
//       startDate.setDate(today.getDate() - diffToMonday);
//       startDate.setHours(0, 0, 0, 0);
//       endDate = today;
//     } else if (period === "lastWeek") {
//       // Last full week (Monday to Sunday)
//       const today = new Date();
//       const dayOfWeek = today.getDay();
//       const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
//       endDate = new Date(today);
//       endDate.setDate(today.getDate() - diffToMonday - 1); // Last Sunday
//       endDate.setHours(23, 59, 59, 999);
//       startDate = new Date(endDate);
//       startDate.setDate(endDate.getDate() - 6); // Previous Monday
//       startDate.setHours(0, 0, 0, 0);
//     } else {
//       // Last month
//       startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
//       endDate = new Date(now.getFullYear(), now.getMonth(), 0);
//     }
//     const revenue = await prisma.order.aggregate({
//       where: {
//         vendorId: this.vendorId,
//         status: OrderStatus.COMPLETED,
//         createdAt: { gte: startDate, lte: endDate }
//       },
//       _sum: { totalPrice: true }
//     });
//     return revenue._sum.totalPrice || 0;
//   }
//   async getRevenueAllTime(): Promise<number> {
//     const revenue = await prisma.order.aggregate({
//       where: { 
//         vendorId: this.vendorId, 
//         status: OrderStatus.COMPLETED 
//       },
//       _sum: { totalPrice: true }
//     });
//     return revenue._sum.totalPrice || 0;
//   }
//   // ==================== ORDER METHODS ====================
//   async getOrdersToday(): Promise<number> {
//     const todayStart = startOfDay(new Date());
//     const todayEnd = endOfDay(new Date());
//     return prisma.order.count({
//       where: {
//         vendorId: this.vendorId,
//         status: OrderStatus.COMPLETED,
//         createdAt: { gte: todayStart, lte: todayEnd }
//       }
//     });
//   }
//   async getOrdersForPeriod(period: "thisWeek" | "lastWeek" | "lastMonth"): Promise<number> {
//     const now = new Date();
//     let startDate: Date;
//     let endDate: Date;
//     if (period === "thisWeek") {
//       const today = new Date();
//       const dayOfWeek = today.getDay();
//       const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
//       startDate = new Date(today);
//       startDate.setDate(today.getDate() - diffToMonday);
//       startDate.setHours(0, 0, 0, 0);
//       endDate = today;
//     } else if (period === "lastWeek") {
//       const today = new Date();
//       const dayOfWeek = today.getDay();
//       const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
//       endDate = new Date(today);
//       endDate.setDate(today.getDate() - diffToMonday - 1);
//       endDate.setHours(23, 59, 59, 999);
//       startDate = new Date(endDate);
//       startDate.setDate(endDate.getDate() - 6);
//       startDate.setHours(0, 0, 0, 0);
//     } else {
//       startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
//       endDate = new Date(now.getFullYear(), now.getMonth(), 0);
//     }
//     return prisma.order.count({
//       where: {
//         vendorId: this.vendorId,
//         status: OrderStatus.COMPLETED,
//         createdAt: { gte: startDate, lte: endDate }
//       }
//     });
//   }
//   async getOrdersAllTime(): Promise<number> {
//     return prisma.order.count({
//       where: { 
//         vendorId: this.vendorId, 
//         status: OrderStatus.COMPLETED 
//       }
//     });
//   }
//   async getPendingOrdersCount(): Promise<number> {
//     return prisma.order.count({
//       where: {
//         vendorId: this.vendorId,
//         status: {
//           in: [
//             OrderStatus.PENDING,
//             OrderStatus.WAITING_VENDOR_CONFIRMATION,
//             OrderStatus.AWAITING_PAYMENT,
//             OrderStatus.PAYMENT_CONFIRMED,
//             OrderStatus.COOKING
//           ]
//         }
//       }
//     });
//   }
//   // ==================== PRODUCT METHODS ====================
//   async getOnlineProductsCount(): Promise<number> {
//     return prisma.product.count({
//       where: {
//         vendorId: this.vendorId,
//         isLive: true,
//         archived: false
//       }
//     });
//   }
//   async getTotalProductsCount(): Promise<number> {
//     return prisma.product.count({
//       where: {
//         vendorId: this.vendorId,
//         archived: false
//       }
//     });
//   }
//   // ==================== RATING METHODS ====================
//   async getAverageVendorRating(): Promise<number> {
//     const vendorReviews = await prisma.vendorReview.aggregate({
//       where: { vendorId: this.vendorId },
//       _avg: { rating: true }
//     });
//     const productReviews = await prisma.productReview.aggregate({
//       where: {
//         product: { vendorId: this.vendorId }
//       },
//       _avg: { rating: true }
//     });
//     const vendorAvg = vendorReviews._avg.rating || 0;
//     const productAvg = productReviews._avg.rating || 0;
//     if (vendorAvg > 0 && productAvg > 0) {
//       return (vendorAvg + productAvg) / 2;
//     } else if (vendorAvg > 0) {
//       return vendorAvg;
//     } else if (productAvg > 0) {
//       return productAvg;
//     } else {
//       return 0;
//     }
//   }
//   async getReviewCount(): Promise<number> {
//     const vendorReviews = await prisma.vendorReview.count({
//       where: { vendorId: this.vendorId }
//     });
//     const productReviews = await prisma.productReview.count({
//       where: {
//         product: { vendorId: this.vendorId }
//       }
//     });
//     return vendorReviews + productReviews;
//   }
//   // ==================== REVENUE OVERVIEW (Chart) - FIXED ====================
//   async getRevenueOverview() {
//     const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
//     const now = new Date();
//     // Get the start of this week (Monday)
//     const today = new Date();
//     const dayOfWeek = today.getDay();
//     const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
//     const startOfWeekDate = new Date(today);
//     startOfWeekDate.setDate(today.getDate() - diffToMonday);
//     startOfWeekDate.setHours(0, 0, 0, 0);
//     const revenueData = await Promise.all(
//       days.map(async (day, index) => {
//         const dayStart = new Date(startOfWeekDate);
//         dayStart.setDate(dayStart.getDate() + index);
//         // Skip future days
//         if (dayStart > now) {
//           return {
//             day,
//             revenue: 0,
//             chartPercentage: 0
//           };
//         }
//         const dayEnd = new Date(dayStart);
//         dayEnd.setHours(23, 59, 59, 999);
//         const revenue = await prisma.order.aggregate({
//           where: {
//             vendorId: this.vendorId,
//             status: OrderStatus.COMPLETED,
//             createdAt: { gte: dayStart, lte: dayEnd }
//           },
//           _sum: { totalPrice: true }
//         });
//         const revenueValue = revenue._sum.totalPrice || 0;
//         return {
//           day,
//           revenue: revenueValue,
//           chartPercentage: 0 // Will be calculated below
//         };
//       })
//     );
//     // Calculate max revenue for normalization
//     const maxRevenue = Math.max(...revenueData.map(d => d.revenue), 1);
//     // Add chart percentages
//     return revenueData.map(data => ({
//       ...data,
//       chartPercentage: data.revenue > 0 ? Math.round((data.revenue / maxRevenue) * 100) : 0
//     }));
//   }
//   // ==================== PRODUCT PERFORMANCE - FIXED TREND CALCULATION ====================
//   async getProductPerformance() {
//     const thirtyDaysAgo = subDays(new Date(), 30);
//     const fourteenDaysAgo = subDays(new Date(), 14);
//     const sevenDaysAgo = subDays(new Date(), 7);
//     const products = await prisma.product.findMany({
//       where: {
//         vendorId: this.vendorId,
//         archived: false
//       },
//       include: {
//         orderItems: {
//           where: {
//             order: {
//               status: OrderStatus.COMPLETED,
//               createdAt: { gte: thirtyDaysAgo }
//             }
//           },
//           include: {
//             order: true
//           }
//         },
//         reviews: true
//       }
//     });
//     const productsWithPerformance = products
//       .map(product => {
//         // Total revenue and sales for last 30 days
//         const totalRevenue = product.orderItems.reduce(
//           (sum, item) => sum + item.subtotal, 0
//         );
//         const totalSales = product.orderItems.reduce(
//           (sum, item) => sum + item.quantity, 0
//         );
//         const averageRating = product.reviews.length > 0
//           ? product.reviews.reduce((sum, review) => sum + review.rating, 0) / product.reviews.length
//           : 0;
//         // Calculate last week revenue (last 7 days)
//         const lastWeekRevenue = product.orderItems
//           .filter(item => item.order.createdAt >= sevenDaysAgo)
//           .reduce((sum, item) => sum + item.subtotal, 0);
//         // Calculate previous week revenue (7-14 days ago)
//         const prevWeekRevenue = product.orderItems
//           .filter(item => 
//             item.order.createdAt >= fourteenDaysAgo && 
//             item.order.createdAt < sevenDaysAgo
//           )
//           .reduce((sum, item) => sum + item.subtotal, 0);
//         // Calculate trend properly
//         let trend = 0;
//         let isPositiveTrend = false;
//         let trendText = '0%';
//         if (prevWeekRevenue === 0) {
//           if (lastWeekRevenue > 0) {
//             trend = 100; // New sales this week
//             isPositiveTrend = true;
//             trendText = `New`;
//           }
//         } else {
//           trend = ((lastWeekRevenue - prevWeekRevenue) / prevWeekRevenue) * 100;
//           isPositiveTrend = trend > 0;
//           trendText = `${trend > 0 ? '+' : ''}${Math.round(trend)}%`;
//         }
//         return {
//           id: product.id,
//           name: product.name,
//           sales: totalSales,
//           revenue: totalRevenue,
//           averageRating,
//           trend: trendText,
//           isPositiveTrend,
//           performancePercentage: 0 // Will be calculated below
//         };
//       })
//       .filter(p => p.revenue > 0)
//       .sort((a, b) => b.revenue - a.revenue)
//       .slice(0, 5);
//     // Calculate performance percentages for chart
//     const maxRevenue = Math.max(...productsWithPerformance.map(p => p.revenue), 1);
//     return productsWithPerformance.map(product => ({
//       ...product,
//       performancePercentage: Math.round((product.revenue / maxRevenue) * 100)
//     }));
//   }
//   async getAllVendorProducts(skip: number = 0, limit: number = 20) {
//   const page = Math.floor(skip / limit) + 1;
//   const vendorWhere = { vendorId: this.vendorId };
//   const cacheKey = `vendor:${this.vendorId}:products:page:${page}:limit:${limit}`;
//   // STEP 0: Try fetching from cache
//   const cached = await redisProducts.get(cacheKey);
//   let totalCount: number;
//   let productsData: any[];
//   if (cached) {
//     const parsed = JSON.parse(cached);
//     totalCount = parsed.total;
//     productsData = parsed.products;
//   } else {
//     // STEP 1: Total count
//     totalCount = await prisma.product.count({ where: vendorWhere });
//     // STEP 2: Fetch paginated products
//     const products = await prisma.product.findMany({
//       where: vendorWhere,
//       skip,
//       take: limit,
//       orderBy: { createdAt: "desc" },
//       select: {
//         id: true,
//         name: true,
//         price: true,
//         category: true,
//         thumbnail: true,
//         images: true,
//         archived: true,
//         popularityPercent: true,
//         productSchedule: { select: { goLiveAt: true, takeDownAt: true, graceMinutes: true } },
//         reviews: { select: { rating: true } },
//       },
//     });
//     // STEP 3: Map to cacheable format
//     productsData = products.map(p => ({
//       id: p.id,
//       name: p.name,
//       price: p.price,
//       category: p.category,
//       images: p.thumbnail ? [p.thumbnail] : p.images.length > 0 ? [p.images[0]] : [],
//       popularityPercent: p.popularityPercent,
//       archived: p.archived,
//       averageRating: p.reviews.length > 0 ? p.reviews.reduce((sum, r) => sum + r.rating, 0) / p.reviews.length : null,
//       reviewCount: p.reviews.length,
//       productSchedule: p.productSchedule || null,
//     }));
//     // STEP 4: Cache static fields
//     await redisProducts.set(cacheKey, JSON.stringify({ products: productsData, total: totalCount }), { EX: 60 * 5 });
//   }
//   // STEP 5: Compute live status dynamically
//   const computeIsLive = (goLiveAt: Date | null, liveUntil: Date | null, graceMinutes: number | null) => {
//     if (!goLiveAt || !liveUntil) return false;
//     const now = Date.now();
//     const grace = (graceMinutes ?? 0) * 60_000;
//     return now >= new Date(goLiveAt).getTime() && now <= new Date(liveUntil).getTime() + grace;
//   };
//   const formattedProducts = productsData
//     .map(p => ({
//       ...p,
//       isLive: computeIsLive(
//         p.productSchedule?.goLiveAt || null,
//         p.productSchedule?.takeDownAt || null,
//         p.productSchedule?.graceMinutes || 0
//       ),
//     }))
//     .sort((a, b) => Number(b.isLive) - Number(a.isLive));
//   // STEP 6: Pagination
//   const pagination = {
//     total: totalCount,
//     page,
//     limit,
//     totalPages: Math.ceil(totalCount / limit),
//     hasNextPage: skip + limit < totalCount,
//     hasPreviousPage: skip > 0,
//   };
//   return { products: formattedProducts, pagination };
// }
//   // ==================== RECENT ACTIVITY - FIXED ====================
//  // ==================== RECENT ACTIVITY - FIXED ====================
// async getRecentActivity() {
//   const thirtyDaysAgo = subDays(new Date(), 30);
//   // Get recent orders
//   const recentOrders = await prisma.order.findMany({
//     where: { 
//       vendorId: this.vendorId,
//       createdAt: { gte: thirtyDaysAgo }
//     },
//     orderBy: { createdAt: 'desc' },
//     take: 10,
//     include: {
//       customer: {
//         select: { name: true }
//       }
//     }
//   });
//   // Get recent reviews
//   const recentVendorReviews = await prisma.vendorReview.findMany({
//     where: { 
//       vendorId: this.vendorId,
//       createdAt: { gte: thirtyDaysAgo }
//     },
//     orderBy: { createdAt: 'desc' },
//     take: 5,
//     include: {
//       customer: {
//         select: { name: true }
//       }
//     }
//   });
//   // Create a complete status map for all OrderStatus values
//   const statusMap: Record<OrderStatus, { icon: string; color: string; action: string }> = {
//     [OrderStatus.PENDING]: { icon: 'pending', color: 'amber', action: 'placed' },
//     [OrderStatus.WAITING_VENDOR_CONFIRMATION]: { icon: 'hourglass_empty', color: 'amber', action: 'waiting for vendor confirmation' },
//     [OrderStatus.AWAITING_PAYMENT]: { icon: 'payment', color: 'blue', action: 'awaiting payment' },
//     [OrderStatus.PAYMENT_CONFIRMED]: { icon: 'check_circle', color: 'green', action: 'payment confirmed' },
//     [OrderStatus.COOKING]: { icon: 'restaurant', color: 'blue', action: 'started cooking' },
//     [OrderStatus.READY_FOR_PICKUP]: { icon: 'local_shipping', color: 'blue', action: 'ready for pickup' },
//     [OrderStatus.OUT_FOR_DELIVERY]: { icon: 'delivery_dining', color: 'blue', action: 'out for delivery' },
//     [OrderStatus.COMPLETED]: { icon: 'check_circle', color: 'green', action: 'completed' },
//     [OrderStatus.CANCELLED]: { icon: 'cancel', color: 'red', action: 'cancelled' },
//     WAITING_CUSTOMER_APPROVAL: {
//       icon: "",
//       color: "",
//       action: ""
//     },
//     PAYMENT_EXPIRED: {
//       icon: "",
//       color: "",
//       action: ""
//     },
//     CANCELLED_UNPAID: {
//       icon: "",
//       color: "",
//       action: ""
//     },
//     FAILED_DELIVERY: {
//       icon: "",
//       color: "",
//       action: ""
//     }
//   };
//   // Transform orders into activity items
//   const orderActivities = recentOrders.map(order => {
//     const statusInfo = statusMap[order.status] || { icon: 'notifications', color: 'blue', action: 'updated' };
//     return {
//       id: order.id,
//       icon: statusInfo.icon,
//       iconColor: statusInfo.color,
//       title: `Order ${statusInfo.action}`,
//       subtitle: format(order.createdAt, 'hh:mm a'),
//       description: order.customer?.name 
//         ? `${order.customer.name} – N${order.totalPrice.toFixed(2)}`
//         : `Order #${order.id.slice(-6)} – N${order.totalPrice.toFixed(2)}`
//     };
//   });
//   // Transform reviews into activity items
//   const reviewActivities = recentVendorReviews.map(review => ({
//     id: review.id,
//     icon: 'star',
//     iconColor: 'amber',
//     title: 'New review received',
//     subtitle: format(review.createdAt, 'hh:mm a'),
//     description: `${review.customer?.name || 'Customer'} rated ${review.rating} stars`
//   }));
//   // Combine and sort by date (most recent first)
//   const allActivities = [...orderActivities, ...reviewActivities]
//     .sort((a, b) => new Date(b.subtitle).getTime() - new Date(a.subtitle).getTime())
//     .slice(0, 10);
//   return allActivities;
// }
//   // ==================== PRODUCT LIVE CONTROL - FIXED ====================
//   async getProductLiveControl() {
//     const products = await prisma.product.findMany({
//       where: {
//         vendorId: this.vendorId,
//         archived: false
//       },
//       include: {
//         orderItems: {
//           where: {
//             order: { status: OrderStatus.COMPLETED }
//           },
//           include: {
//             order: true
//           }
//         },
//         productSchedule: true
//       },
//       orderBy: { isLive: 'desc' },
//       take: 3
//     });
//     // Last 7 days revenue for insights
//     const sevenDaysAgo = subDays(new Date(), 7);
//     const totalInsightsValue = await prisma.order.aggregate({
//       where: {
//         vendorId: this.vendorId,
//         status: OrderStatus.COMPLETED,
//         createdAt: { gte: sevenDaysAgo }
//       },
//       _sum: { totalPrice: true }
//     });
//     return {
//       products: products.map(product => {
//         // Show actual product price, not revenue
//         const price = `N${Number(product.price).toLocaleString('en-US', { 
//           minimumFractionDigits: 2, 
//           maximumFractionDigits: 2 
//         })}`;
//         return {
//           id: product.id,
//           name: product.name,
//           price: price, // Changed from revenue to product price
//           status: product.isLive ? 'LIVE' : 'OFFLINE',
//           statusColor: product.isLive ? 'green' : 'red'
//         };
//       }),
//       totalInsights: `N${(totalInsightsValue._sum.totalPrice || 0).toLocaleString('en-US', { 
//         minimumFractionDigits: 2, 
//         maximumFractionDigits: 2 
//       })}`
//     };
//   }
//   // ==================== ANALYTICS ENDPOINT ====================
//   async getAnalytics() {
//     const [
//       peakHours,
//       customerReturnRate,
//       orderValueStats,
//       productAnalytics
//     ] = await Promise.all([
//       this.getPeakHours(),
//       this.getCustomerReturnRate(),
//       this.getOrderValueStats(),
//       this.getProductAnalytics()
//     ]);
//     return {
//       peakHours,
//       customerReturnRate,
//       orderValueStats,
//       productAnalytics
//     };
//   }
//   async getPeakHours() {
//     const thirtyDaysAgo = subDays(new Date(), 30);
//     const orders = await prisma.order.findMany({
//       where: {
//         vendorId: this.vendorId,
//         status: OrderStatus.COMPLETED,
//         createdAt: { gte: thirtyDaysAgo }
//       },
//       select: { createdAt: true }
//     });
//     const hourCount = Array(24).fill(0);
//     orders.forEach(order => {
//       const hour = order.createdAt.getHours();
//       hourCount[hour]++;
//     });
//     const maxCount = Math.max(...hourCount);
//     const peakHours = hourCount
//       .map((count, hour) => ({ hour, count }))
//       .sort((a, b) => b.count - a.count)
//       .slice(0, 3)
//       .map(item => `${item.hour}:00`);
//     return { peakHours, maxCount };
//   }
//   async getCustomerReturnRate() {
//     const orders = await prisma.order.findMany({
//       where: {
//         vendorId: this.vendorId,
//         status: OrderStatus.COMPLETED
//       },
//       select: { customerId: true }
//     });
//     const customerOrderMap = orders.reduce((acc, order) => {
//       acc[order.customerId] = (acc[order.customerId] || 0) + 1;
//       return acc;
//     }, {} as Record<string, number>);
//     const totalCustomers = Object.keys(customerOrderMap).length;
//     const returningCustomers = Object.values(customerOrderMap).filter(count => count > 1).length;
//     return totalCustomers === 0 ? 0 : Math.round((returningCustomers / totalCustomers) * 100);
//   }
//   async getOrderValueStats() {
//     const thirtyDaysAgo = subDays(new Date(), 30);
//     const orders = await prisma.order.findMany({
//       where: {
//         vendorId: this.vendorId,
//         status: OrderStatus.COMPLETED,
//         createdAt: { gte: thirtyDaysAgo }
//       },
//       select: { totalPrice: true }
//     });
//     const orderValues = orders.map(o => Number(o.totalPrice));
//     const average = orderValues.length > 0 
//       ? orderValues.reduce((a, b) => a + b, 0) / orderValues.length
//       : 0;
//     const min = orderValues.length > 0 ? Math.min(...orderValues) : 0;
//     const max = orderValues.length > 0 ? Math.max(...orderValues) : 0;
//     return { 
//       average: Math.round(average * 100) / 100, 
//       min: Math.round(min * 100) / 100, 
//       max: Math.round(max * 100) / 100, 
//       totalOrders: orderValues.length 
//     };
//   }
//   async getProductAnalytics() {
//     const products = await prisma.product.findMany({
//       where: { vendorId: this.vendorId, archived: false },
//       include: {
//         reviews: true,
//         orderItems: {
//           where: { order: { status: OrderStatus.COMPLETED } },
//           include: { order: true }
//         }
//       }
//     });
//     const totalProducts = products.length;
//     const liveProducts = products.filter(p => p.isLive).length;
//     const productsWithReviews = products.filter(p => p.reviews.length > 0).length;
//     const totalRevenue = products.reduce(
//       (sum, p) => sum + p.orderItems.reduce((s, item) => s + item.subtotal, 0), 0
//     );
//     return {
//       totalProducts,
//       liveProducts,
//       percentageLive: totalProducts > 0 ? Math.round((liveProducts / totalProducts) * 100) : 0,
//       productsWithReviews,
//       percentageReviewed: totalProducts > 0 ? Math.round((productsWithReviews / totalProducts) * 100) : 0,
//       averageRating: await this.getAverageVendorRating(),
//       totalRevenue: Math.round(totalRevenue * 100) / 100
//     };
//   }
//   // ==================== HELPER METHODS ====================
//   private formatNumber(num: number): string {
//     if (num >= 1000000) {
//       return (num / 1000000).toFixed(1) + 'M';
//     } else if (num >= 1000) {
//       return (num / 1000).toFixed(1) + 'k';
//     }
//     return num.toFixed(0);
//   }
//   private calculateGrowthPercentage(current: number, previous: number): number | null {
//     // If no previous data, return null
//     if (previous === 0 && current === 0) return null;
//     if (previous === 0) return 100; // From 0 to something is 100% growth
//     if (current === 0) return -100; // From something to 0 is -100% growth
//     const growth = ((current - previous) / previous) * 100;
//     // Cap at reasonable values
//     if (growth > 1000) return 1000;
//     if (growth < -100) return -100;
//     return Math.round(growth * 10) / 10; // Keep one decimal
//   }
//   // Cache invalidation
//   async invalidateCache() {
//     await clearProductCache(undefined, this.vendorId);
//   }
//   async invalidateProductCache(productId: string) {
//     await clearProductCache(productId, this.vendorId);
//   }
// }
const client_1 = require("@prisma/client");
const date_fns_1 = require("date-fns");
const clearCaches_1 = require("../services/clearCaches");
const redis_1 = require("../lib/redis");
const prisma = new client_1.PrismaClient();
class VendorDashboardService {
    constructor(vendorId) {
        this.vendorId = vendorId;
    }
    // ==================== DASHBOARD SUMMARY ====================
    async getDashboardSummary() {
        const cacheKey = `vendor:${this.vendorId}:dashboardSummary`;
        // STEP 0: Try fetching from cache
        const cached = await redis_1.redisProducts.get(cacheKey);
        if (cached)
            return JSON.parse(cached);
        // STEP 1: Fetch all data if not cached
        const [totalRevenue, revenueToday, revenueThisWeek, revenueLastWeek, totalOrders, ordersToday, ordersThisWeek, ordersLastWeek, pendingOrders, averageRating, onlineProducts, totalProducts, revenueOverview, productPerformance, recentActivity, reviewCount, productLiveControl,] = await Promise.all([
            this.getRevenueAllTime(),
            this.getRevenueToday(),
            this.getRevenueForPeriod("thisWeek"),
            this.getRevenueForPeriod("lastWeek"),
            this.getOrdersAllTime(),
            this.getOrdersToday(),
            this.getOrdersForPeriod("thisWeek"),
            this.getOrdersForPeriod("lastWeek"),
            this.getPendingOrdersCount(),
            this.getAverageVendorRating(),
            this.getOnlineProductsCount(),
            this.getTotalProductsCount(),
            this.getRevenueOverview(),
            this.getProductPerformance(),
            this.getRecentActivity(),
            this.getReviewCount(),
            this.getProductLiveControl(),
        ]);
        const revenueGrowth = this.calculateGrowthPercentage(revenueThisWeek, revenueLastWeek);
        const orderGrowth = this.calculateGrowthPercentage(ordersThisWeek, ordersLastWeek);
        const summary = {
            stats: {
                revenue: {
                    value: `N${this.formatNumber(totalRevenue)}`,
                    subtitle: revenueGrowth !== null
                        ? revenueGrowth > 0
                            ? `+${revenueGrowth.toFixed(0)}% this week`
                            : revenueGrowth < 0
                                ? `${revenueGrowth.toFixed(0)}% this week`
                                : "No change this week"
                        : "No previous data",
                    today: `N${this.formatNumber(revenueToday)}`,
                },
                orders: {
                    value: totalOrders.toString(),
                    subtitle: orderGrowth !== null
                        ? orderGrowth > 0
                            ? `+${orderGrowth.toFixed(0)}% this week`
                            : orderGrowth < 0
                                ? `${orderGrowth.toFixed(0)}% this week`
                                : "No change this week"
                        : "No previous data",
                    today: ordersToday.toString(),
                },
                pending: {
                    value: pendingOrders.toString(),
                    subtitle: pendingOrders > 0 ? "Need attention" : "All caught up",
                },
                rating: {
                    value: averageRating.toFixed(1),
                    subtitle: `${reviewCount} reviews`,
                },
            },
            onlineStatus: {
                online: onlineProducts,
                total: totalProducts,
                displayText: `${onlineProducts}/${totalProducts} Products`,
            },
            revenueChart: revenueOverview,
            productPerformance,
            recentActivity,
            productLiveControl,
        };
        // STEP 2: Cache the result for faster future response
        await redis_1.redisProducts.set(cacheKey, JSON.stringify(summary), { EX: 60 * 5 }); // 5 mins
        return summary;
    }
    // ==================== DATE RANGE HELPERS ====================
    getRangeForPeriod(period) {
        const now = new Date();
        let startDate;
        let endDate;
        if (period === "thisWeek") {
            const today = new Date();
            const dayOfWeek = today.getDay(); // 0=Sun,1=Mon...
            const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
            startDate = new Date(today);
            startDate.setDate(today.getDate() - diffToMonday);
            startDate.setHours(0, 0, 0, 0);
            endDate = today;
        }
        else if (period === "lastWeek") {
            const today = new Date();
            const dayOfWeek = today.getDay();
            const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
            endDate = new Date(today);
            endDate.setDate(today.getDate() - diffToMonday - 1); // last Sunday
            endDate.setHours(23, 59, 59, 999);
            startDate = new Date(endDate);
            startDate.setDate(endDate.getDate() - 6); // Monday
            startDate.setHours(0, 0, 0, 0);
        }
        else {
            // lastMonth
            startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(now.getFullYear(), now.getMonth(), 0);
            endDate.setHours(23, 59, 59, 999);
        }
        return { startDate, endDate };
    }
    // ==================== REVENUE METHODS (revert to order-based for consistency) ====================
    async sumSuccessfulPaymentsInRange(start, end) {
        try {
            const revenue = await prisma.order.aggregate({
                where: {
                    vendorId: this.vendorId,
                    status: client_1.OrderStatus.COMPLETED,
                    createdAt: { gte: start, lte: end }
                },
                _sum: { totalPrice: true }
            });
            return revenue._sum.totalPrice || 0;
        }
        catch (error) {
            console.error('Database connection error in sumSuccessfulPaymentsInRange:', error);
            return 0;
        }
    }
    async getRevenueToday() {
        const todayStart = (0, date_fns_1.startOfDay)(new Date());
        const todayEnd = (0, date_fns_1.endOfDay)(new Date());
        return this.sumSuccessfulPaymentsInRange(todayStart, todayEnd);
    }
    async getRevenueForPeriod(period) {
        const { startDate, endDate } = this.getRangeForPeriod(period);
        return this.sumSuccessfulPaymentsInRange(startDate, endDate);
    }
    async getRevenueAllTime() {
        return this.sumSuccessfulPaymentsInRange(new Date(0), new Date()); // from beginning
    }
    // ==================== ORDER METHODS ====================
    async getOrdersToday() {
        const todayStart = (0, date_fns_1.startOfDay)(new Date());
        const todayEnd = (0, date_fns_1.endOfDay)(new Date());
        return prisma.order.count({
            where: {
                vendorId: this.vendorId,
                status: client_1.OrderStatus.COMPLETED,
                createdAt: { gte: todayStart, lte: todayEnd },
            },
        });
    }
    async getOrdersForPeriod(period) {
        const { startDate, endDate } = this.getRangeForPeriod(period);
        return prisma.order.count({
            where: {
                vendorId: this.vendorId,
                status: client_1.OrderStatus.COMPLETED,
                createdAt: { gte: startDate, lte: endDate },
            },
        });
    }
    async getOrdersAllTime() {
        return prisma.order.count({
            where: {
                vendorId: this.vendorId,
                status: client_1.OrderStatus.COMPLETED,
            },
        });
    }
    async getPendingOrdersCount() {
        return prisma.order.count({
            where: {
                vendorId: this.vendorId,
                status: {
                    in: [
                        client_1.OrderStatus.PENDING,
                        client_1.OrderStatus.WAITING_VENDOR_CONFIRMATION,
                        client_1.OrderStatus.WAITING_CUSTOMER_APPROVAL,
                        client_1.OrderStatus.AWAITING_PAYMENT,
                        client_1.OrderStatus.PAYMENT_CONFIRMED,
                        client_1.OrderStatus.COOKING,
                        client_1.OrderStatus.READY_FOR_PICKUP,
                        client_1.OrderStatus.OUT_FOR_DELIVERY,
                    ],
                },
            },
        });
    }
    // ==================== PRODUCT METHODS ====================
    async getOnlineProductsCount() {
        return prisma.product.count({
            where: {
                vendorId: this.vendorId,
                isLive: true,
                archived: false,
            },
        });
    }
    async getTotalProductsCount() {
        return prisma.product.count({
            where: {
                vendorId: this.vendorId,
                archived: false,
            },
        });
    }
    // ==================== RATING METHODS ====================
    async getAverageVendorRating() {
        const vendorReviews = await prisma.vendorReview.aggregate({
            where: { vendorId: this.vendorId },
            _avg: { rating: true },
        });
        const productReviews = await prisma.productReview.aggregate({
            where: { product: { vendorId: this.vendorId } },
            _avg: { rating: true },
        });
        const vendorAvg = vendorReviews._avg.rating || 0;
        const productAvg = productReviews._avg.rating || 0;
        if (vendorAvg > 0 && productAvg > 0)
            return (vendorAvg + productAvg) / 2;
        if (vendorAvg > 0)
            return vendorAvg;
        if (productAvg > 0)
            return productAvg;
        return 0;
    }
    async getReviewCount() {
        const [vendorReviews, productReviews] = await Promise.all([
            prisma.vendorReview.count({ where: { vendorId: this.vendorId } }),
            prisma.productReview.count({ where: { product: { vendorId: this.vendorId } } }),
        ]);
        return vendorReviews + productReviews;
    }
    // ==================== REVENUE OVERVIEW (Chart) (✅ Payment-based + fixed) ====================
    async getRevenueOverview() {
        const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        const now = new Date();
        // start of week Monday
        const today = new Date();
        const dayOfWeek = today.getDay();
        const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const startOfWeekDate = new Date(today);
        startOfWeekDate.setDate(today.getDate() - diffToMonday);
        startOfWeekDate.setHours(0, 0, 0, 0);
        const revenueData = await Promise.all(days.map(async (day, index) => {
            const dayStart = new Date(startOfWeekDate);
            dayStart.setDate(dayStart.getDate() + index);
            // skip future days
            if (dayStart > now) {
                return { day, revenue: 0, chartPercentage: 0 };
            }
            const dayEnd = new Date(dayStart);
            dayEnd.setHours(23, 59, 59, 999);
            const revenueValue = await this.sumSuccessfulPaymentsInRange(dayStart, dayEnd);
            return {
                day,
                revenue: revenueValue,
                chartPercentage: 0,
            };
        }));
        const maxRevenue = Math.max(...revenueData.map((d) => d.revenue), 1);
        return revenueData.map((data) => ({
            ...data,
            chartPercentage: data.revenue > 0 ? Math.round((data.revenue / maxRevenue) * 100) : 0,
        }));
    }
    // ==================== PRODUCT PERFORMANCE ====================
    async getProductPerformance() {
        const thirtyDaysAgo = (0, date_fns_1.subDays)(new Date(), 30);
        const fourteenDaysAgo = (0, date_fns_1.subDays)(new Date(), 14);
        const sevenDaysAgo = (0, date_fns_1.subDays)(new Date(), 7);
        const products = await prisma.product.findMany({
            where: { vendorId: this.vendorId, archived: false },
            include: {
                orderItems: {
                    where: {
                        order: {
                            status: client_1.OrderStatus.COMPLETED,
                            createdAt: { gte: thirtyDaysAgo },
                        },
                    },
                    // ✅ only pull what you need
                    select: {
                        subtotal: true,
                        quantity: true,
                        order: { select: { createdAt: true } },
                    },
                },
                reviews: { select: { rating: true } },
            },
        });
        const productsWithPerformance = products
            .map((product) => {
            const totalRevenue = product.orderItems.reduce((sum, item) => sum + item.subtotal, 0);
            const totalSales = product.orderItems.reduce((sum, item) => sum + item.quantity, 0);
            const averageRating = product.reviews.length > 0
                ? product.reviews.reduce((sum, r) => sum + r.rating, 0) / product.reviews.length
                : 0;
            const lastWeekRevenue = product.orderItems
                .filter((item) => item.order.createdAt >= sevenDaysAgo)
                .reduce((sum, item) => sum + item.subtotal, 0);
            const prevWeekRevenue = product.orderItems
                .filter((item) => item.order.createdAt >= fourteenDaysAgo && item.order.createdAt < sevenDaysAgo)
                .reduce((sum, item) => sum + item.subtotal, 0);
            let isPositiveTrend = false;
            let trendText = "0%";
            if (prevWeekRevenue === 0) {
                if (lastWeekRevenue > 0) {
                    isPositiveTrend = true;
                    trendText = "New";
                }
            }
            else {
                const trend = ((lastWeekRevenue - prevWeekRevenue) / prevWeekRevenue) * 100;
                isPositiveTrend = trend > 0;
                trendText = `${trend > 0 ? "+" : ""}${Math.round(trend)}%`;
            }
            return {
                id: product.id,
                name: product.name,
                sales: totalSales,
                revenue: totalRevenue,
                averageRating,
                trend: trendText,
                isPositiveTrend,
                performancePercentage: 0,
            };
        })
            .filter((p) => p.revenue > 0)
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, 5);
        const maxRevenue = Math.max(...productsWithPerformance.map((p) => p.revenue), 1);
        return productsWithPerformance.map((product) => ({
            ...product,
            performancePercentage: Math.round((product.revenue / maxRevenue) * 100),
        }));
    }
    // ==================== PRODUCTS LIST (cached) ====================
    async getAllVendorProducts(skip = 0, limit = 20) {
        const page = Math.floor(skip / limit) + 1;
        const vendorWhere = { vendorId: this.vendorId };
        const cacheKey = `vendor:${this.vendorId}:products:page:${page}:limit:${limit}`;
        const cached = await redis_1.redisProducts.get(cacheKey);
        let totalCount;
        let productsData;
        if (cached) {
            const parsed = JSON.parse(cached);
            totalCount = parsed.total;
            productsData = parsed.products;
        }
        else {
            totalCount = await prisma.product.count({ where: vendorWhere });
            const products = await prisma.product.findMany({
                where: vendorWhere,
                skip,
                take: limit,
                orderBy: { createdAt: "desc" },
                select: {
                    id: true,
                    name: true,
                    price: true,
                    category: true,
                    thumbnail: true,
                    images: true,
                    archived: true,
                    popularityPercent: true,
                    productSchedule: { select: { goLiveAt: true, takeDownAt: true, graceMinutes: true } },
                    reviews: { select: { rating: true } },
                },
            });
            productsData = products.map((p) => ({
                id: p.id,
                name: p.name,
                price: p.price,
                category: p.category,
                images: p.thumbnail ? [p.thumbnail] : p.images.length > 0 ? [p.images[0]] : [],
                popularityPercent: p.popularityPercent,
                archived: p.archived,
                averageRating: p.reviews.length > 0 ? p.reviews.reduce((sum, r) => sum + r.rating, 0) / p.reviews.length : null,
                reviewCount: p.reviews.length,
                productSchedule: p.productSchedule || null,
            }));
            await redis_1.redisProducts.set(cacheKey, JSON.stringify({ products: productsData, total: totalCount }), {
                EX: 60 * 5,
            });
        }
        const computeIsLive = (goLiveAt, liveUntil, graceMinutes) => {
            if (!goLiveAt || !liveUntil)
                return false;
            const now = Date.now();
            const grace = (graceMinutes ?? 0) * 60_000;
            return now >= new Date(goLiveAt).getTime() && now <= new Date(liveUntil).getTime() + grace;
        };
        const formattedProducts = productsData
            .map((p) => ({
            ...p,
            isLive: computeIsLive(p.productSchedule?.goLiveAt || null, p.productSchedule?.takeDownAt || null, p.productSchedule?.graceMinutes || 0),
        }))
            .sort((a, b) => Number(b.isLive) - Number(a.isLive));
        const pagination = {
            total: totalCount,
            page,
            limit,
            totalPages: Math.ceil(totalCount / limit),
            hasNextPage: skip + limit < totalCount,
            hasPreviousPage: skip > 0,
        };
        return { products: formattedProducts, pagination };
    }
    // ==================== RECENT ACTIVITY (✅ fixed sorting + complete map) ====================
    async getRecentActivity() {
        const thirtyDaysAgo = (0, date_fns_1.subDays)(new Date(), 30);
        const [recentOrders, recentVendorReviews] = await Promise.all([
            prisma.order.findMany({
                where: { vendorId: this.vendorId, createdAt: { gte: thirtyDaysAgo } },
                orderBy: { createdAt: "desc" },
                take: 10,
                include: { customer: { select: { name: true } } },
            }),
            prisma.vendorReview.findMany({
                where: { vendorId: this.vendorId, createdAt: { gte: thirtyDaysAgo } },
                orderBy: { createdAt: "desc" },
                take: 5,
                include: { customer: { select: { name: true } } },
            }),
        ]);
        const statusMap = {
            [client_1.OrderStatus.PENDING]: { icon: "pending", color: "amber", action: "placed" },
            [client_1.OrderStatus.WAITING_VENDOR_CONFIRMATION]: {
                icon: "hourglass_empty",
                color: "amber",
                action: "waiting for vendor confirmation",
            },
            [client_1.OrderStatus.WAITING_CUSTOMER_APPROVAL]: {
                icon: "person",
                color: "purple",
                action: "awaiting customer approval",
            },
            [client_1.OrderStatus.AWAITING_PAYMENT]: { icon: "payment", color: "blue", action: "awaiting payment" },
            [client_1.OrderStatus.PAYMENT_CONFIRMED]: { icon: "check_circle", color: "green", action: "payment confirmed" },
            [client_1.OrderStatus.COOKING]: { icon: "restaurant", color: "blue", action: "started cooking" },
            [client_1.OrderStatus.READY_FOR_PICKUP]: { icon: "local_shipping", color: "blue", action: "ready for pickup" },
            [client_1.OrderStatus.OUT_FOR_DELIVERY]: { icon: "delivery_dining", color: "blue", action: "out for delivery" },
            [client_1.OrderStatus.COMPLETED]: { icon: "check_circle", color: "green", action: "completed" },
            [client_1.OrderStatus.CANCELLED]: { icon: "cancel", color: "red", action: "cancelled" },
            [client_1.OrderStatus.FAILED_DELIVERY]: { icon: "error", color: "red", action: "failed delivery" },
            [client_1.OrderStatus.PAYMENT_EXPIRED]: { icon: "timer_off", color: "red", action: "payment expired" },
            [client_1.OrderStatus.CANCELLED_UNPAID]: { icon: "cancel", color: "red", action: "cancelled (unpaid)" },
        };
        const orderActivities = recentOrders.map((order) => {
            const statusInfo = statusMap[order.status] || { icon: "notifications", color: "blue", action: "updated" };
            return {
                id: order.id,
                icon: statusInfo.icon,
                iconColor: statusInfo.color,
                title: `Order ${statusInfo.action}`,
                subtitle: (0, date_fns_1.format)(order.createdAt, "hh:mm a"),
                createdAt: order.createdAt, // ✅ used for sorting
                description: order.customer?.name
                    ? `${order.customer.name} – N${Number(order.totalPrice).toFixed(2)}`
                    : `Order #${order.id.slice(-6)} – N${Number(order.totalPrice).toFixed(2)}`,
            };
        });
        const reviewActivities = recentVendorReviews.map((review) => ({
            id: review.id,
            icon: "star",
            iconColor: "amber",
            title: "New review received",
            subtitle: (0, date_fns_1.format)(review.createdAt, "hh:mm a"),
            createdAt: review.createdAt, // ✅ used for sorting
            description: `${review.customer?.name || "Customer"} rated ${review.rating} stars`,
        }));
        const allActivities = [...orderActivities, ...reviewActivities]
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()) // ✅ correct sort
            .slice(0, 10)
            .map(({ createdAt, ...rest }) => rest); // optional: remove createdAt from payload
        return allActivities;
    }
    // ==================== PRODUCT LIVE CONTROL (✅ insights revenue now Payment-based) ====================
    async getProductLiveControl() {
        const products = await prisma.product.findMany({
            where: { vendorId: this.vendorId, archived: false },
            include: {
                productSchedule: true,
            },
            orderBy: { isLive: "desc" },
            take: 3,
        });
        const sevenDaysAgo = (0, date_fns_1.subDays)(new Date(), 7);
        const totalInsightsValue = await this.sumSuccessfulPaymentsInRange(sevenDaysAgo, new Date());
        return {
            products: products.map((product) => {
                const price = `N${Number(product.price).toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                })}`;
                return {
                    id: product.id,
                    name: product.name,
                    price,
                    status: product.isLive ? "LIVE" : "OFFLINE",
                    statusColor: product.isLive ? "green" : "red",
                };
            }),
            totalInsights: `N${Number(totalInsightsValue).toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
            })}`,
        };
    }
    // ==================== ANALYTICS ====================
    async getAnalytics() {
        const [peakHours, customerReturnRate, orderValueStats, productAnalytics] = await Promise.all([
            this.getPeakHours(),
            this.getCustomerReturnRate(),
            this.getOrderValueStats(),
            this.getProductAnalytics(),
        ]);
        return { peakHours, customerReturnRate, orderValueStats, productAnalytics };
    }
    async getPeakHours() {
        const thirtyDaysAgo = (0, date_fns_1.subDays)(new Date(), 30);
        const orders = await prisma.order.findMany({
            where: {
                vendorId: this.vendorId,
                status: client_1.OrderStatus.COMPLETED,
                createdAt: { gte: thirtyDaysAgo },
            },
            select: { createdAt: true },
        });
        const hourCount = Array(24).fill(0);
        orders.forEach((order) => {
            hourCount[order.createdAt.getHours()]++;
        });
        const maxCount = Math.max(...hourCount, 0);
        const peakHours = hourCount
            .map((count, hour) => ({ hour, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 3)
            .map((item) => `${item.hour}:00`);
        return { peakHours, maxCount };
    }
    async getCustomerReturnRate() {
        const orders = await prisma.order.findMany({
            where: { vendorId: this.vendorId, status: client_1.OrderStatus.COMPLETED },
            select: { customerId: true },
        });
        const customerOrderMap = orders.reduce((acc, order) => {
            acc[order.customerId] = (acc[order.customerId] || 0) + 1;
            return acc;
        }, {});
        const totalCustomers = Object.keys(customerOrderMap).length;
        const returningCustomers = Object.values(customerOrderMap).filter((count) => count > 1).length;
        return totalCustomers === 0 ? 0 : Math.round((returningCustomers / totalCustomers) * 100);
    }
    async getOrderValueStats() {
        const thirtyDaysAgo = (0, date_fns_1.subDays)(new Date(), 30);
        const orders = await prisma.order.findMany({
            where: {
                vendorId: this.vendorId,
                status: client_1.OrderStatus.COMPLETED,
                createdAt: { gte: thirtyDaysAgo },
            },
            select: { totalPrice: true },
        });
        const orderValues = orders.map((o) => Number(o.totalPrice));
        const average = orderValues.length > 0 ? orderValues.reduce((a, b) => a + b, 0) / orderValues.length : 0;
        const min = orderValues.length > 0 ? Math.min(...orderValues) : 0;
        const max = orderValues.length > 0 ? Math.max(...orderValues) : 0;
        return {
            average: Math.round(average * 100) / 100,
            min: Math.round(min * 100) / 100,
            max: Math.round(max * 100) / 100,
            totalOrders: orderValues.length,
        };
    }
    async getProductAnalytics() {
        const products = await prisma.product.findMany({
            where: { vendorId: this.vendorId, archived: false },
            include: {
                reviews: { select: { rating: true } },
                orderItems: {
                    where: { order: { status: client_1.OrderStatus.COMPLETED } },
                    select: { subtotal: true },
                },
            },
        });
        const totalProducts = products.length;
        const liveProducts = products.filter((p) => p.isLive).length;
        const productsWithReviews = products.filter((p) => p.reviews.length > 0).length;
        const totalRevenue = products.reduce((sum, p) => sum + p.orderItems.reduce((s, item) => s + item.subtotal, 0), 0);
        return {
            totalProducts,
            liveProducts,
            percentageLive: totalProducts > 0 ? Math.round((liveProducts / totalProducts) * 100) : 0,
            productsWithReviews,
            percentageReviewed: totalProducts > 0 ? Math.round((productsWithReviews / totalProducts) * 100) : 0,
            averageRating: await this.getAverageVendorRating(),
            totalRevenue: Math.round(totalRevenue * 100) / 100,
        };
    }
    // ==================== HELPERS ====================
    formatNumber(num) {
        if (num >= 1_000_000)
            return (num / 1_000_000).toFixed(1) + "M";
        if (num >= 1_000)
            return (num / 1_000).toFixed(1) + "k";
        return num.toFixed(0);
    }
    calculateGrowthPercentage(current, previous) {
        if (previous === 0 && current === 0)
            return null;
        if (previous === 0)
            return 100;
        if (current === 0)
            return -100;
        const growth = ((current - previous) / previous) * 100;
        if (growth > 1000)
            return 1000;
        if (growth < -100)
            return -100;
        return Math.round(growth * 10) / 10;
    }
    // ==================== CACHE INVALIDATION ====================
    async invalidateCache() {
        await (0, clearCaches_1.clearProductCache)(undefined, this.vendorId);
    }
    async invalidateProductCache(productId) {
        await (0, clearCaches_1.clearProductCache)(productId, this.vendorId);
    }
}
exports.VendorDashboardService = VendorDashboardService;
