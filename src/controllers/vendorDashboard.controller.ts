// src/controllers/vendorDashboard.controller.ts
import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import { VendorDashboardService } from "./vendorDashboard.service";

interface ApiResponse<T> {
  status: boolean;
  message: string;
  data: T | null;
}

export class DashboardController {
  // Main dashboard endpoint - returns all data needed for the dashboard
  async getDashboardData(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      const data = await service.getDashboardSummary();

      return res.status(200).json({ 
        status: true, 
        message: "Dashboard data loaded successfully", 
        data 
      });
    } catch (error) {
      console.error("Error in getDashboardData:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to load dashboard data", 
        data: null 
      });
    }
  }

  // Analytics endpoint
  async getAnalytics(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      const data = await service.getAnalytics();

      return res.status(200).json({ 
        status: true, 
        message: "Analytics loaded successfully", 
        data 
      });
    } catch (error) {
      console.error("Error in getAnalytics:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to load analytics", 
        data: null 
      });
    }
  }

  // Revenue overview for chart
  async getRevenueOverview(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      const data = await service.getRevenueOverview();

      return res.status(200).json({ 
        status: true, 
        message: "Revenue overview loaded", 
        data 
      });
    } catch (error) {
      console.error("Error in getRevenueOverview:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to load revenue overview", 
        data: null 
      });
    }
  }

  // Product performance
  async getProductPerformance(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      const data = await service.getProductPerformance();

      return res.status(200).json({ 
        status: true, 
        message: "Product performance loaded", 
        data 
      });
    } catch (error) {
      console.error("Error in getProductPerformance:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to load product performance", 
        data: null 
      });
    }
  }

  // Recent activity
  async getRecentActivity(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      const data = await service.getRecentActivity();

      return res.status(200).json({ 
        status: true, 
        message: "Recent activity loaded", 
        data 
      });
    } catch (error) {
      console.error("Error in getRecentActivity:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to load recent activity", 
        data: null 
      });
    }
  }

  // Product live control
  async getProductLiveControl(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      const data = await service.getProductLiveControl();

      return res.status(200).json({ 
        status: true, 
        message: "Product live control loaded", 
        data 
      });
    } catch (error) {
      console.error("Error in getProductLiveControl:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to load product live control", 
        data: null 
      });
    }
  }

  // Get all vendor products with pagination (keep this as it was working)
  async getAllVendorProducts(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          code: "UNAUTHORIZED",
          message: "Unauthorized",
          data: null
        });
      }

      // Get query parameters
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      // Create service instance
      const service = new VendorDashboardService(req.user.id);
      
      // Get products with pagination
      const result = await service.getAllVendorProducts(skip, limit);

      return res.status(200).json({
        success: true,
        code: "PRODUCT_LIST",
        message: "Products fetched successfully",
        data: result.products,
        pagination: {
          total: result.pagination.total,
          page: page,
          limit: limit,
          totalPages: result.pagination.totalPages
        }
      });
    } catch (error) {
      console.error("Error in getAllVendorProducts:", error);
      return res.status(500).json({
        success: false,
        code: "SERVER_ERROR",
        message: "Failed to load vendor products",
        data: null
      });
    }
  }

  // Clear vendor cache
  async clearVendorCache(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      await service.invalidateCache();

      return res.status(200).json({ 
        status: true, 
        message: "Vendor cache cleared successfully", 
        data: null 
      });
    } catch (error) {
      console.error("Error in clearVendorCache:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to clear cache", 
        data: null 
      });
    }
  }

  // ====== DEPRECATED ENDPOINTS (for backward compatibility) ======
  
  // Old summary endpoint (kept for backward compatibility)
  async getSummary(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      const data = await service.getDashboardSummary();

      return res.status(200).json({ 
        status: true, 
        message: "Summary loaded successfully", 
        data 
      });
    } catch (error) {
      console.error("Error in getSummary:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to load summary", 
        data: null 
      });
    }
  }

  // Old live products endpoint
  async getLiveProducts(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      const data = await service.getProductPerformance();

      return res.status(200).json({ 
        status: true, 
        message: "Live products loaded", 
        data 
      });
    } catch (error) {
      console.error("Error in getLiveProducts:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to load live products", 
        data: null 
      });
    }
  }

  // Old total products endpoint
  async getTotalProducts(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      const data = await service.getAllVendorProducts(0, 5); // Get first 5 products

      return res.status(200).json({ 
        status: true, 
        message: "Total products loaded", 
        data: data.products 
      });
    } catch (error) {
      console.error("Error in getTotalProducts:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to load total products", 
        data: null 
      });
    }
  }

  // Old recent orders endpoint - you'll need to add this method to VendorDashboardService
  async getRecentOrders(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      const data = await this.getRecentOrdersFromService(service);

      return res.status(200).json({ 
        status: true, 
        message: "Recent orders loaded", 
        data 
      });
    } catch (error) {
      console.error("Error in getRecentOrders:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to load recent orders", 
        data: null 
      });
    }
  }

  // Old revenue chart endpoint
  async getRevenueChart(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      const data = await service.getRevenueOverview();

      return res.status(200).json({ 
        status: true, 
        message: "Revenue chart loaded", 
        data 
      });
    } catch (error) {
      console.error("Error in getRevenueChart:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to load revenue chart", 
        data: null 
      });
    }
  }

  // Old average order value endpoint
  async getAverageOrderValue(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      const analytics = await service.getAnalytics();
      const data = analytics.orderValueStats?.average || 0;

      return res.status(200).json({ 
        status: true, 
        message: "Average order value loaded", 
        data 
      });
    } catch (error) {
      console.error("Error in getAverageOrderValue:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to load average order value", 
        data: null 
      });
    }
  }

  // Old customer return rate endpoint
  async getCustomerReturnRate(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      const analytics = await service.getAnalytics();
      const data = analytics.customerReturnRate || 0;

      return res.status(200).json({ 
        status: true, 
        message: "Customer return rate loaded", 
        data 
      });
    } catch (error) {
      console.error("Error in getCustomerReturnRate:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to load customer return rate", 
        data: null 
      });
    }
  }

  // Old peak hours endpoint
  async getPeakHours(req: AuthRequest, res: Response<ApiResponse<any>>) {
    try {
      if (!req.user) return res.status(401).json({ status: false, message: "Unauthorized", data: null });

      const service = new VendorDashboardService(req.user.id);
      const analytics = await service.getAnalytics();
      const data = analytics.peakHours || { peakHours: [], maxCount: 0 };

      return res.status(200).json({ 
        status: true, 
        message: "Peak hours loaded", 
        data 
      });
    } catch (error) {
      console.error("Error in getPeakHours:", error);
      return res.status(500).json({ 
        status: false, 
        message: "Failed to load peak hours", 
        data: null 
      });
    }
  }

  // Helper method to get recent orders
  private async getRecentOrdersFromService(service: VendorDashboardService) {
    // You can add this method to VendorDashboardService if needed
    // For now, returning mock data or implement with Prisma
    return [];
  }
}

export const dashboardController = new DashboardController();