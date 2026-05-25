import { Router } from 'express';
import { PaymentController } from '../controllers/paymentController';
import { StreamController } from '../controllers/streamController';
import { authMiddleware, requireRole } from '../middlewares/auth';
import { rateLimiter } from '../middlewares/rateLimiter';
import { getFirebaseAdmin } from '../config/firebase';

const router = Router();

/**
 * Clean health checking with detailed status parameters.
 * Highly compliant with UptimeRobot monitoring cycles.
 */
router.get('/health', async (req, res) => {
  const statusInfo: any = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptimeSeconds: process.uptime(),
    framework: 'React + Node + Express + Socket.IO + WebRTC',
    firebaseAdminReady: false,
    environment: process.env.NODE_ENV || 'production'
  };

  const adminApp = getFirebaseAdmin();
  if (adminApp) {
    statusInfo.firebaseAdminReady = true;
    try {
      const db = adminApp.firestore();
      // Test firestore read request asynchronously
      await db.collection('test_connection').limit(1).get();
      statusInfo.database = 'connected';
    } catch (err: any) {
      statusInfo.database = 'partially_degraded';
      statusInfo.databaseError = err.message;
      statusInfo.status = 'warning';
    }
  } else {
    statusInfo.database = 'dev_memory_fallback';
  }

  res.status(statusInfo.status === 'healthy' ? 200 : 200).json(statusInfo);
});

// Payments & Balance Ledgers
router.post('/payments/create-pix', rateLimiter, PaymentController.createPixPayment);
router.post('/payments/webhook', PaymentController.handleWebhook);
router.post('/payments', authMiddleware, rateLimiter, PaymentController.createPayment);
router.post('/payments/:paymentId/approve', authMiddleware, requireRole(['admin']), PaymentController.approvePayment);
router.post('/payments/:paymentId/reject', authMiddleware, requireRole(['admin']), PaymentController.rejectPayment);

router.post('/withdrawals', authMiddleware, requireRole(['streamer', 'admin']), rateLimiter, PaymentController.createWithdrawalRequest);
router.post('/withdrawals/:requestId/approve', authMiddleware, requireRole(['admin']), PaymentController.approveWithdrawal);
router.post('/withdrawals/:requestId/reject', authMiddleware, requireRole(['admin']), PaymentController.rejectWithdrawal);

router.get('/transactions/me', authMiddleware, PaymentController.getMyTransactions);
router.get('/balance/me', authMiddleware, PaymentController.getBalance);

// Room Lifecycles & Streaming Authority
router.post('/rooms', authMiddleware, requireRole(['viewer', 'streamer', 'admin']), StreamController.createRoom);
router.get('/rooms', authMiddleware, StreamController.listRooms);
router.delete('/rooms/:roomId', authMiddleware, StreamController.deactivateRoom);
router.get('/rooms/:roomId/access', authMiddleware, StreamController.checkAccess);

// Public endpoints for unregistered guests on the landing page
router.get('/landing/rooms', StreamController.listLandingRooms);
router.post('/payments-guest', rateLimiter, PaymentController.createGuestPayment);
router.get('/rooms/:roomId/access-guest', PaymentController.checkGuestAccess);

export default router;
