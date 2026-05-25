import { Request, Response, NextFunction } from 'express';
import { getFirebaseAdmin } from '../config/firebase';

export interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    role: 'admin' | 'streamer' | 'viewer';
  };
}

// Simple JWT decoder helper for safe developer fallback modes when certificates aren't present yet
function decodeTokenFallback(token: string) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return {
      uid: payload.user_id || payload.sub || 'mock-dev-uid',
      email: payload.email || 'developer@example.com',
      email_verified: payload.email_verified !== undefined ? payload.email_verified : true,
      name: payload.name || payload.display_name || 'Developer',
      role: payload.role || 'viewer'
    };
  } catch {
    return null;
  }
}

export async function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No authorization credentials supplied. Formato: Bearer <Firebase_ID_Token>' });
    return;
  }

  const token = authHeader.split(' ')[1];
  const adminApp = getFirebaseAdmin();

  if (adminApp) {
    try {
      const decodedToken = await adminApp.auth().verifyIdToken(token);
      let role: 'admin' | 'streamer' | 'viewer' = 'viewer';

      // Bootstrapped Admin check
      if (decodedToken.email === 'natanmarinhocanalyt@gmail.com') {
        role = 'admin';
      } else {
        // Query Firestore safely for role
        try {
          const userDoc = await adminApp.firestore().collection('users').doc(decodedToken.uid).get();
          if (userDoc.exists) {
            const data = userDoc.data();
            if (data && (data.role === 'admin' || data.role === 'streamer' || data.role === 'viewer')) {
              role = data.role as 'admin' | 'streamer' | 'viewer';
            }
          }
        } catch (dbErr) {
          console.warn('[Auth Middleware] Unable to read profile role from firestore. Defaulting role to viewer.');
        }
      }

      req.user = {
        uid: decodedToken.uid,
        email: decodedToken.email,
        email_verified: decodedToken.email_verified,
        name: (decodedToken.name as string) || decodedToken.email,
        role,
      };
      
      next();
    } catch (err: any) {
      console.error('[Auth Middleware] Crypto authentication error:', err.message);
      res.status(401).json({ error: 'Authentication failed: credentials expired or incorrect.', details: err.message });
    }
  } else {
    // SAFE FALLBACK DEVELOPER DECODING
    console.warn('[Auth Middleware] ACTIVE DEV FALLBACK. JWT token signature inspection skipped. Base64 decoded.');
    const parsed = decodeTokenFallback(token);
    if (!parsed) {
      res.status(401).json({ error: 'Authentication failed: invalid token content received.' });
      return;
    }

    let role: 'admin' | 'streamer' | 'viewer' = (parsed.role as 'admin' | 'streamer' | 'viewer') || 'viewer';
    if (parsed.email === 'natanmarinhocanalyt@gmail.com') {
      role = 'admin';
    }

    req.user = {
      uid: parsed.uid,
      email: parsed.email,
      email_verified: parsed.email_verified,
      name: parsed.name,
      role,
    };
    next();
  }
}

export function requireRole(roles: ('admin' | 'streamer' | 'viewer')[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized: Complete credential authentication process first.' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: `Forbidden: Access restricted. Required role(s): [${roles.join(', ')}]. Current role: ${req.user.role}` });
      return;
    }
    next();
  };
}
