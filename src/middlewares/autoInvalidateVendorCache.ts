// src/middlewares/autoInvalidateVendorCache.ts
import { Request, Response, NextFunction } from "express";
import { VendorCache } from "../services/vendorcacheService";

export const autoInvalidateVendorCache = (req: Request, res: Response, next: NextFunction) => {
  // Store original send function
  const originalSend = res.send;
  
  // Override send function
  res.send = function(body: any) {
    // Type assertion to access req.user
    const user = (req as any).user;
    
    // Check if this is a product modification request
    const isProductModification = 
      req.method === 'POST' || 
      req.method === 'PUT' || 
      req.method === 'PATCH' || 
      req.method === 'DELETE';
     
    const isProductRoute = 
      req.path.includes('/products') && 
      !req.path.includes('/products/all'); // Don't invalidate on GET requests
    
    if (isProductModification && isProductRoute && user) {
      // Invalidate this vendor's cache in the background
      VendorCache.invalidateVendorCache(user.id)
        .then(() => {
          console.log(`🔄 [AUTO CACHE] Invalidated cache for vendor ${user.id} after ${req.method} ${req.path}`);
        })
        .catch(err => {
          console.error(`[AUTO CACHE] Failed to invalidate:`, err);
        });
    }
    
    // Call original send function
    return originalSend.call(this, body);
  };
  
  next();
};