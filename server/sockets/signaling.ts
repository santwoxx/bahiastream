import { Server, Socket } from 'socket.io';
import { getFirebaseAdmin } from '../config/firebase';
import { mockRooms, mockActiveStreams } from '../controllers/streamController';
import * as admin from 'firebase-admin';

interface PeerConnection {
  socketId: string;
  userId: string;
  role: 'streamer' | 'viewer';
}

interface StreamerHeartbeat {
  roomId: string;
  userId: string;
  lastActive: number;
  socket: Socket;
}

// Maps to keep track of active sockets, room identities, and heartbeats
const socketToRoomMap = new Map<string, { roomId: string; userId: string; role: 'streamer' | 'viewer' }>();
const roomActivePeers = new Map<string, PeerConnection[]>();
const activeStreamersHeartbeats = new Map<string, StreamerHeartbeat>(); // socketId -> Heartbeat

export let activeIo: Server | null = null;

/**
 * Helper to update database room status to inactive when streamer is offline
 */
async function autoDeactivateRoom(roomId: string, userId: string): Promise<void> {
  console.log(`[Auto-Deactivate] Ativando encerramento da sala ${roomId} para o streamer ${userId}`);

  // 1. In-memory fallback
  const mockIdx = mockRooms.findIndex(r => r.id === roomId);
  if (mockIdx !== -1) {
    mockRooms[mockIdx].status = 'inactive';
    console.log(`[Auto-Deactivate-Mock] Sala mocado ${roomId} marcada como inativa.`);
  }
  const idxActive = mockActiveStreams.findIndex(as => as.roomId === roomId);
  if (idxActive !== -1) {
    mockActiveStreams.splice(idxActive, 1);
  }

  // 2. Firestore Deactivation
  const adminApp = getFirebaseAdmin();
  if (adminApp) {
    try {
      const db = adminApp.firestore();
      const rRef = db.collection('rooms').doc(roomId);
      const batch = db.batch();
      batch.update(rRef, { status: 'inactive' });
      batch.delete(db.collection('activeStreams').doc(roomId));
      await batch.commit();
      console.log(`[Auto-Deactivate-Firestore] Sala ${roomId} desativada e removida com sucesso.`);
    } catch (err: any) {
      console.error(`[Auto-Deactivate-Firestore] Erro ao desativar sala ${roomId}:`, err.message);
    }
  }
}

export function setupSignaling(io: Server): void {
  activeIo = io;
  // Start Heartbeat safety timer checking every 10 seconds
  setInterval(() => {
    const now = Date.now();
    for (const [socketId, tracker] of activeStreamersHeartbeats.entries()) {
      if (now - tracker.lastActive > 120000) { // No update for more than 120s (tolerates background tab browser throttling)
        console.warn(`[Timeout de Segurança] Streamer ${socketId} na sala ${tracker.roomId} perdeu heartbeat por mais de 120s.`);
        
        // Notify viewers
        tracker.socket.to(tracker.roomId).emit('streamer-left', { streamerId: socketId });
        
        // Auto-terminate the room
        autoDeactivateRoom(tracker.roomId, tracker.userId);
        
        // Clear tracker and disconnect
        activeStreamersHeartbeats.delete(socketId);
        tracker.socket.disconnect(true);
      }
    }
  }, 10000);

  io.on('connection', (socket: Socket) => {
    console.log(`[Socket.IO] Novo cliente em tempo real conectado: ${socket.id}`);

    /**
     * User requests to join a WebRTC signaling stream room
     */
    socket.on('join-room', (payload: { roomId: string; userId: string; role: 'streamer' | 'viewer' }) => {
      const { roomId, userId, role } = payload;
      
      if (!roomId || !userId || !role) {
        socket.emit('error-msg', { message: 'Dados insuficientes para ingressar no canal de sinalização.' });
        return;
      }

      console.log(`[Socket.IO] Cliente ${socket.id} (${userId}) entrando na sala ${roomId} como ${role}`);

      // Join Socket.io isolated channel room
      socket.join(roomId);

      // Save socket metadata
      socketToRoomMap.set(socket.id, { roomId, userId, role });

      // Track heartbeat if streamer
      if (role === 'streamer') {
        activeStreamersHeartbeats.set(socket.id, {
          roomId,
          userId,
          lastActive: Date.now(),
          socket
        });
      }

      // Retrieve or create peer list for the room
      if (!roomActivePeers.has(roomId)) {
        roomActivePeers.set(roomId, []);
      }
      
      const peers = roomActivePeers.get(roomId)!;

      // Prevent duplicate entry on reconnection of the exact same socket ID
      const candidateIndex = peers.findIndex(p => p.socketId === socket.id);
      if (candidateIndex !== -1) {
        peers.splice(candidateIndex, 1);
      }

      peers.push({ socketId: socket.id, userId, role });

      if (role === 'streamer') {
        console.log(`[Socket.IO] Streamer principal ${socket.id} está pronto na sala ${roomId}`);
        // Notify any pre-existing viewers that the streamer is ready
        socket.to(roomId).emit('streamer-ready', { streamerId: socket.id });
      } else {
        // If they are a viewer, find the streamer in this room to establish P2P connection
        const streamer = peers.find(p => p.role === 'streamer');
        if (streamer) {
          console.log(`[Socket.IO] Notificando streamer ${streamer.socketId} sobre o espectador ${socket.id}`);
          io.to(streamer.socketId).emit('viewer-joined', {
            viewerId: socket.id,
            userId: userId
          });
        } else {
          console.log(`[Socket.IO] Viewer entrou mas nenhum streamer está transmitindo ainda na sala ${roomId}`);
          socket.emit('waiting-for-streamer');
        }
      }

      // Update clients on room size metrics (Subtracting 1 if streamer is included in list)
      const viewersCount = peers.filter(p => p.role === 'viewer').length;
      io.to(roomId).emit('room-metrics-updated', { viewerCount: viewersCount });
    });

    /**
     * Relay SDP Offer from Streamer to a specific Viewer
     */
    socket.on('send-offer', (payload: { targetId: string; sdp: any }) => {
      const { targetId, sdp } = payload;
      console.log(`[Signaling] Revezando SDP Offer de streamer ${socket.id} para viewer ${targetId}`);
      io.to(targetId).emit('receive-offer', {
        senderId: socket.id,
        sdp
      });
    });

    /**
     * Relay SDP Answer from Viewer back to the Streamer
     */
    socket.on('send-answer', (payload: { targetId: string; sdp: any }) => {
      const { targetId, sdp } = payload;
      console.log(`[Signaling] Revezando SDP Answer de viewer ${socket.id} para streamer ${targetId}`);
      io.to(targetId).emit('receive-answer', {
        senderId: socket.id,
        sdp
      });
    });

    /**
     * Relay ICE Candidates between peers (Trickle ICE)
     */
    socket.on('send-ice-candidate', (payload: { targetId: string; candidate: any }) => {
      const { targetId, candidate } = payload;
      if (targetId) {
        io.to(targetId).emit('receive-ice-candidate', {
          senderId: socket.id,
          candidate
        });
      }
    });

    /**
     * Heartbeat ping to verify websocket responsive connectivity
     */
    socket.on('heartbeat-ping', () => {
      // Update last active if streamer
      const heartbeat = activeStreamersHeartbeats.get(socket.id);
      if (heartbeat) {
        heartbeat.lastActive = Date.now();
      }
      socket.emit('heartbeat-pong');
    });

    /**
     * Connection cleanup on disconnection
     */
    socket.on('disconnect', () => {
      console.log(`[Socket.IO] Cliente desconectado da sinalização: ${socket.id}`);
      
      const socketData = socketToRoomMap.get(socket.id);
      if (!socketData) return;

      const { roomId, role, userId } = socketData;
      socketToRoomMap.delete(socket.id);
      activeStreamersHeartbeats.delete(socket.id);

      const peers = roomActivePeers.get(roomId);
      if (peers) {
        // Filter out disconnected peer
        const filteredPeers = peers.filter(p => p.socketId !== socket.id);
        
        if (filteredPeers.length === 0) {
          roomActivePeers.delete(roomId);
        } else {
          roomActivePeers.set(roomId, filteredPeers);
        }

        if (role === 'streamer') {
          console.log(`[Socket.IO] Streamer ${socket.id} desconectou. Encerrando transmissão para viewers.`);
          // Warn viewers that the screenshare stream has terminated
          socket.to(roomId).emit('streamer-left', { streamerId: socket.id });
          
          // Trigger instant room deactivation upon disconnect
          autoDeactivateRoom(roomId, userId);
        } else {
          // If viewer disconnected, notify the streamer to free peer assets
          const streamer = filteredPeers.find(p => p.role === 'streamer');
          if (streamer) {
            io.to(streamer.socketId).emit('viewer-left', { viewerId: socket.id });
          }
        }

        // Send updated metrics
        const viewersCount = filteredPeers.filter(p => p.role === 'viewer').length;
        io.to(roomId).emit('room-metrics-updated', { viewerCount: viewersCount });
      }
    });
  });
}
