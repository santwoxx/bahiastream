import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import apiRouter from './server/routes/api';
import { setupSignaling } from './server/sockets/signaling';

// Load variables from .env
dotenv.config();

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

async function startServer() {
  const app = express();
  const httpServer = createServer(app);

  /**
   * Express middleware setups
   */
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  /**
   * Clean Custom CORS Middleware - zero external dependency footprint
   */
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
    } else {
      next();
    }
  });

  /**
   * API endpoints router configuration
   */
  app.use('/api', apiRouter);

  /**
   * Socket.IO Server configuration for WebRTC signaling
   */
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    connectTimeout: 45000
  });
  
  // Attach Socket WebRTC events
  setupSignaling(io);

  /**
   * Asset Delivery (Vite dev middleware vs. compiled build client files)
   */
  if (process.env.NODE_ENV !== 'production') {
    console.log('[Dev Engine] Integrating Vite development middleware on port 3000.');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    console.log('[Prod Engine] Backend API only mode.');
    app.get('/', (req, res) => {
      res.json({
        message: 'Bahia Stream Backend API is running successfully.',
        status: 'online',
        websocket: 'enabled',
        timestamp: new Date().toISOString()
      });
    });
  }

  // Bind to port 3000 using host 0.0.0.0
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`================================================`);
    console.log(`🚀 SCREEN SHARE SIGNALING PLATFORM SERVER RUNNING`);
    console.log(`👉 Environment : ${process.env.NODE_ENV || 'development'}`);
    console.log(`👉 Address     : http://0.0.0.0:${PORT}`);
    console.log(`================================================`);
  });
}

startServer().catch((error) => {
  console.error('[Startup Error] Failed to initialize backend server:', error);
});
