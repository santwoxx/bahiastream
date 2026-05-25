import { Request, Response, NextFunction } from 'express';

interface RateLimitInfo {
  count: number;
  resetTime: number;
}

const WINDOW_MS = 60 * 1000; // 1 minute window
const MAX_LIMIT = 100; // 100 requests per minute
const ipLimits = new Map<string, RateLimitInfo>();

export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = (req.headers['x-forwarded-for'] as string) || req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  
  let limitInfo = ipLimits.get(ip);
  
  if (!limitInfo || now > limitInfo.resetTime) {
    limitInfo = {
      count: 1,
      resetTime: now + WINDOW_MS
    };
    ipLimits.set(ip, limitInfo);
    next();
    return;
  }
  
  if (limitInfo.count >= MAX_LIMIT) {
    res.status(429).json({
      error: 'Many requests from this IP. Please try again after a minute.',
      retryAfterSeconds: Math.ceil((limitInfo.resetTime - now) / 1000)
    });
    return;
  }
  
  limitInfo.count++;
  next();
}
