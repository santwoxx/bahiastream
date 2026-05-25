import { Response } from 'express';
import * as admin from 'firebase-admin';
import { AuthenticatedRequest } from '../middlewares/auth';
import { getFirebaseAdmin } from '../config/firebase';

// Fallback in-memory database
export let mockRooms: any[] = [];
export let mockActiveStreams: any[] = [];
export let mockPaymentsList: any[] = []; // In-memory reference representation

export class StreamController {
  /**
   * Create a new stream channel (Streamers only)
   */
  static async createRoom(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { name, pricePerHour } = req.body;
    if (!req.user) {
      res.status(401).json({ error: 'Contexto de autenticação em falta.' });
      return;
    }

    if (!name ) {
      res.status(400).json({ error: 'O nome da sala/transmissão é obrigatório.' });
      return;
    }

    const price = pricePerHour ? parseFloat(pricePerHour) : 0;
    const roomId = 'room_' + Math.random().toString(36).substring(2, 11);

    const roomData = {
      id: roomId,
      name,
      streamerId: req.user.uid,
      status: 'active',
      pricePerHour: price,
      createdAt: new Date().toISOString()
    };

    // Always keep custom local memory updated
    mockRooms.push(roomData);
    mockActiveStreams.push({
      roomId,
      streamerId: req.user.uid,
      viewerCount: 0,
      startedAt: new Date().toISOString()
    });

    const adminApp = getFirebaseAdmin();
    if (adminApp) {
      try {
        const db = adminApp.firestore();
        
        // Batch write Room and ActiveStream
        const batch = db.batch();
        batch.set(db.collection('rooms').doc(roomId), {
          ...roomData,
          createdAt: admin.firestore.Timestamp.now()
        });
        batch.set(db.collection('activeStreams').doc(roomId), {
          roomId,
          streamerId: req.user.uid,
          viewerCount: 0,
          startedAt: admin.firestore.Timestamp.now()
        });

        await batch.commit();
        res.status(201).json({ message: 'Sala de transmissão criada. Pronto para começar streaming WebRTC.', room: roomData });
        return;
      } catch (err: any) {
        console.warn('[Firebase Cloud Admin System] Erro ao gravar Firestore. Fazendo fallback síncrono para memória local do contêiner:', err.message);
        res.status(201).json({ message: 'Sala de transmissão criada no contêiner (Fallback de Memória local ativo).', room: roomData });
        return;
      }
    } else {
      res.status(201).json({
        message: '[MODO INTUITIVO DEV] Canal de stream mocado em memória com sucesso.',
        room: roomData
      });
    }
  }

  /**
   * List all streaming channels
   */
  static async listRooms(req: AuthenticatedRequest, res: Response): Promise<void> {
    const adminApp = getFirebaseAdmin();

    if (adminApp) {
      try {
        const db = adminApp.firestore();
        const roomsSnap = await db.collection('rooms').where('status', '==', 'active').get();
        const list: any[] = [];
        roomsSnap.forEach(doc => {
          list.push({ id: doc.id, ...doc.data() });
        });

        // Dual-merge with local Mock memory for absolute completeness of channels
        mockRooms.forEach(mockR => {
          if (mockR.status === 'active' && !list.find(l => l.id === mockR.id)) {
            list.push(mockR);
          }
        });

        res.json(list);
        return;
      } catch (err: any) {
        console.warn('[Firebase Cloud Admin System] Falha ao ler do Firestore. Resgatando lista local:', err.message);
        res.json(mockRooms.filter(r => r.status === 'active'));
        return;
      }
    } else {
      res.json(mockRooms.filter(r => r.status === 'active'));
    }
  }

  /**
   * Close a streaming session (Streamer only)
   */
  static async deactivateRoom(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { roomId } = req.params;
    if (!req.user) {
      res.status(401).json({ error: 'Auth context required' });
      return;
    }

    // Always ensure local memory tracker is kept clean as well
    const localRoom = mockRooms.find(r => r.id === roomId);
    if (localRoom) {
      localRoom.status = 'inactive';
    }
    mockActiveStreams = mockActiveStreams.filter(as => as.roomId !== roomId);

    const adminApp = getFirebaseAdmin();
    if (adminApp) {
      try {
        const db = adminApp.firestore();
        const rRef = db.collection('rooms').doc(roomId);
        const rSnap = await rRef.get();

        if (rSnap.exists) {
          const room = rSnap.data();
          if (room?.streamerId === req.user.uid || req.user.role === 'admin') {
            const batch = db.batch();
            batch.update(rRef, { status: 'inactive' });
            batch.delete(db.collection('activeStreams').doc(roomId));
            await batch.commit();
          }
        }

        res.json({ message: 'Sala desativada concluída e canal removido.' });
        return;
      } catch (err: any) {
        console.warn('[Firebase Cloud] Erro ao desativar Firestore, mas local-mock limpo:', err.message);
        res.json({ message: 'Sala desativada localmente com sucesso.' });
        return;
      }
    } else {
      res.json({ message: '[MODO INTUITIVO DEV] Canal deletado em memória com sucesso.' });
    }
  }

  /**
   * Verify if the viewer is authorized to watch the streamer's screenshare
   */
  static async checkAccess(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { roomId } = req.params;
    if (!req.user) {
      res.status(401).json({ error: 'User context is missing.' });
      return;
    }

    const adminApp = getFirebaseAdmin();
    if (adminApp) {
      try {
        const db = adminApp.firestore();
        const rSnap = await db.collection('rooms').doc(roomId).get();
        
        let room: any = null;
        if (rSnap.exists) {
          room = rSnap.data();
        } else {
          // fallback search inside memory in case it was stored there
          room = mockRooms.find(r => r.id === roomId);
        }

        if (!room) {
          res.status(404).json({ error: 'Sala de exibição inexistente.' });
          return;
        }

        // Bypasses: Owner, or Admin
        if (room.streamerId === req.user.uid || req.user.role === 'admin') {
          res.json({ authorized: true, reason: 'Acesso garantido: Proprietário do Sinal ou Administrador.' });
          return;
        }

        // Free room?
        if (room.pricePerHour <= 0) {
          res.json({ authorized: true, reason: 'Acesso liberado: Sala gratuita.' });
          return;
        }

        // Paid room - check for APPROVED payment on this streamer from this payer
        let hasPaid = false;
        try {
          const paymentsQuery = await db.collection('payments')
            .where('payerId', '==', req.user.uid)
            .where('streamerId', '==', room.streamerId)
            .where('status', '==', 'approved')
            .orderBy('createdAt', 'desc')
            .limit(1)
            .get();

          hasPaid = !paymentsQuery.empty;
        } catch (e) {
          // Fallback to purely local mock payments on read errors
          const approvedPay = mockPaymentsList.find(p => p.payerId === req!.user!.uid && p.streamerId === room.streamerId && p.status === 'approved');
          if (approvedPay) {
            hasPaid = true;
          }
        }

        if (!hasPaid) {
          res.json({
            authorized: false,
            reason: 'Assinatura Paga requerida. Envie o Pix de comprovação para o Streamer para obter liberação.',
            price: room.pricePerHour
          });
          return;
        }

        res.json({ authorized: true, reason: 'Assinatura PIX ativa e validada.' });
        return;
      } catch (err: any) {
        console.warn('[Firebase Cloud] Erro no checkAccess, caindo para verificação mock:', err.message);
        const room = mockRooms.find(r => r.id === roomId);
        if (!room) {
          res.status(404).json({ error: 'Conexão indisponível (Db & Memória vazios).' });
          return;
        }
        if (room.streamerId === req.user.uid || room.pricePerHour <= 0) {
          res.json({ authorized: true, reason: 'Acesso local liberado.' });
          return;
        }
        const approvedPay = mockPaymentsList.find(p => p.payerId === req!.user!.uid && p.streamerId === room.streamerId && p.status === 'approved');
        if (approvedPay) {
          res.json({ authorized: true, reason: 'Pago de forma local.' });
        } else {
          res.json({ authorized: false, reason: 'Pix pendente de aprovação local.', price: room.pricePerHour });
        }
      }
    } else {
      // Memory fallback checks
      const room = mockRooms.find(r => r.id === roomId);
      if (!room) {
        res.status(404).json({ error: 'Conexão mocado indisponível.' });
        return;
      }

      if (room.streamerId === req.user.uid || req.user.role === 'admin') {
        res.json({ authorized: true, reason: '[DEV] Proprietário do canal ou admin mocado.' });
        return;
      }

      if (room.pricePerHour <= 0) {
        res.json({ authorized: true, reason: '[DEV] Sala mocado sem custos.' });
        return;
      }

      // Check mock payments
      const approvedPay = mockPaymentsList.find(p => p.payerId === req!.user!.uid && p.streamerId === room.streamerId && p.status === 'approved');
      if (approvedPay) {
        res.json({ authorized: true, reason: '[DEV] Comprovante aprovado encontrado na memória mocado.' });
      } else {
        res.json({
          authorized: false,
          reason: 'Transmissão Premium Privada mocado. Pix pendente de aprovação admin.',
          price: room.pricePerHour
        });
      }
    }
  }

  /**
   * List rooms for public landing page (No Authentication required)
   */
  static async listLandingRooms(req: any, res: Response): Promise<void> {
    const adminApp = getFirebaseAdmin();

    if (adminApp) {
      try {
        const db = adminApp.firestore();
        const roomsSnap = await db.collection('rooms').where('status', '==', 'active').get();
        const list: any[] = [];
        roomsSnap.forEach(doc => {
          list.push({ id: doc.id, ...doc.data() });
        });

        // Dual-merge with local Mock memory for absolute completeness of channels
        mockRooms.forEach(mockR => {
          if (mockR.status === 'active' && !list.find(l => l.id === mockR.id)) {
            list.push(mockR);
          }
        });

        res.json(list);
        return;
      } catch (err: any) {
        console.warn('[Firebase Cloud] Erro na consulta de Landing Rooms. Resgatando lista local:', err.message);
        res.json(mockRooms.filter(r => r.status === 'active'));
        return;
      }
    } else {
      res.json(mockRooms.filter(r => r.status === 'active'));
    }
  }
}
