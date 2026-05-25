import { Request, Response } from 'express';
import * as admin from 'firebase-admin';
import { AuthenticatedRequest } from '../middlewares/auth';
import { getFirebaseAdmin } from '../config/firebase';
import { mockRooms } from './streamController';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { activeIo } from '../sockets/signaling';

let mpClient: MercadoPagoConfig | null = null;
let mpPaymentInstance: Payment | null = null;

function getMercadoPago() {
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN || 'APP_USR-3060719903206819-052323-10c202b6048103cee9190b9cd1653f59-1412971336';
  if (!token || token.includes('MY_API_KEY')) {
    return null;
  }
  try {
    if (!mpClient) {
      mpClient = new MercadoPagoConfig({ accessToken: token });
      mpPaymentInstance = new Payment(mpClient);
    }
    return mpPaymentInstance;
  } catch (err) {
    console.error('[MercadoPago] Error initializing client:', err);
    return null;
  }
}

// Local memory mock DB for developer fallback (signature requirement of our senior architecture)
let mockPayments: any[] = [];
let mockWithdrawals: any[] = [];
let mockTransactions: any[] = [];
const mockUsers = new Map<string, { uid: string; email: string; displayName: string; role: string; balance: number; pixKey?: string }>();

export class PaymentController {
  /**
   * Submit manual payment evidence for Admin approval
   */
  static async createPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { streamerId, amount, roomId } = req.body;
    if (!req.user) {
      res.status(401).json({ error: 'Auth context required' });
      return;
    }
    
    if (!streamerId || !amount || parseFloat(amount) <= 0) {
      res.status(400).json({ error: 'Atributos streamerId e amount válidos são obrigatórios.' });
      return;
    }

    const valueAmount = parseFloat(amount);
    const platformFee = parseFloat((valueAmount * 0.50).toFixed(2)); // 50% platform rake fee
    const streamerFee = parseFloat((valueAmount - platformFee).toFixed(2)); // 50% goes to streamer

    const paymentId = 'pay_' + Math.random().toString(36).substring(2, 11);
    const newPayment = {
      id: paymentId,
      payerId: req.user.uid,
      streamerId,
      amount: valueAmount,
      platformFee,
      streamerFee,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    const adminApp = getFirebaseAdmin();
    if (adminApp) {
      try {
        const db = adminApp.firestore();
        // Check if streamer user exists
        const streamerSnap = await db.collection('users').doc(streamerId).get();
        if (!streamerSnap.exists) {
          res.status(404).json({ error: 'Streamer destino não encontrado no banco.' });
          return;
        }

        // Determine final roomId
        let finalRoomId = roomId;
        if (!finalRoomId) {
          const activeRoomSnap = await db.collection('rooms')
            .where('streamerId', '==', streamerId)
            .where('status', '==', 'active')
            .limit(1)
            .get();
          if (!activeRoomSnap.empty) {
            finalRoomId = activeRoomSnap.docs[0].id;
          } else {
            finalRoomId = `room_${streamerId}`;
          }
        }

        // Store payment & roomAccess inside a batch
        const batch = db.batch();
        const payRef = db.collection('payments').doc(paymentId);
        const accessRef = db.collection('roomAccess').doc(paymentId);

        batch.set(payRef, {
          ...newPayment,
          createdAt: admin.firestore.Timestamp.now()
        });

        batch.set(accessRef, {
          id: paymentId,
          roomId: finalRoomId,
          userId: req.user.uid,
          streamerId,
          status: 'pending',
          createdAt: admin.firestore.Timestamp.now()
        });

        await batch.commit();

        res.status(201).json({ message: 'Comprovante pix enviado com sucesso. Aguardando aprovação do admin.', payment: newPayment });
        return;
      } catch (err: any) {
        res.status(500).json({ error: 'Erro de banco de dados do Firestore.', details: err.message });
        return;
      }
    } else {
      // Fallback
      mockPayments.push(newPayment);
      res.status(201).json({
        message: '[MODO INTUITIVO DEV] Comprovante Pix mocado na memória do servidor.',
        payment: newPayment
      });
    }
  }

  /**
   * Admin-Only: Approve manual payment and allocate balance
   */
  static async approvePayment(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { paymentId } = req.params;
    const adminApp = getFirebaseAdmin();

    if (adminApp) {
      try {
        const db = adminApp.firestore();
        const payRef = db.collection('payments').doc(paymentId);
        const paySnap = await payRef.get();

        if (!paySnap.exists) {
          res.status(404).json({ error: 'Pagamento não localizado.' });
          return;
        }

        const payment = paySnap.data();
        if (!payment || payment.status !== 'pending') {
          res.status(400).json({ error: 'Pagamento já processado ou em estado inválido para aprovações.' });
          return;
        }

        // Perform transactional update
        const streamerId = payment.streamerId;
        const streamerRef = db.collection('users').doc(streamerId);
        const adminId = req.user!.uid;
        const adminRef = db.collection('users').doc(adminId);

        await db.runTransaction(async (transaction) => {
          const streamerSnap = await transaction.get(streamerRef);
          if (!streamerSnap.exists) {
            throw new Error('Streamer destino da remessa não existe.');
          }

          const currentBalance = streamerSnap.data()?.balance || 0;
          const newBalance = parseFloat((currentBalance + payment.streamerFee).toFixed(2));

          // Try to get admin data
          const adminSnap = await transaction.get(adminRef);
          if (adminSnap.exists) {
            const currentAdminBalance = adminSnap.data()?.balance || 0;
            const newAdminBalance = parseFloat((currentAdminBalance + payment.platformFee).toFixed(2));
            transaction.update(adminRef, { balance: newAdminBalance });
          } else {
            // Self-heal: If admin profile doesn't exist yet, construct it
            transaction.set(adminRef, {
              uid: adminId,
              displayName: req.user!.name || 'Administrador',
              email: req.user!.email || '',
              role: 'admin',
              balance: payment.platformFee,
              createdAt: admin.firestore.Timestamp.now()
            });
          }

          // 1. Update Payment status
          transaction.update(payRef, { status: 'approved' });

          // 2. Add streamer balance
          transaction.update(streamerRef, { balance: newBalance });

          // 3. Update roomAccess status if it exists
          const accessRef = db.collection('roomAccess').doc(paymentId);
          const accessSnap = await transaction.get(accessRef);
          if (accessSnap.exists) {
            transaction.update(accessRef, { status: 'approved' });
          }

          // 4. Write Transaction audit logs
          const txId = 'tx_' + Math.random().toString(36).substring(2, 11);
          const txRef = db.collection('transactions').doc(txId);
          transaction.set(txRef, {
            userId: streamerId,
            type: 'credit',
            amount: payment.streamerFee,
            referenceId: paymentId,
            createdAt: admin.firestore.Timestamp.now()
          });

          // Admin commission log entry
          const adminTxId = 'tx_admin_' + Math.random().toString(36).substring(2, 11);
          const adminTxRef = db.collection('transactions').doc(adminTxId);
          transaction.set(adminTxRef, {
            userId: adminId,
            type: 'platform_fee',
            amount: payment.platformFee,
            referenceId: paymentId,
            createdAt: admin.firestore.Timestamp.now()
          });
        });

        res.json({ message: 'Pagamento aprovado. Saldo creditado e taxa de 50% distribuída ao dono/admin.' });
        return;
      } catch (err: any) {
        res.status(500).json({ error: 'Falha ao processar transação financeira do Firestore.', details: err.message });
        return;
      }
    } else {
      // Fallback in memory
      const paymentIndex = mockPayments.findIndex(p => p.id === paymentId);
      if (paymentIndex === -1) {
        res.status(404).json({ error: 'Pagamento não localizado em memória.' });
        return;
      }

      const p = mockPayments[paymentIndex];
      if (p.status !== 'pending') {
        res.status(400).json({ error: 'Pagamento já processado.' });
        return;
      }

      p.status = 'approved';
      
      // Update or create streamer account
      if (!mockUsers.has(p.streamerId)) {
        mockUsers.set(p.streamerId, { uid: p.streamerId, displayName: 'Streamer Mocado', email: 'streamer@mock.com', role: 'streamer', balance: 0 });
      }
      const st = mockUsers.get(p.streamerId)!;
      st.balance = parseFloat((st.balance + p.streamerFee).toFixed(2));

      // Crediting platform fee of 50% to Admin
      const adminId = req.user!.uid;
      if (!mockUsers.has(adminId)) {
        mockUsers.set(adminId, { uid: adminId, displayName: req.user!.name || 'Admin Mocado', email: req.user!.email || 'admin@mock.com', role: 'admin', balance: 0 });
      }
      const ad = mockUsers.get(adminId)!;
      ad.balance = parseFloat((ad.balance + p.platformFee).toFixed(2));

      // Append transaction audit for Streamer
      const txId = 'mock_tx_' + Math.random().toString(36).substring(2, 11);
      mockTransactions.push({
        id: txId,
        userId: p.streamerId,
        type: 'credit',
        amount: p.streamerFee,
        referenceId: paymentId,
        createdAt: new Date().toISOString()
      });

      // Append transaction audit for platform Admin fee
      const adminTxId = 'mock_tx_admin_' + Math.random().toString(36).substring(2, 11);
      mockTransactions.push({
        id: adminTxId,
        userId: adminId,
        type: 'platform_fee',
        amount: p.platformFee,
        referenceId: paymentId,
        createdAt: new Date().toISOString()
      });

      res.json({
        message: '[MODO INTUITIVO DEV] Transação executada em memória. 50% repassado ao dono/admin.',
        payment: p,
        streamerBalance: st.balance,
        adminBalance: ad.balance
      });
    }
  }

  /**
   * Admin-Only: Reject manual subscription payments
   */
  static async rejectPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { paymentId } = req.params;
    const adminApp = getFirebaseAdmin();

    if (adminApp) {
      try {
        const db = adminApp.firestore();
        const payRef = db.collection('payments').doc(paymentId);
        const paySnap = await payRef.get();

        if (!paySnap.exists) {
          res.status(404).json({ error: 'Pagamento não localizado.' });
          return;
        }

        const payment = paySnap.data();
        if (!payment || payment.status !== 'pending') {
          res.status(400).json({ error: 'Pagamento já processado.' });
          return;
        }

        const batch = db.batch();
        batch.update(payRef, { status: 'rejected' });

        const accessRef = db.collection('roomAccess').doc(paymentId);
        const accessSnap = await accessRef.get();
        if (accessSnap.exists) {
          batch.update(accessRef, { status: 'rejected' });
        }

        await batch.commit();
        res.json({ message: 'Comprovante rejeitado pelo administrador com sucesso.' });
        return;
      } catch (err: any) {
        res.status(500).json({ error: 'Firestore rejection process failed.', details: err.message });
        return;
      }
    } else {
      const p = mockPayments.find(p => p.id === paymentId);
      if (!p) {
        res.status(404).json({ error: 'Pagamento não localizado em memória.' });
        return;
      }
      p.status = 'rejected';
      res.json({ message: '[MODO INTUITIVO DEV] Pagamento rejeitado com sucesso na memória.', payment: p });
    }
  }

  /**
   * Streamer-Only: Ask for money withdrawal of their balance
   */
  static async createWithdrawalRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { amount, pixKey } = req.body;
    if (!req.user) {
      res.status(401).json({ error: 'Auth context required' });
      return;
    }

    if (!amount || parseFloat(amount) <= 0) {
      res.status(400).json({ error: 'Defina um valor numérico positivo para resgatar.' });
      return;
    }

    const value = parseFloat(amount);
    const requestId = 'with_' + Math.random().toString(36).substring(2, 11);
    const adminApp = getFirebaseAdmin();

    if (adminApp) {
      try {
        const db = adminApp.firestore();
        const userRef = db.collection('users').doc(req.user.uid);
        const userSnap = await userRef.get();

        if (!userSnap.exists) {
          res.status(404).json({ error: 'Perfil do usuário não encontrado.' });
          return;
        }

        const userData = userSnap.data();
        const currentBalance = userData?.balance || 0;
        if (currentBalance < value) {
          res.status(400).json({ error: `Saldo insuficiente para saque. Máximo disponível: R$ ${currentBalance}` });
          return;
        }

        const resolvedPixKey = pixKey || userData?.pixKey || '';

        // Deduct balance synchronously and generate request
        await db.runTransaction(async (transaction) => {
          transaction.update(userRef, { 
            balance: parseFloat((currentBalance - value).toFixed(2)),
            pixKey: resolvedPixKey
          });
          transaction.set(db.collection('withdrawalRequests').doc(requestId), {
            userId: req!.user!.uid,
            userDisplayName: userData?.displayName || req!.user!.name || 'Usuário',
            userEmail: userData?.email || req!.user!.email || '',
            amount: value,
            pixKey: resolvedPixKey,
            status: 'pending',
            createdAt: admin.firestore.Timestamp.now()
          });
        });

        res.status(201).json({ message: 'Solicitação de saque criada. Transferiremos o Pix e aprovamos em breve.', requestId });
        return;
      } catch (err: any) {
        res.status(500).json({ error: 'Falha ao processar saque.', details: err.message });
        return;
      }
    } else {
      // Fetch user mock balance
      if (!mockUsers.has(req.user.uid)) {
        mockUsers.set(req.user.uid, { uid: req.user.uid, displayName: req.user.name || 'User', email: req.user.email || 'user@mock.com', role: req.user.role, balance: 150.00, pixKey: pixKey || '' }); // Pre-provision some balance in dev for nicer prototyping!
      }

      const st = mockUsers.get(req.user.uid)!;
      if (st.balance < value) {
        res.status(400).json({ error: `[MODO INTUITIVO DEV] Saldo insuficiente. Saldo mocado atual: R$ ${st.balance}` });
        return;
      }

      st.pixKey = pixKey || st.pixKey || '';
      st.balance = parseFloat((st.balance - value).toFixed(2));
      const reqWith = {
        id: requestId,
        userId: req.user.uid,
        userDisplayName: st.displayName,
        userEmail: st.email,
        amount: value,
        pixKey: st.pixKey,
        status: 'pending',
        createdAt: new Date().toISOString()
      };
      mockWithdrawals.push(reqWith);

      res.status(201).json({
        message: '[MODO INTUITIVO DEV] Saque registrado em memória.',
        withdrawalRequest: reqWith,
        streamerRemainingBalance: st.balance
      });
    }
  }

  /**
   * Admin-Only: Approve withdrawal request
   */
  static async approveWithdrawal(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { requestId } = req.params;
    const adminApp = getFirebaseAdmin();

    if (adminApp) {
      try {
        const db = adminApp.firestore();
        const reqRef = db.collection('withdrawalRequests').doc(requestId);
        const reqSnap = await reqRef.get();

        if (!reqSnap.exists) {
          res.status(404).json({ error: 'Pedido de saque não encontrado.' });
          return;
        }

        const withdrawal = reqSnap.data();
        if (!withdrawal || withdrawal.status !== 'pending') {
          res.status(400).json({ error: 'Pedido de saque já processado.' });
          return;
        }

        // Approve and write transaction audit
        await db.runTransaction(async (transaction) => {
          transaction.update(reqRef, { status: 'approved' });
          const txId = 'tx_' + Math.random().toString(36).substring(2, 11);
          transaction.set(db.collection('transactions').doc(txId), {
            userId: withdrawal.userId,
            type: 'debit',
            amount: withdrawal.amount,
            referenceId: requestId,
            createdAt: admin.firestore.Timestamp.now()
          });
        });

        res.json({ message: 'Saque aprovado e debitado das contas com Pix pago.' });
        return;
      } catch (err: any) {
        res.status(500).json({ error: 'Processamento de aprovação de saque indisponível.', details: err.message });
        return;
      }
    } else {
      const w = mockWithdrawals.find(r => r.id === requestId);
      if (!w) {
        res.status(404).json({ error: 'Solicitação de saque não encontrada em memória.' });
        return;
      }
      if (w.status !== 'pending') {
        res.status(400).json({ error: 'Pedido já processado.' });
        return;
      }

      w.status = 'approved';
      const txId = 'mock_tx_' + Math.random().toString(36).substring(2, 11);
      mockTransactions.push({
        id: txId,
        userId: w.userId,
        type: 'debit',
        amount: w.amount,
        referenceId: requestId,
        createdAt: new Date().toISOString()
      });

      res.json({ message: '[MODO INTUITIVO DEV] Saque aprovado com sucesso em memória.', withdrawal: w });
    }
  }

  /**
   * Admin-Only: Reject withdrawal request and return balance values
   */
  static async rejectWithdrawal(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { requestId } = req.params;
    const adminApp = getFirebaseAdmin();

    if (adminApp) {
      try {
        const db = adminApp.firestore();
        const reqRef = db.collection('withdrawalRequests').doc(requestId);
        const reqSnap = await reqRef.get();

        if (!reqSnap.exists) {
          res.status(404).json({ error: 'Solicitação não encontrada.' });
          return;
        }

        const w = reqSnap.data();
        if (!w || w.status !== 'pending') {
          res.status(400).json({ error: 'Pedido já processado.' });
          return;
        }

        const userRef = db.collection('users').doc(w.userId);
        await db.runTransaction(async (transaction) => {
          const userSnap = await transaction.get(userRef);
          const refundBalance = w.amount;
          const currentBl = userSnap.data()?.balance || 0;
          
          transaction.update(userRef, { balance: parseFloat((currentBl + refundBalance).toFixed(2)) });
          transaction.update(reqRef, { status: 'rejected' });
        });

        res.json({ message: 'Saque rejeitado. Saldos devolvidos à carteira do streamer.' });
        return;
      } catch (err: any) {
        res.status(500).json({ error: 'Falha ao estornar transação do saque.', details: err.message });
        return;
      }
    } else {
      const w = mockWithdrawals.find(r => r.id === requestId);
      if (!w) {
        res.status(404).json({ error: 'Solicitação de saque mocado não existente.' });
        return;
      }
      if (w.status !== 'pending') {
        res.status(400).json({ error: 'Status inadequado.' });
        return;
      }

      w.status = 'rejected';
      const st = mockUsers.get(w.userId)!;
      st.balance = parseFloat((st.balance + w.amount).toFixed(2));

      res.json({ message: '[MODO INTUITIVO DEV] Saque rejeitado com sucesso. Saldo estornado para a conta do usuário.', userBalance: st.balance });
    }
  }

  /**
   * Universal: Fetch transactions feed for the current user
   */
  static async getMyTransactions(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!req.user) {
      res.status(401).json({ error: 'Contexto de autorização requerido.' });
      return;
    }

    const adminApp = getFirebaseAdmin();
    if (adminApp) {
      try {
        const db = adminApp.firestore();
        let query: any = db.collection('transactions');
        
        if (req.user.role !== 'admin') {
          query = query.where('userId', '==', req.user.uid);
        }

        const list = await query.orderBy('createdAt', 'desc').limit(50).get();
        const txs: any[] = [];
        list.forEach((doc: any) => {
          txs.push({ id: doc.id, ...doc.data() });
        });

        res.json(txs);
        return;
      } catch (err: any) {
        res.status(500).json({ error: 'Falha ao recuperar extrato.', details: err.message });
        return;
      }
    } else {
      const myTxs = mockTransactions.filter(tx => req!.user!.role === 'admin' || tx.userId === req!.user!.uid);
      res.json(myTxs);
    }
  }

  /**
   * Helper and debugging endpoint to check balance
   */
  static async getBalance(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!req.user) {
      res.status(401).json({ error: 'Identidade requerida.' });
      return;
    }

    const adminApp = getFirebaseAdmin();
    if (adminApp) {
      try {
        const userDoc = await adminApp.firestore().collection('users').doc(req.user.uid).get();
        const bal = userDoc.data()?.balance || 0;
        res.json({ balance: bal });
        return;
      } catch (err: any) {
        res.status(500).json({ error: 'Erro de leitura de saldo.', details: err.message });
        return;
      }
    } else {
      if (!mockUsers.has(req.user.uid)) {
        mockUsers.set(req.user.uid, { uid: req.user.uid, displayName: req.user.name || 'User', email: req.user.email || 'mock@mock.com', role: req.user.role, balance: 150.00 });
      }
      res.json({ balance: mockUsers.get(req.user.uid)!.balance, isMock: true });
    }
  }

  /**
   * Submit manual payment evidence for an anonymous / guest reader on the Landing Page
   */
  static async createGuestPayment(req: Request, res: Response): Promise<void> {
    const { streamerId, amount, roomId, guestName, guestEmail, guestId } = req.body;
    
    if (!streamerId || !amount || parseFloat(amount) <= 0 || !guestId) {
      res.status(400).json({ error: 'Atributos streamerId, amount e guestId válidos são obrigatórios.' });
      return;
    }

    const valueAmount = parseFloat(amount);
    const platformFee = parseFloat((valueAmount * 0.50).toFixed(2)); // 50% platform rake fee
    const streamerFee = parseFloat((valueAmount - platformFee).toFixed(2)); // 50% goes to streamer

    const paymentId = 'pay_guest_' + Math.random().toString(36).substring(2, 11);
    const newPayment = {
      id: paymentId,
      payerId: guestId,
      payerName: guestName || 'Visitante Anônimo',
      payerEmail: guestEmail || 'visitante@anonimo.com',
      streamerId,
      amount: valueAmount,
      platformFee,
      streamerFee,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    const adminApp = getFirebaseAdmin();
    if (adminApp) {
      try {
        const db = adminApp.firestore();

        // Check if streamer user exists
        const streamerSnap = await db.collection('users').doc(streamerId).get();
        if (!streamerSnap.exists) {
          res.status(404).json({ error: 'Streamer de destino não encontrado no banco.' });
          return;
        }

        // Determine room id
        let finalRoomId = roomId;
        if (!finalRoomId) {
          const activeRoomSnap = await db.collection('rooms')
            .where('streamerId', '==', streamerId)
            .where('status', '==', 'active')
            .limit(1)
            .get();
          if (!activeRoomSnap.empty) {
            finalRoomId = activeRoomSnap.docs[0].id;
          } else {
            finalRoomId = `room_${streamerId}`;
          }
        }

        const batch = db.batch();
        batch.set(db.collection('payments').doc(paymentId), {
          ...newPayment,
          createdAt: admin.firestore.Timestamp.now()
        });

        batch.set(db.collection('roomAccess').doc(paymentId), {
          id: paymentId,
          roomId: finalRoomId,
          userId: guestId,
          userDisplayName: guestName || 'Visitante Anônimo',
          userEmail: guestEmail || 'visitante@anonimo.com',
          streamerId,
          status: 'pending',
          createdAt: admin.firestore.Timestamp.now()
        });

        await batch.commit();
        res.status(201).json({ message: 'Comprovante Pix do Visitante enviado ao admin.', payment: newPayment });
        return;
      } catch (err: any) {
        res.status(500).json({ error: 'Erro de banco de dados do Firestore.', details: err.message });
        return;
      }
    } else {
      mockPayments.push(newPayment);
      res.status(201).json({
        message: '[MODO INTUITIVO DEV] Comprovante Pix do Visitante mocado em memória.',
        payment: newPayment
      });
    }
  }

  /**
   * Verify if the guest / anonymous user has approved access to watch the stream
   */
  static async checkGuestAccess(req: Request, res: Response): Promise<void> {
    const { roomId } = req.params;
    const { guestId } = req.query;

    if (!guestId) {
      res.status(400).json({ authorized: false, error: 'Identificador do Visitante (guestId) em falta.' });
      return;
    }

    const adminApp = getFirebaseAdmin();
    if (adminApp) {
      try {
        const db = adminApp.firestore();
        const rSnap = await db.collection('rooms').doc(roomId).get();
        if (!rSnap.exists) {
          res.status(404).json({ authorized: false, error: 'Canal de stream não localizado ou inativo.' });
          return;
        }

        const room = rSnap.data();
        if (!room) {
          res.status(404).json({ authorized: false, error: 'Sem dados da sala.' });
          return;
        }

        if (room.pricePerHour <= 0) {
          res.json({ authorized: true, reason: 'Livre acesso: Canal gratuito.', price: 0 });
          return;
        }

        const paymentsQuery = await db.collection('payments')
          .where('payerId', '==', guestId)
          .where('streamerId', '==', room.streamerId)
          .where('status', '==', 'approved')
          .orderBy('createdAt', 'desc')
          .limit(1)
          .get();

        if (paymentsQuery.empty) {
          res.json({
            authorized: false,
            reason: 'Assinatura Paga requerida. Envie o Pix de comprovação para o Streamer para obter liberação.',
            price: room.pricePerHour
          });
          return;
        }

        res.json({ authorized: true, reason: 'Assinatura Pix do Visitante validada.', price: room.pricePerHour });
        return;
      } catch (err: any) {
        res.status(500).json({ authorized: false, error: err.message });
        return;
      }
    } else {
      // Memory fallback checks
      const room = mockRooms.find(r => r.id === roomId);
      if (!room) {
        res.status(404).json({ authorized: false, error: 'Sala mocado não localizada em memória.' });
        return;
      }

      if (room.pricePerHour <= 0) {
        res.json({ authorized: true, reason: 'Canal gratuito mocado.', price: 0 });
        return;
      }

      const approvedPay = mockPayments.find(p => p.payerId === guestId && p.streamerId === room.streamerId && p.status === 'approved');
      if (approvedPay) {
        res.json({ authorized: true, reason: 'Acesso liberado mocado.', price: room.pricePerHour });
      } else {
        const pendingPay = mockPayments.find(p => p.payerId === guestId && p.streamerId === room.streamerId && p.status === 'pending');
        res.json({
          authorized: false,
          reason: pendingPay ? 'Aguardando aprovação do admin.' : 'Envie seu comprovante Pix.',
          price: room.pricePerHour
        });
      }
    }
  }

  /**
   * Create dynamic pix payment using Mercado Pago SDK
   */
  static async createPixPayment(req: Request, res: Response): Promise<void> {
    const { roomId, userId, guestId, viewerName } = req.body;

    if (!roomId) {
      res.status(400).json({ error: 'O roomId é obrigatório.' });
      return;
    }

    const payerId = userId || guestId || 'guest_' + Math.random().toString(36).substring(2, 11);
    const payerName = viewerName || 'Visitante Anônimo';

    let roomPrice = 0;
    let roomName = '';
    let streamerId = '';

    const adminApp = getFirebaseAdmin();
    if (adminApp) {
      try {
        const db = adminApp.firestore();
        const rDoc = await db.collection('rooms').doc(roomId).get();
        if (!rDoc.exists) {
          res.status(404).json({ error: 'Sala não encontrada.' });
          return;
        }
        const data = rDoc.data();
        roomPrice = data?.pricePerHour || 0;
        roomName = data?.name || '';
        streamerId = data?.streamerId || '';
      } catch (err: any) {
        res.status(500).json({ error: 'Erro de leitura da sala no banco.', details: err.message });
        return;
      }
    } else {
      const room = mockRooms.find(r => r.id === roomId);
      if (!room) {
        res.status(404).json({ error: 'Sala mocado não localizada em memória.' });
        return;
      }
      roomPrice = room.pricePerHour || 0;
      roomName = room.name || '';
      streamerId = room.streamerId || '';
    }

    if (roomPrice <= 0) {
      res.status(400).json({ error: 'Esta sala é livre e não necessita de Pix pago.' });
      return;
    }

    const mpToken = process.env.MERCADO_PAGO_ACCESS_TOKEN || 'APP_USR-3060719903206819-052323-10c202b6048103cee9190b9cd1653f59-1412971336';
    const useMock = !mpToken || mpToken.includes('MY_API_KEY') || mpToken === '';

    const paymentId = 'pay_pix_' + Math.random().toString(36).substring(2, 11);

    if (useMock) {
      console.log('[Mercado Pago API] Inicializando pagamento simulado no modo de desenvolvimento.');
      const mockQrCode = `00020126580014br.gov.bcb.pix0114t_rt_cast_00010214SaoPaulo050300154013RSC54${roomPrice.toFixed(2)}0005BR1025684A12B3B9C182`;
      const mockQrCodeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

      const platformFee = parseFloat((roomPrice * 0.50).toFixed(2));
      const streamerFee = parseFloat((roomPrice - platformFee).toFixed(2));

      const newPayment = {
        id: paymentId,
        payerId: payerId,
        payerName: payerName,
        streamerId: streamerId,
        roomId: roomId,
        amount: roomPrice,
        platformFee,
        streamerFee,
        status: 'pending',
        type: 'pix',
        provider: 'mercadopago_mock',
        createdAt: new Date().toISOString()
      };

      if (adminApp) {
        try {
          const db = adminApp.firestore();
          await db.collection('payments').doc(paymentId).set({
            ...newPayment,
            createdAt: admin.firestore.Timestamp.now()
          });
          await db.collection('roomAccess').doc(paymentId).set({
            id: paymentId,
            roomId: roomId,
            userId: payerId,
            userDisplayName: payerName,
            streamerId: streamerId,
            status: 'pending',
            createdAt: admin.firestore.Timestamp.now()
          });
        } catch (err: any) {
          console.error('[Mock DB Write Error]', err);
        }
      } else {
        mockPayments.push(newPayment);
      }

      res.status(200).json({
        qrCode: mockQrCode,
        qrCodeBase64: mockQrCodeBase64,
        copiaECola: mockQrCode,
        paymentId: paymentId,
        isMock: true
      });
      return;
    }

    try {
      const paymentHandler = getMercadoPago();
      if (!paymentHandler) {
        throw new Error('SDK do Mercado Pago não iniciou.');
      }

      const appUrl = process.env.APP_URL || 'https://ais-dev-dusbct3rcrvkfr7ka72vgd-560283227306.us-east1.run.app';
      const response = await paymentHandler.create({
        body: {
          transaction_amount: roomPrice,
          description: `Acesso à Live ${roomName || roomId}`,
          payment_method_id: 'pix',
          payer: {
            email: 'cliente.bahia@stream.com',
            first_name: payerName.split(' ')[0] || 'Cliente',
            last_name: payerName.split(' ').slice(1).join(' ') || 'BahiaStream',
          },
          notification_url: `${appUrl}/api/payments/webhook`
        }
      });

      const mpId = String(response.id);
      const qrCode = response.point_of_interaction?.transaction_data?.qr_code || '';
      const qrCodeBase64 = response.point_of_interaction?.transaction_data?.qr_code_base64 || '';

      const platformFee = parseFloat((roomPrice * 0.50).toFixed(2));
      const streamerFee = parseFloat((roomPrice - platformFee).toFixed(2));

      const newPayment = {
        id: mpId,
        payerId: payerId,
        payerName: payerName,
        streamerId: streamerId,
        roomId: roomId,
        amount: roomPrice,
        platformFee,
        streamerFee,
        status: 'pending',
        type: 'pix',
        provider: 'mercadopago',
        createdAt: new Date().toISOString()
      };

      if (adminApp) {
        const db = adminApp.firestore();
        await db.collection('payments').doc(mpId).set({
          ...newPayment,
          createdAt: admin.firestore.Timestamp.now()
        });
        await db.collection('roomAccess').doc(mpId).set({
          id: mpId,
          roomId: roomId,
          userId: payerId,
          userDisplayName: payerName,
          streamerId: streamerId,
          status: 'pending',
          createdAt: admin.firestore.Timestamp.now()
        });
      } else {
        mockPayments.push(newPayment);
      }

      res.status(200).json({
        qrCode: qrCode,
        qrCodeBase64: qrCodeBase64,
        copiaECola: qrCode,
        paymentId: mpId,
        isMock: false
      });
    } catch (err: any) {
      console.warn('[Mercado Pago API] Erro ao criar pix real, ativando fallback mock:', err.message);
      
      const mockQrCode = `00020126580014br.gov.bcb.pix0114t_rt_cast_00010214SaoPaulo050300154013RSC54${roomPrice.toFixed(2)}0005BR1025684A12B3B9C182`;
      const mockQrCodeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

      const platformFee = parseFloat((roomPrice * 0.50).toFixed(2));
      const streamerFee = parseFloat((roomPrice - platformFee).toFixed(2));

      const newPayment = {
        id: paymentId,
        payerId: payerId,
        payerName: payerName,
        streamerId: streamerId,
        roomId: roomId,
        amount: roomPrice,
        platformFee,
        streamerFee,
        status: 'pending',
        type: 'pix',
        provider: 'mercadopago_failover',
        createdAt: new Date().toISOString()
      };

      if (adminApp) {
        try {
          const db = adminApp.firestore();
          await db.collection('payments').doc(paymentId).set({
            ...newPayment,
            createdAt: admin.firestore.Timestamp.now()
          });
          await db.collection('roomAccess').doc(paymentId).set({
            id: paymentId,
            roomId: roomId,
            userId: payerId,
            userDisplayName: payerName,
            streamerId: streamerId,
            status: 'pending',
            createdAt: admin.firestore.Timestamp.now()
          });
        } catch (dbErr) {
          console.error(dbErr);
        }
      } else {
        mockPayments.push(newPayment);
      }

      res.status(200).json({
        qrCode: mockQrCode,
        qrCodeBase64: mockQrCodeBase64,
        copiaECola: mockQrCode,
        paymentId: paymentId,
        isMock: true,
        warning: 'Failover mock ativado em decorrência de restrição do gateway.'
      });
    }
  }

  /**
   * Universal Webhook handler for Mercado Pago
   */
  static async handleWebhook(req: Request, res: Response): Promise<void> {
    console.log('[Webhook POST] Recebido feedback de pagamentos:', req.query, req.body);

    const paymentId = req.query.id || req.body.data?.id || req.body.id;
    const isMockSimulatedApproval = req.body.isMockSimulatedApproval === true;

    if (!paymentId) {
      console.warn('[Webhook] Nenhum id de pagamento fornecido.');
      res.status(200).json({ message: 'OK - Ignored: Missing payment entity' });
      return;
    }

    const adminApp = getFirebaseAdmin();

    // 1. Simulate mock webhook or handle real Approved checkout status
    if (isMockSimulatedApproval) {
      console.log(`[Simulation Webhook] Forçando aprovação mocado em tempo real do Pix ID: ${paymentId}`);
      
      let roomId = '';
      let payerId = '';
      let streamerId = '';
      let priceAmount = 0;

      if (adminApp) {
        try {
          const db = adminApp.firestore();
          const payRef = db.collection('payments').doc(String(paymentId));
          const paySnap = await payRef.get();

          if (!paySnap.exists) {
            res.status(404).json({ error: 'Pagamento simulado não localizado em db.' });
            return;
          }

          const payment = paySnap.data();
          if (payment && payment.status === 'pending') {
            roomId = payment.roomId;
            payerId = payment.payerId;
            streamerId = payment.streamerId;
            priceAmount = payment.amount;

            // Fetch an active Admin
            const adminQuery = await db.collection('users').where('role', '==', 'admin').limit(1).get();
            let adminId = 'admin_system';
            if (!adminQuery.empty) {
              adminId = adminQuery.docs[0].id;
            }

            await db.runTransaction(async (transaction) => {
              const streamerRef = db.collection('users').doc(streamerId);
              const streamerSnap = await transaction.get(streamerRef);
              if (streamerSnap.exists) {
                const currentBalance = streamerSnap.data()?.balance || 0;
                transaction.update(streamerRef, { balance: parseFloat((currentBalance + payment.streamerFee).toFixed(2)) });
              }

              const adminRef = db.collection('users').doc(adminId);
              const adminSnap = await transaction.get(adminRef);
              if (adminSnap.exists) {
                const currentAdminBalance = adminSnap.data()?.balance || 0;
                transaction.update(adminRef, { balance: parseFloat((currentAdminBalance + payment.platformFee).toFixed(2)) });
              }

              transaction.update(payRef, { status: 'approved' });

              const accessRef = db.collection('roomAccess').doc(String(paymentId));
              const accessSnap = await transaction.get(accessRef);
              if (accessSnap.exists) {
                transaction.update(accessRef, { status: 'approved' });
              }

              const txId = 'tx_' + Math.random().toString(36).substring(2, 11);
              transaction.set(db.collection('transactions').doc(txId), {
                userId: streamerId,
                type: 'credit',
                amount: payment.streamerFee,
                referenceId: paymentId,
                createdAt: admin.firestore.Timestamp.now()
              });

              const adminTxId = 'tx_admin_' + Math.random().toString(36).substring(2, 11);
              transaction.set(db.collection('transactions').doc(adminTxId), {
                userId: adminId,
                type: 'platform_fee',
                amount: payment.platformFee,
                referenceId: paymentId,
                createdAt: admin.firestore.Timestamp.now()
              });
            });

            console.log('[Simulation Webhook] Status atualizado no Firestore com sucesso.');
          }
        } catch (err: any) {
          console.error('[Simulation Webhook Firestore Err]', err.message);
        }
      } else {
        const p = mockPayments.find(pay => pay.id === paymentId);
        if (p && p.status === 'pending') {
          p.status = 'approved';
          roomId = p.roomId;
          payerId = p.payerId;
          streamerId = p.streamerId;
          priceAmount = p.amount;

          if (!mockUsers.has(streamerId)) {
            mockUsers.set(streamerId, { uid: streamerId, displayName: 'Streamer Mocado', email: 'streamer@mock.com', role: 'streamer', balance: 0 });
          }
          const st = mockUsers.get(streamerId)!;
          st.balance = parseFloat((st.balance + p.streamerFee).toFixed(2));

          mockTransactions.push({
            id: 'mock_tx_' + Math.random().toString(36).substring(2, 11),
            userId: streamerId,
            type: 'credit',
            amount: p.streamerFee,
            referenceId: paymentId,
            createdAt: new Date().toISOString()
          });
        }
      }

      // Emit realtime Socket message
      if (activeIo && roomId) {
        console.log(`[Socket.IO Webhook] Disparando payment-approved para viewer: ${payerId} na sala ${roomId}`);
        activeIo.to(roomId).emit('payment-approved', {
          roomId,
          paymentId,
          payerId,
          status: 'approved'
        });
      }

      res.status(200).json({ message: 'Aprovação simulada efetuada.' });
      return;
    }

    // 2. Real Webhook Validation from Mercado Pago Gateway
    try {
      const paymentHandler = getMercadoPago();
      if (!paymentHandler) {
        console.warn('[Webhook] SDK indisponível. Rejeitando processamento real.');
        res.status(200).json({ message: 'SDK Offline' });
        return;
      }

      const mpResponse = await paymentHandler.get({ id: String(paymentId) });
      const mpStatus = mpResponse.status;

      console.log(`[Webhook] Mercado Pago validou ID: ${paymentId}. Status Real: ${mpStatus}`);

      if (mpStatus === 'approved') {
        let roomId = '';
        let payerId = '';
        let streamerId = '';

        if (adminApp) {
          const db = adminApp.firestore();
          const payRef = db.collection('payments').doc(String(paymentId));
          const paySnap = await payRef.get();

          if (!paySnap.exists) {
            console.warn(`[Webhook] Pagamento real ${paymentId} aprovado na MP mas sem registro local no DB.`);
            res.status(200).json({ message: 'Payment document missing' });
            return;
          }

          const payment = paySnap.data();
          if (payment && payment.status === 'pending') {
            roomId = payment.roomId;
            payerId = payment.payerId;
            streamerId = payment.streamerId;

            // Fetch Admin
            const adminQuery = await db.collection('users').where('role', '==', 'admin').limit(1).get();
            let adminId = 'admin_system';
            if (!adminQuery.empty) {
              adminId = adminQuery.docs[0].id;
            }

            await db.runTransaction(async (transaction) => {
              const streamerRef = db.collection('users').doc(streamerId);
              const streamerSnap = await transaction.get(streamerRef);
              if (streamerSnap.exists) {
                const currentBalance = streamerSnap.data()?.balance || 0;
                transaction.update(streamerRef, { balance: parseFloat((currentBalance + payment.streamerFee).toFixed(2)) });
              }

              const adminRef = db.collection('users').doc(adminId);
              const adminSnap = await transaction.get(adminRef);
              if (adminSnap.exists) {
                const currentAdminBalance = adminSnap.data()?.balance || 0;
                transaction.update(adminRef, { balance: parseFloat((currentAdminBalance + payment.platformFee).toFixed(2)) });
              }

              transaction.update(payRef, { status: 'approved' });

              const accessRef = db.collection('roomAccess').doc(String(paymentId));
              const accessSnap = await transaction.get(accessRef);
              if (accessSnap.exists) {
                transaction.update(accessRef, { status: 'approved' });
              }

              const txId = 'tx_' + Math.random().toString(36).substring(2, 11);
              transaction.set(db.collection('transactions').doc(txId), {
                userId: streamerId,
                type: 'credit',
                amount: payment.streamerFee,
                referenceId: paymentId,
                createdAt: admin.firestore.Timestamp.now()
              });

              const adminTxId = 'tx_admin_' + Math.random().toString(36).substring(2, 11);
              transaction.set(db.collection('transactions').doc(adminTxId), {
                userId: adminId,
                type: 'platform_fee',
                amount: payment.platformFee,
                referenceId: paymentId,
                createdAt: admin.firestore.Timestamp.now()
              });
            });
            console.log(`[Webhook Firestore WebRTC] Pagamento ${paymentId} aprovado e balanceado.`);
          } else if (payment) {
            console.log(`[Webhook] Pagamento já processado previamente como: ${payment.status}`);
            roomId = payment.roomId;
            payerId = payment.payerId;
          }
        } else {
          const p = mockPayments.find(pay => pay.id === String(paymentId));
          if (p && p.status === 'pending') {
            p.status = 'approved';
            roomId = p.roomId;
            payerId = p.payerId;
            streamerId = p.streamerId;

            if (!mockUsers.has(streamerId)) {
              mockUsers.set(streamerId, { uid: streamerId, displayName: 'Streamer Mocado', email: 'streamer@mock.com', role: 'streamer', balance: 0 });
            }
            const st = mockUsers.get(streamerId)!;
            st.balance = parseFloat((st.balance + p.streamerFee).toFixed(2));

            mockTransactions.push({
              id: 'mock_tx_' + Math.random().toString(36).substring(2, 11),
              userId: streamerId,
              type: 'credit',
              amount: p.streamerFee,
              referenceId: paymentId,
              createdAt: new Date().toISOString()
            });
          }
        }

        // Fire realtime event over Socket
        if (activeIo && roomId) {
          console.log(`[Socket.IO Webhook] Disparando real-time payment-approved para viewer: ${payerId} na sala ${roomId}`);
          activeIo.to(roomId).emit('payment-approved', {
            roomId,
            paymentId,
            payerId,
            status: 'approved'
          });
        }
      }

      res.status(200).json({ status: 'success', mpStatus });
    } catch (err: any) {
      console.error('[Webhook Processing Failed]', err.message);
      res.status(200).json({ error: 'Erro de processamento', details: err.message });
    }
  }
}

