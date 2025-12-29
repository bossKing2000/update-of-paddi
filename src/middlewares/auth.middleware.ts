import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config/config';
import { getUserSession } from '../lib/session';

// Combined interface: supports user + multer file handling
export interface AuthRequest extends Request {
  
  user?: {id: string; role: string; name: string; email: string;};
  file?: Express.Multer.File;
  files?: Express.Multer.File[] | { [fieldname: string]: Express.Multer.File[] };
}

// ✅ Middleware: Authenticate JWT + verify active session in Redis
export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authReq = req as AuthRequest;
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ message: 'No token provided' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    // Decode and verify token
    const decoded = jwt.verify(token, config.jwtSecret) as {
      id: string;
      role: string;
      name: string;
      email: string;
    };

    // Check if user session exists in Redis (optional but good for logout tracking)
    const session = await getUserSession(decoded.id);
    if (!session) {
      res.status(401).json({ message: 'Session expired or not found. Please log in again.' });
      return;
    }

    // Attach user to request
    authReq.user = {
      id: decoded.id,
      role: decoded.role,
      name: decoded.name,
      email: decoded.email,
    };

    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(401).json({ message: 'Invalid or expired token' });
  }
};


// ✅ Middleware: Only allow vendors
export const authorizeVendor = (req: Request, res: Response, next: NextFunction): void => {
  const authReq = req as AuthRequest;

  if (authReq.user?.role !== 'VENDOR') {
    res.status(403).json({ message: 'Access denied: vendors only' });
    return;
  }

  next();
};

export const authorizeCustomer = (req: Request, res: Response, next: NextFunction): void => {
  const authReq = req as AuthRequest;

  if (authReq.user?.role !== 'CUSTOMER') {
    res.status(403).json({ message: 'Access denied: Customers only' });
    return;
  }

  next();
};

export const authorizeDeliveryPerson = (req: Request, res: Response, next: NextFunction): void => {
  const authReq = req as AuthRequest;
  console.log("Delivery auth check -> req.user:", authReq.user);
  if (authReq.user?.role !== 'DELIVERY') {
    res.status(403).json({ message: 'Access denied: Delivery persons only' });
    return;
  }
  next();
};
