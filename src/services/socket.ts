import { io, Socket } from 'socket.io-client';
import { API_URL } from '../config/api';

let socketInstance: Socket | null = null;

export function getSocket(): Socket {
  if (!socketInstance) {
    // Connect to API_URL of the backend or fallback to origin
    const targetUrl = API_URL || (typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost:3000');
    
    socketInstance = io(targetUrl, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 2000
    });

    console.log(`[Socket Services] Socket.io client initialized targeting: ${targetUrl}`);
  }
  return socketInstance;
}
