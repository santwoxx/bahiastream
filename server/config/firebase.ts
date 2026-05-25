import * as admin from 'firebase-admin';

let adminApp: admin.app.App | null = null;

export function getFirebaseAdmin(): admin.app.App | null {
  if (adminApp) {
    return adminApp;
  }

  // 1. Try to load service account credentials from environmental Base64
  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64) {
    try {
      const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
      const cert = JSON.parse(jsonStr);
      adminApp = admin.initializeApp({
        credential: admin.credential.cert(cert)
      });
      console.log('[Firebase Admin] Successfully initialized via Base64 Credentials.');
      return adminApp;
    } catch (err) {
      console.error('[Firebase Admin] Error decoding/initializing with custom Base64 credentials:', err);
    }
  }

  // 2. Try to initialize using default credentials (perfect for Cloud Run / Google App contexts)
  try {
    adminApp = admin.initializeApp();
    console.log('[Firebase Admin] Successfully initialized with Google ADC (App Default Credentials).');
    return adminApp;
  } catch (err: any) {
    console.warn('[Firebase Admin] Application Default Credentials load skipped. Mode: Safe Developer Fallback.', err.message);
  }

  return null;
}

export function isFirebaseAdminInitialized(): boolean {
  return getFirebaseAdmin() !== null;
}
