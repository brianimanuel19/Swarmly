import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/config.js';

export interface AuthRequest extends Request {
  user?: {
    workspaceId: string;
    userId: string;
  };
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or malformed Authorization header. Expected: Bearer <token>',
    });
    return;
  }

  const token = authHeader.slice(7); // Remove "Bearer " prefix

  try {
    const decoded = jwt.verify(token, config.dashboard.jwtSecret) as {
      workspaceId: string;
      userId: string;
    };

    req.user = {
      workspaceId: decoded.workspaceId,
      userId: decoded.userId,
    };

    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Token has expired',
      });
    } else if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token',
      });
    } else {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Token verification failed',
      });
    }
  }
}

export function generateToken(payload: { workspaceId: string; userId: string }): string {
  return jwt.sign(payload, config.dashboard.jwtSecret, {
    expiresIn: '24h',
  });
}
