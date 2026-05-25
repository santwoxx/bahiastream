import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  X, Send, Tv, MessageSquare, Users, 
  Wifi, WifiOff, Loader2, Sparkles, AlertTriangle 
} from 'lucide-react';
import { getSocket } from '../services/socket';
import { RTC_ICE_CONFIG } from '../services/webrtc';

interface ChatMessage {
  id?: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: string;
}

interface GuestViewerProps {
  roomId: string;
  roomName: string;
  guestId: string;
  guestName: string;
  streamerId: string;
  price: string;
  onClose: () => void;
}

export const GuestViewer: React.FC<GuestViewerProps> = ({
  roomId,
  roomName,
  guestId,
  guestName,
  streamerId,
  price,
  onClose
}) => {
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'reconnecting' | 'failed'>('connecting');
  const [viewerCount, setViewerCount] = useState<number>(1);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  
  const socket = getSocket();
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const peerConnRef = useRef<RTCPeerConnection | null>(null);
  const isRemoteDescriptionSetRef = useRef(false);
  const remoteCandidatesQueueRef = useRef<any[]>([]);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Auto scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Setup WebRTC and WebSocket Signalers
  useEffect(() => {
    setConnectionStatus('connecting');
    socket.connect();

    const joinRoomAction = () => {
      socket.emit('join-room', {
        roomId,
        userId: guestId,
        role: 'viewer'
      });
    };

    joinRoomAction();

    // Sockets bindings
    socket.on('connect', () => {
      setConnectionStatus('connecting');
      joinRoomAction();
    });

    socket.on('disconnect', () => {
      setConnectionStatus('reconnecting');
    });

    socket.on('heartbeat-pong', () => {
      setConnectionStatus((prev) => (prev === 'reconnecting' || prev === 'failed' ? 'connected' : prev));
    });

    socket.on('receive-offer', async (payload: { senderId: string; sdp: any }) => {
      const { senderId, sdp } = payload;
      try {
        isRemoteDescriptionSetRef.current = false;
        remoteCandidatesQueueRef.current = [];

        if (peerConnRef.current) {
          peerConnRef.current.close();
        }

        const pc = new RTCPeerConnection(RTC_ICE_CONFIG);
        peerConnRef.current = pc;

        pc.ontrack = (event) => {
          if (event.streams && event.streams[0]) {
            setRemoteStream(event.streams[0]);
            if (videoElementRef.current) {
              videoElementRef.current.srcObject = event.streams[0];
              videoElementRef.current.play().catch(pErr => {
                console.warn('[WebRTC Guest] Autoplay blocked, waiting for user interaction:', pErr);
              });
            }
          }
        };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            socket.emit('send-ice-candidate', {
              targetId: senderId,
              candidate: event.candidate
            });
          }
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') {
            setConnectionStatus('connected');
          } else if (pc.connectionState === 'connecting') {
            setConnectionStatus('connecting');
          } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            setConnectionStatus('reconnecting');
            setTimeout(() => {
              if (socket.connected) {
                joinRoomAction();
              }
            }, 3000);
          }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        isRemoteDescriptionSetRef.current = true;

        for (const cand of remoteCandidatesQueueRef.current) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch (err) {
            console.warn('[WebRTC Guest] ICE candidate queue load failed:', err);
          }
        }
        remoteCandidatesQueueRef.current = [];

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit('send-answer', {
          targetId: senderId,
          sdp: answer
        });

      } catch (err) {
        console.error('[WebRTC Guest] Error in receipt sequence:', err);
      }
    });

    socket.on('receive-ice-candidate', async (payload: { senderId: string; candidate: any }) => {
      const { candidate } = payload;
      if (peerConnRef.current && candidate) {
        if (!isRemoteDescriptionSetRef.current) {
          remoteCandidatesQueueRef.current.push(candidate);
          return;
        }
        try {
          await peerConnRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn('[WebRTC Guest] Ice candidate add failed:', err);
        }
      }
    });

    socket.on('streamer-left', () => {
      setRemoteStream(null);
      setConnectionStatus('connecting');
    });

    socket.on('room-metrics-updated', (payload: { viewerCount: number }) => {
      setViewerCount(payload.viewerCount);
    });

    socket.on('chat-msg', (msg: ChatMessage) => {
      setChatMessages((prev) => [...prev, msg]);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('heartbeat-pong');
      socket.off('receive-offer');
      socket.off('receive-ice-candidate');
      socket.off('streamer-left');
      socket.off('room-metrics-updated');
      socket.off('chat-msg');

      if (peerConnRef.current) {
        peerConnRef.current.close();
      }
      socket.disconnect();
    };
  }, [roomId]);

  // Heartbeat loop
  useEffect(() => {
    const interval = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit('heartbeat-ping');
      } else if (socket) {
        socket.connect();
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [socket]);

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim()) return;

    const chatPayload: ChatMessage = {
      senderId: guestId,
      senderName: `${guestName} (Visitante)`,
      text: newMessage.trim(),
      timestamp: new Date().toISOString()
    };

    socket.emit('chat-msg', chatPayload);
    setNewMessage('');
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col md:flex-row h-screen w-screen overflow-hidden">
      {/* Main Video stage */}
      <div className="flex-1 relative flex flex-col bg-neutral-950 border-r border-[#2A2A2E]/50">
        
        {/* Header Ribbon bar */}
        <div className="h-14 bg-[#0E0E10] border-b border-[#2A2A2E]/40 px-4 flex items-center justify-between z-10 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#E52222] animate-pulse" />
            <h1 className="text-sm font-bold text-white font-sans max-w-[200px] md:max-w-md truncate">
              {roomName}
            </h1>
            <span className="text-[10px] font-mono bg-[#2A2A2E] text-neutral-400 py-0.5 px-2 rounded-md">
              VISITANTE
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 bg-[#141417] border border-[#2A2A2E]/60 rounded-lg px-2.5 py-1 text-[11px] font-mono">
              <Users className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-neutral-300">{viewerCount}</span>
            </div>

            <div className={`flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded-md ${
              connectionStatus === 'connected' 
                ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-800/40' 
                : 'bg-yellow-950/40 text-yellow-400 border border-yellow-800/40'
            }`}>
              {connectionStatus === 'connected' ? (
                <>
                  <Wifi className="w-3 h-3" />
                  <span className="hidden sm:inline">CONECTADO</span>
                </>
              ) : (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>RECONECTANDO</span>
                </>
              )}
            </div>

            <button 
              onClick={onClose}
              className="p-1.5 hover:bg-neutral-800 rounded-lg text-neutral-400 hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Video projection viewport */}
        <div className="flex-1 flex items-center justify-center relative bg-black select-none">
          {remoteStream ? (
            <video
              ref={videoElementRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-contain max-h-screen bg-black"
            />
          ) : (
            <div className="text-center p-6 flex flex-col items-center max-w-sm">
              <div className="w-16 h-16 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-[#3b82f6] animate-pulse mb-4 shadow-xl shadow-blue-900/10">
                <Tv className="w-8 h-8" />
              </div>
              <h3 className="text-white text-base font-bold font-sans">Aguardando início da transmissão</h3>
              <p className="text-neutral-400 text-xs mt-2 leading-relaxed font-sans">
                A transmissão já está pronta. Assim que o transmissor iniciar o compartilhamento de tela, ela aparecerá aqui.
              </p>
              <div className="mt-4 flex items-center gap-1 bg-[#141417] border border-[#2A2A2E]/60 rounded-xl px-4 py-2 font-mono text-[10px] text-blue-400">
                <Wifi className="w-3.5 h-3.5" />
                <span>CONECTADO AO CANAL</span>
              </div>
            </div>
          )}

          {/* Low watermark protection tag */}
          <div className="absolute bottom-4 right-4 bg-black/60 backdrop-blur-md border border-[#2A2A2E] rounded-md px-2.5 py-1 text-[10px] font-mono text-neutral-400 uppercase tracking-widest select-none pointer-events-none">
            BahiaStream Staging Safe Mode
          </div>
        </div>
      </div>

      {/* Side Chat box panel */}
      <div className="w-full md:w-80 bg-[#0E0E10] border-t md:border-t-0 md:border-l border-[#2A2A2E]/50 flex flex-col h-[350px] md:h-full shrink-0">
        <div className="h-12 border-b border-[#2A2A2E]/40 px-4 flex items-center gap-2 bg-[#0E0E10] shrink-0">
          <MessageSquare className="w-4 h-4 text-blue-400" />
          <h2 className="text-xs font-bold font-mono tracking-wider text-white uppercase">Chat da Transmissão</h2>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping inline-block ml-auto" />
        </div>

        {/* Dynamic chat container */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin select-text">
          <div className="bg-blue-950/20 border border-blue-900/40 rounded-xl p-3 text-left">
            <span className="text-[10px] uppercase font-mono font-bold text-blue-400 flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              Servidor Bahia Live
            </span>
            <p className="text-[11px] text-neutral-300 mt-1 font-sans">
              Bem-vindo, <strong>{guestName}</strong>! Você está assistindo a esta transmissão premium como visitante via ticket Pix autorizado. Sinta-se livre para participar do chat!
            </p>
          </div>

          <AnimatePresence>
            {chatMessages.map((msg, index) => {
              const isMe = msg.senderId === guestId;
              return (
                <motion.div
                  key={msg.id || index}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex flex-col text-left font-sans"
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[10px] font-bold ${
                      isMe ? 'text-blue-400' : 'text-neutral-400'
                    }`}>
                      {msg.senderName}
                    </span>
                    <span className="text-[8px] font-mono text-neutral-500">
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <p className="text-[11px] text-neutral-200 mt-0.5 whitespace-pre-wrap break-all leading-normal bg-neutral-900 px-2.5 py-1.5 rounded-lg border border-neutral-800/30">
                    {msg.text}
                  </p>
                </motion.div>
              );
            })}
          </AnimatePresence>
          <div ref={chatEndRef} />
        </div>

        {/* Form input messaging sender */}
        <form 
          onSubmit={handleSendChat}
          className="p-3 border-t border-[#2A2A2E]/40 bg-[#0A0A0C] flex gap-2 shrink-0"
        >
          <input
            type="text"
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onFocus={(e) => {
              setTimeout(() => {
                e.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }, 300);
            }}
            placeholder="Diga algo no chat..."
            className="flex-1 bg-[#141417] hover:bg-[#16161C] focus:bg-[#141417] outline-none max-h-10 text-[11px] border border-[#2A2A2E] focus:border-blue-500 placeholder-neutral-500 text-white rounded-lg px-3 transition-colors"
          />
          <button
            type="submit"
            className="w-10 h-10 shrink-0 bg-[#005ae6] hover:bg-[#004bb3] rounded-lg text-white font-bold text-xs flex items-center justify-center hover:scale-105 active:scale-95 transition-all cursor-pointer"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </form>
      </div>
    </div>
  );
};
