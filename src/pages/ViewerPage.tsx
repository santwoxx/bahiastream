import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { db } from '../firebase/config';
import { API_URL } from '../config/api';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { getSocket } from '../services/socket';
import { RTC_ICE_CONFIG } from '../services/webrtc';
import { 
  Tv, 
  MessageSquare, 
  Users, 
  Send, 
  ArrowLeft, 
  AlertCircle, 
  ShieldAlert, 
  Copy, 
  Check, 
  Loader2, 
  Maximize2, 
  Volume2, 
  VolumeX,
  Sparkles,
  RefreshCw,
  Clock
} from 'lucide-react';

interface ViewerPageProps {
  roomId: string;
  onExit: () => void;
}

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  time: string;
}

export const ViewerPage: React.FC<ViewerPageProps> = ({ roomId, onExit }) => {
  const { user, profile } = useAuth();
  const { showToast } = useToast();

  // Authentication access state
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [authReason, setAuthReason] = useState('');
  const [streamPrice, setStreamPrice] = useState<number>(0);
  const [streamerId, setStreamerId] = useState('');
  const [roomName, setRoomName] = useState('');
  
  // Payment states
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [paymentPending, setPaymentPending] = useState(false);
  const [checkingAccess, setCheckingAccess] = useState(false);

  // Mercado Pago automatic Pix states
  const [pixData, setPixData] = useState<{ qrCode: string; qrCodeBase64: string; copiaECola: string; paymentId: string; isMock?: boolean } | null>(null);
  const [mpPaymentStatus, setMpPaymentStatus] = useState<'idle' | 'waiting' | 'approved' | 'entering'>('idle');
  const [loadingPix, setLoadingPix] = useState(false);
  const guestIdRef = useRef<string>('');

  // Streaming media feedback
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [copiedPix, setCopiedPix] = useState(false);
  const [isMuted, setIsMuted] = useState(true);

  // Chat interface
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const videoElementRef = useRef<HTMLVideoElement>(null);
  const peerConnRef = useRef<RTCPeerConnection | null>(null);
  const socket = getSocket();

  // WebRTC pipeline state tracking
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed'>('connecting');
  const remoteCandidatesQueueRef = useRef<any[]>([]);
  const isRemoteDescriptionSetRef = useRef<boolean>(false);

  useEffect(() => {
    checkRoomAuthorization();
  }, [roomId, user]);

  // Guest or User ID tracker initialization
  useEffect(() => {
    if (user) {
      guestIdRef.current = user.uid;
    } else {
      let stored = sessionStorage.getItem('bahia_stream_guest_id');
      if (!stored) {
        stored = 'guest_' + Math.random().toString(36).substring(2, 11);
        sessionStorage.setItem('bahia_stream_guest_id', stored);
      }
      guestIdRef.current = stored;
    }
  }, [user]);

  // Real-time socket event subscription for payment approvals
  useEffect(() => {
    const s = getSocket();
    if (!s.connected) {
      s.connect();
    }

    const payerId = user?.uid || guestIdRef.current || 'guest_viewer';

    s.emit('join-room', {
      roomId,
      userId: payerId,
      role: 'viewer'
    });

    s.on('payment-approved', (data: any) => {
      console.log('[Socket] Evento de aprovação recebido:', data);
      const activePayerId = guestIdRef.current || 'guest_viewer';
      if (data.roomId === roomId && (data.payerId === user?.uid || data.payerId === activePayerId)) {
        setMpPaymentStatus('approved');
        showToast('Mercado Pago aprovou o pagamento Pix!', 'success');
        
        // Staged transition entering the live stream
        setTimeout(() => {
          setMpPaymentStatus('entering');
          setTimeout(() => {
            setAuthorized(true);
            setPaymentPending(false);
            initializeViewerSignaling();
          }, 1000);
        }, 1200);
      }
    });

    return () => {
      s.off('payment-approved');
    };
  }, [roomId, user]);

  // Fetch Pix payload automatically if user is determined as unauthorized
  useEffect(() => {
    if (authorized === false) {
      loadPixPayment();
    }
  }, [authorized]);

  const loadPixPayment = async () => {
    if (!roomId) return;
    setLoadingPix(true);
    setMpPaymentStatus('waiting');
    try {
      const viewerName = profile?.displayName || user?.displayName || user?.email || 'Visitante da Bahia';
      const payerId = user?.uid || guestIdRef.current || 'guest_viewer';

      const response = await fetch(`${API_URL}/api/payments/create-pix`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          roomId,
          userId: user?.uid ? user.uid : undefined,
          guestId: user?.uid ? undefined : payerId,
          viewerName
        })
      });

      if (response.ok) {
        const data = await response.json();
        setPixData(data);
      } else {
        const text = await response.text();
        let errorMsg = 'Erro ao carregar Pix dinâmico.';
        try {
          const parsed = JSON.parse(text);
          errorMsg = parsed.error || errorMsg;
        } catch (_) {
          errorMsg = text || errorMsg;
        }
        showToast(errorMsg, 'error');
      }
    } catch (err: any) {
      showToast(`Serviço de pagamentos offline: ${err.message}`, 'error');
    } finally {
      setLoadingPix(false);
    }
  };

  const handleSimulateApproval = async () => {
    if (!pixData?.paymentId) return;
    try {
      showToast('Simulando confirmação de Pix pago...', 'info');
      const res = await fetch(`${API_URL}/api/payments/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: pixData.paymentId,
          isMockSimulatedApproval: true
        })
      });
      if (res.ok) {
        showToast('Compensação simulada enviada!', 'success');
      } else {
        showToast('Erro ao simular aprovação.', 'error');
      }
    } catch (err: any) {
      showToast(`Falha na simulação: ${err.message}`, 'error');
    }
  };

  const copyPixCode = () => {
    if (!pixData?.copiaECola) return;
    navigator.clipboard.writeText(pixData.copiaECola);
    setCopiedPix(true);
    showToast('Código de Pix Copia e Cola capturado!', 'success');
    setTimeout(() => setCopiedPix(false), 2000);
  };

  // Handle automatic check interval for pending authorizations
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (paymentPending) {
      interval = setInterval(() => {
        pollAuthorizationQuietly();
      }, 4000);
    }
    return () => clearInterval(interval);
  }, [paymentPending]);

  const checkRoomAuthorization = async () => {
    if (!user) return;
    setCheckingAccess(true);
    try {
      const mockToken = `header.${btoa(JSON.stringify({ user_id: user.uid, email: user.email, email_verified: true }))}.signature`;
      
      // Fetch Room Details to get Name/StreamerId
      const rRes = await fetch(`${API_URL}/api/rooms`, {
        headers: { 'Authorization': `Bearer ${mockToken}` }
      });
      if (rRes.ok) {
        const roomsList = await rRes.json();
        const activeRoom = roomsList.find((r: any) => r.id === roomId);
        if (activeRoom) {
          setRoomName(activeRoom.name);
          setStreamerId(activeRoom.streamerId);
        }
      }

      // Check access permission
      const accessRes = await fetch(`${API_URL}/api/rooms/${roomId}/access`, {
        headers: { 'Authorization': `Bearer ${mockToken}` }
      });

      if (accessRes.ok) {
        const accessData = await accessRes.json();
        setAuthorized(accessData.authorized);
        setAuthReason(accessData.reason);
        
        if (accessData.price !== undefined) {
          setStreamPrice(accessData.price);
        }

        if (accessData.authorized) {
          // Trigger P2P connection logic instantly
          initializeViewerSignaling();
        }
      } else {
        setAuthorized(false);
        setAuthReason('Falha inexplicável de autorização.');
      }
    } catch (err: any) {
      setAuthorized(false);
      setAuthReason(`Rede offline: ${err.message}`);
    } finally {
      setCheckingAccess(false);
    }
  };

  const pollAuthorizationQuietly = async () => {
    if (!user) return;
    try {
      const mockToken = `header.${btoa(JSON.stringify({ user_id: user.uid, email: user.email, email_verified: true }))}.signature`;
      const accessRes = await fetch(`${API_URL}/api/rooms/${roomId}/access`, {
        headers: { 'Authorization': `Bearer ${mockToken}` }
      });
      if (accessRes.ok) {
        const accessData = await accessRes.json();
        if (accessData.authorized) {
          setAuthorized(true);
          setPaymentPending(false);
          showToast('Sua comprovação de Pix foi compensada! Sinal de vídeo liberado.', 'success');
          initializeViewerSignaling();
        }
      }
    } catch (err) {
      // Quiet fail
    }
  };

  // Setup real-time listener to automatically capture approvals or rejections
  useEffect(() => {
    if (!db || !user || !roomId) return;

    try {
      const q = query(
        collection(db, 'roomAccess'),
        where('roomId', '==', roomId),
        where('userId', '==', user.uid)
      );

      const unsubscribe = onSnapshot(q, (snapshot) => {
        if (!snapshot.empty) {
          const docData = snapshot.docs[0].data();
          if (docData.status === 'approved') {
            setAuthorized(true);
            setPaymentPending(false);
            setAuthReason('Acesso liberado em tempo real!');
            showToast('Acesso liberado via autorização realtime (roomAccess)!', 'success');
            initializeViewerSignaling();
          } else if (docData.status === 'rejected') {
            setAuthorized(false);
            setPaymentPending(false);
            setAuthReason('Acesso rejeitado pelo administrador.');
            showToast('Acesso negado para esta transmissão.', 'error');
          } else if (docData.status === 'pending') {
            setAuthorized(false);
            setPaymentPending(true);
          }
        }
      }, (error) => {
        console.warn('Realtime sync subscriber restricted or failed:', error);
      });

      return () => unsubscribe();
    } catch (err) {
      console.warn('Could not launch realtime sync subscriber fallback:', err);
    }
  }, [roomId, user]);

  // Client-side Application-level heartbeat ping loop
  useEffect(() => {
    if (!authorized) return;

    const interval = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit('heartbeat-ping');
      } else {
        setConnectionStatus('reconnecting');
        if (socket && !socket.connected) {
          socket.connect();
        }
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [authorized]);

  const initializeViewerSignaling = () => {
    if (!user) return;
    
    setConnectionStatus('connecting');
    socket.connect();
    
    const joinRoomAction = () => {
      socket.emit('join-room', {
        roomId,
        userId: user.uid,
        role: 'viewer'
      });
    };

    joinRoomAction();

    socket.off('connect');
    socket.on('connect', () => {
      showToast('Conexão restabelecida com sucesso.', 'success');
      setConnectionStatus('connecting');
      joinRoomAction();
    });

    socket.off('disconnect');
    socket.on('disconnect', (reason) => {
      console.warn(`Sinalização desconectada: ${reason}. Tentando reconexão síncrona...`);
      setConnectionStatus('reconnecting');
    });

    socket.off('heartbeat-pong');
    socket.on('heartbeat-pong', () => {
      setConnectionStatus((prev) => (prev === 'reconnecting' || prev === 'failed' ? 'connected' : prev));
    });

    socket.off('receive-offer');
    socket.on('receive-offer', async (payload: { senderId: string; sdp: any }) => {
      const { senderId, sdp } = payload;
      console.log('[LOG] OFFER_RECEIVED from', senderId);
      
      try {
        isRemoteDescriptionSetRef.current = false;
        remoteCandidatesQueueRef.current = [];

        // Clean existing connection to prevent active leaks
        if (peerConnRef.current) {
          peerConnRef.current.close();
          console.log('[WebRTC Viewer] Fechando conexão peer anterior para reinicialização.');
        }

        const pc = new RTCPeerConnection(RTC_ICE_CONFIG);
        peerConnRef.current = pc;

        // Establish incoming track handlers
        pc.ontrack = (event) => {
          console.log('[LOG] REMOTE_STREAM_ATTACHED - Track kind:', event.track.kind);
          if (event.streams && event.streams[0]) {
            setRemoteStream(event.streams[0]);
            if (videoElementRef.current) {
              videoElementRef.current.srcObject = event.streams[0];
              videoElementRef.current.play().catch(pErr => {
                console.warn('[WebRTC Viewer] Autoplay blocked, waiting for click/unmute:', pErr);
              });
            }
          } else {
            console.log('[LOG] REMOTE_STREAM_ATTACHED (no stream in event, creating)');
            const inboundStream = new MediaStream([event.track]);
            setRemoteStream(inboundStream);
            if (videoElementRef.current) {
              videoElementRef.current.srcObject = inboundStream;
              videoElementRef.current.play().catch(pErr => {
                console.warn('[WebRTC Viewer] Autoplay blocked, waiting for click/unmute:', pErr);
              });
            }
          }
        };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            socket.emit('send-ice-candidate', {
              targetId: senderId,
              candidate: event.candidate.toJSON()
            });
            console.log('[LOG] ICE_SENT to', senderId);
          }
        };

        pc.onconnectionstatechange = () => {
          console.log(`[WebRTC Viewer] ConnectionState com streamer: ${pc.connectionState}`);
          
          if (pc.connectionState === 'connected') {
            setConnectionStatus('connected');
          } else if (pc.connectionState === 'connecting') {
            setConnectionStatus('connecting');
          } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            setConnectionStatus('reconnecting');
            console.warn('[WebRTC Viewer] Conexão falhou ou desconectou. Solicitando auto-reconexão por reingresso...');
            setTimeout(() => {
              if (socket.connected && (peerConnRef.current?.connectionState === 'failed' || peerConnRef.current?.connectionState === 'disconnected')) {
                joinRoomAction();
              }
            }, 3000);
          }
        };

        pc.oniceconnectionstatechange = () => {
          console.log(`[WebRTC Viewer] ICE connectionState com streamer: ${pc.iceConnectionState}`);
          if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            setConnectionStatus('reconnecting');
            console.warn('[WebRTC Viewer] ICE desconectado ou falhou. Re-ingressando sala para reiniciar conexao...');
            setTimeout(() => {
              if (socket.connected && (peerConnRef.current?.iceConnectionState === 'failed' || peerConnRef.current?.iceConnectionState === 'disconnected')) {
                joinRoomAction();
              }
            }, 3000);
          }
        };

        // Complete offer description mapping
        await pc.setRemoteDescription(sdp);
        isRemoteDescriptionSetRef.current = true;

        // Process queued ice candidates
        for (const cand of remoteCandidatesQueueRef.current) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch (err) {
            console.warn('[WebRTC Viewer] Erro ao carregar ICE candidate pendente:', err);
          }
        }
        remoteCandidatesQueueRef.current = [];

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit('send-answer', {
          targetId: senderId,
          sdp: answer
        });
        console.log('[LOG] ANSWER_SENT to', senderId);

      } catch (err: any) {
        console.error('Error during WebRTC offer receipt:', err);
      }
    });

    socket.off('receive-ice-candidate');
    socket.on('receive-ice-candidate', async (payload: { senderId: string; candidate: any }) => {
      const { candidate, senderId } = payload;
      console.log('[LOG] ICE_RECEIVED from', senderId);
      if (peerConnRef.current && candidate) {
        if (!isRemoteDescriptionSetRef.current) {
          remoteCandidatesQueueRef.current.push(candidate);
          console.log('[WebRTC Viewer] ICE Candidate enfileirado (remote description pendente).');
          return;
        }
        try {
          await peerConnRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn('ICE Candidate failed in remote view:', err);
        }
      }
    });

    socket.off('streamer-ready');
    socket.on('streamer-ready', (payload: { streamerId: string }) => {
      console.log('[LOG] streamer-ready message received. Re-joining room/notifying streamer.');
      showToast('O transmissor está pronto! Conectando transmissão...', 'info');
      joinRoomAction();
    });

    socket.off('waiting-for-streamer');
    socket.on('waiting-for-streamer', () => {
      console.log('[LOG] waiting-for-streamer message received.');
      showToast('Aguardando o início da transmissão...', 'info');
    });

    socket.off('streamer-left');
    socket.on('streamer-left', () => {
      showToast('O transmissor encerrou a transmissão.', 'info');
      setRemoteStream(null);
    });

    socket.off('room-metrics-updated');
    socket.on('room-metrics-updated', (payload: { viewerCount: number }) => {
      setViewerCount(payload.viewerCount);
    });

    socket.off('chat-msg');
    socket.on('chat-msg', (msg: ChatMessage) => {
      setChatMessages(prev => [...prev, msg]);
    });
  };

  useEffect(() => {
    return () => {
      // Socket / Peer connection cleanup checks
      socket.off('receive-offer');
      socket.off('receive-ice-candidate');
      socket.off('streamer-ready');
      socket.off('waiting-for-streamer');
      socket.off('streamer-left');
      socket.off('room-metrics-updated');
      socket.off('chat-msg');
      
      if (peerConnRef.current) {
        peerConnRef.current.close();
      }
      
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const handleRequestPixPayment = async () => {
    if (!user || !streamerId) return;

    setPaymentSubmitting(true);
    try {
      const mockToken = `header.${btoa(JSON.stringify({ user_id: user.uid, email: user.email, email_verified: true }))}.signature`;
      const response = await fetch(`${API_URL}/api/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${mockToken}`
        },
        body: JSON.stringify({
          streamerId: streamerId,
          amount: streamPrice,
          roomId: roomId
        })
      });

      if (response.ok) {
        setPaymentPending(true);
        showToast('Instancia Pix simulada registrada. Aguardando aprovação administrativa de depósitos.', 'info');
      } else {
        const text = await response.text();
        let errorMsg = 'Erro ao registrar comprovante Pix.';
        try {
          const parsed = JSON.parse(text);
          errorMsg = parsed.error || errorMsg;
        } catch (_) {
          errorMsg = text || errorMsg;
        }
        showToast(errorMsg, 'error');
      }
    } catch (err: any) {
      showToast(`Interface offline: ${err.message}`, 'error');
    } finally {
      setPaymentSubmitting(false);
    }
  };

  const copyPixData = () => {
    const rawPixCode = `00020126580014br.gov.bcb.pix0114t_rt_cast_00010214SaoPaulo050300154013RSC54${streamPrice}0005BR1025684A12B3B9C182`;
    navigator.clipboard.writeText(rawPixCode);
    setCopiedPix(true);
    showToast('Código de Pix Copia e Cola capturado para área de transferência!', 'success');
    setTimeout(() => setCopiedPix(false), 2000);
  };

  const handleSendChatMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    const newMsg: ChatMessage = {
      id: Math.random().toString(36).substring(2, 9),
      sender: profile?.displayName || user?.displayName || user?.email || 'Spectator',
      text: chatInput,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    socket.emit('chat-msg', newMsg);
    setChatMessages(prev => [...prev, newMsg]);
    setChatInput('');
  };

  const toggleFullscreen = () => {
    if (videoElementRef.current) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        videoElementRef.current.requestFullscreen().catch(() => {
          showToast('Modo de tela cheia bloqueado pelo navegador.', 'warn');
        });
      }
    }
  };

  return (
    <div className="flex-1 w-full max-w-7xl mx-auto px-4 py-6 flex flex-col h-[calc(100vh-80px)] overflow-hidden">
      
      {/* 1. TOP ROOM INFO BAR */}
      <div className="bg-[#0E0E10] border border-[#2A2A2E] rounded-xl p-4 flex items-center justify-between shrink-0 mb-5">
        <div className="flex items-center gap-3">
          <button
            onClick={onExit}
            className="p-2 hover:bg-[#141417] border border-[#2A2A2E] text-neutral-400 hover:text-white rounded-lg transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-[#005ae6] bg-[#005ae6]/10 px-2 py-0.5 rounded border border-[#005ae6]/25 uppercase font-bold tracking-wider">AO VIVO</span>
            </div>
            <h1 className="text-sm font-bold text-neutral-200 mt-1 truncate max-w-[240px] md:max-w-md uppercase">{roomName || 'Visualização Remota'}</h1>
          </div>
        </div>

        {authorized && (
          <div className="flex items-center gap-2 text-xs font-mono">
            {/* SIGNAL STATUS */}
            <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono text-[#8E8E99] bg-[#141417] border border-[#2A2A2E] px-2.5 py-1.5 rounded-lg">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span>CONECTADO</span>
            </div>
            
            {/* WEBRTC CONNECTION STATUS */}
            <div className={`flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1.5 rounded-lg border ${
              connectionStatus === 'connected' ? 'bg-emerald-950/20 text-emerald-400 border-emerald-850/30' :
              connectionStatus === 'connecting' ? 'bg-blue-950/20 text-blue-400 border-blue-900/30' :
              connectionStatus === 'reconnecting' ? 'bg-amber-950/20 text-amber-500 border-amber-900/30' :
              connectionStatus === 'failed' ? 'bg-red-950/20 text-red-500 border-red-900/30 font-bold' :
              'bg-neutral-950/20 text-neutral-400 border-neutral-800/20'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                connectionStatus === 'connected' ? 'bg-emerald-500 animate-pulse' :
                connectionStatus === 'connecting' ? 'bg-blue-500 animate-pulse' :
                connectionStatus === 'reconnecting' ? 'bg-amber-500 animate-bounce' :
                connectionStatus === 'failed' ? 'bg-red-500 animate-ping' :
                'bg-neutral-500'
              }`} />
              <span className="uppercase">{connectionStatus}</span>
            </div>
          </div>
        )}
      </div>

      {checkingAccess ? (
        // Loading state
        <div className="flex-1 flex flex-col items-center justify-center p-8">
          <Loader2 className="w-10 h-10 text-[#005ae6] animate-spin mb-3" />
          <p className="text-xs font-mono text-neutral-400">Verificando credenciais e regimento ABAC...</p>
        </div>
      ) : authorized === false ? (
        
        // 2. MODERN MERCADO PAGO AUTOMATIC PIX GATEWAY OVERLAY
        <div className="flex-1 flex flex-col justify-center items-center max-w-3xl mx-auto w-full gap-6 px-1">
          <div className="bg-[#0E0E10] border border-[#2A2A2E] p-6 rounded-3xl w-full flex flex-col relative overflow-hidden shadow-2xl">
            <div className="absolute top-0 left-0 w-full h-1.5 bg-amber-500 bg-gradient-to-r from-amber-500 to-orange-600 animate-pulse" />
            
            <div className="flex flex-col sm:flex-row gap-5">
              <div className="p-3 bg-amber-500/10 border border-amber-500/20 text-amber-500 rounded-2xl h-fit w-fit mx-auto sm:mx-0">
                <ShieldAlert className="w-7 h-7" />
              </div>
              <div className="flex-1 text-center sm:text-left">
                <h2 className="text-base font-extrabold text-white font-mono tracking-tight text-amber-500 uppercase">Bahia Stream • Live Privada</h2>
                <p className="text-xs text-neutral-400 mt-1.5 leading-relaxed">
                  Esta transmissão é um ambiente premium promovido pelo streamer <span className="text-neutral-200 font-mono font-bold">@{streamerId ? streamerId.substring(0, 10) : 'streamer_id'}...</span>. O acesso é liberado instantaneamente na rede após a confirmação automática do Pix.
                </p>

                {loadingPix ? (
                  <div className="flex flex-col items-center justify-center p-12 text-center bg-[#0A0A0C] border border-[#2A2A2E]/50 rounded-2xl mt-6">
                    <Loader2 className="w-8 h-8 text-[#005ae6] animate-spin mb-3" />
                    <p className="text-xs font-mono text-zinc-400">Solicitando código Pix oficial ao Mercado Pago...</p>
                    <p className="text-[10px] text-zinc-600 mt-1">Aguarde, gerando cobrança segura síncrona...</p>
                  </div>
                ) : (
                  <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-5">
                    
                    {/* QR Code Container and Pricing */}
                    <div className="bg-[#0A0A0C] border border-[#2A2A2E] p-5 rounded-2xl flex flex-col items-center justify-center text-center shadow-inner relative">
                      <div className="bg-white p-3.5 rounded-2xl block border border-neutral-250 hover:scale-[1.02] transition-transform duration-250">
                        {pixData?.qrCodeBase64 ? (
                          <img
                            src={pixData.qrCodeBase64.startsWith('data:image') ? pixData.qrCodeBase64 : `data:image/png;base64,${pixData.qrCodeBase64}`}
                            className="w-36 h-36 select-all object-contain inline-block filter contrast-125"
                            referrerPolicy="no-referrer"
                            alt="Mercado Pago Pix QR Code"
                          />
                        ) : (
                          <div className="w-36 h-36 flex flex-col items-center justify-center text-zinc-500 bg-neutral-900 border border-dashed border-neutral-800 rounded-xl">
                            <AlertCircle className="w-6 h-6 text-neutral-600 mb-1" />
                            <span className="text-[9px] font-mono">Erro ao renderizar QR</span>
                          </div>
                        )}
                      </div>

                      <span className="text-[9px] font-mono text-[#6B6B76] mt-4 uppercase tracking-wider">Valor síncrono da Live</span>
                      <span className="text-lg font-mono font-black text-amber-400 mt-0.5">R$ {streamPrice.toFixed(2)} BRL</span>
                    </div>

                    {/* Operational Instructions & Live Compensation Progress Tracker */}
                    <div className="flex flex-col justify-between py-1.5 text-left">
                      <div className="space-y-4">
                        <h4 className="text-xs font-bold text-neutral-200 uppercase tracking-widest font-mono flex items-center justify-center sm:justify-start gap-1.5 border-b border-[#2A2A2E]/50 pb-2">
                          <Sparkles className="w-4 h-4 text-amber-400 shrink-0" /> Status da Compensação
                        </h4>

                        {/* Visual Step-by-Step real-time Status Alerts */}
                        <div className="space-y-3">
                          {mpPaymentStatus === 'waiting' && (
                            <div className="p-3 bg-blue-950/25 border border-blue-900/40 rounded-xl flex items-center gap-3 animate-pulse">
                              <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
                              <div className="font-mono leading-tight">
                                <span className="font-bold text-[10px] text-blue-400 uppercase block tracking-wider">Aguardando Pagamento</span>
                                <span className="text-[9px] text-neutral-400">Pague no app do banco e aguarde. O acesso é liberado sem refresh!</span>
                              </div>
                            </div>
                          )}

                          {mpPaymentStatus === 'approved' && (
                            <div className="p-3 bg-emerald-950/20 border border-emerald-900/40 rounded-xl flex items-center gap-3">
                              <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                              <div className="font-mono leading-tight">
                                <span className="font-bold text-[10px] text-emerald-400 uppercase block tracking-wider">Pagamento Aprovado ✓</span>
                                <span className="text-[9px] text-neutral-300">Autenticando acesso no Bahia Stream...</span>
                              </div>
                            </div>
                          )}

                          {mpPaymentStatus === 'entering' && (
                            <div className="p-3 bg-teal-950/20 border border-teal-900/40 rounded-xl flex items-center gap-3">
                              <Tv className="w-4 h-4 text-teal-400 shrink-0 animate-bounce" />
                              <div className="font-mono leading-tight">
                                <span className="font-bold text-[10px] text-teal-400 uppercase block tracking-wider">Entrando na Live</span>
                                <span className="text-[9px] text-neutral-300">Conectando canal de vídeo...</span>
                              </div>
                            </div>
                          )}

                          <p className="text-[10px] text-neutral-500 leading-relaxed font-sans mt-1">
                            Abra o aplicativo de pagamentos do seu banco, escolha a opção "Pagar via Pix QR Code" e escaneie a imagem. Se preferir, use o Pix Copia e Cola abaixo.
                          </p>
                        </div>
                      </div>

                      <div className="space-y-2 mt-5">
                        <button
                          onClick={copyPixCode}
                          disabled={!pixData?.copiaECola}
                          className="w-full flex items-center justify-center gap-2 bg-[#141417] hover:bg-[#1c1c22] disabled:opacity-50 border border-[#2A2A2E] text-xs font-mono font-bold text-neutral-200 py-2.5 rounded-xl cursor-pointer transition-colors shadow-sm"
                        >
                          {copiedPix ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                          <span>{copiedPix ? 'Copia e Cola Copiado!' : 'Copiar Pix Copia e Cola'}</span>
                        </button>

                        {/* Interactive simulation tool for developers inside sandbox */}
                        {pixData?.isMock && (
                          <div className="mt-4 p-3.5 bg-indigo-950/20 border border-indigo-900/30 rounded-2xl text-center relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-1 text-[7px] font-mono text-indigo-400 font-bold tracking-wider">DEV MODE</div>
                            <p className="text-[9px] font-mono text-indigo-300 mb-2">Simule a aprovação do Pix para testar o tempo real:</p>
                            <button
                              onClick={handleSimulateApproval}
                              className="w-full bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-mono font-bold text-[10px] py-2 rounded-xl cursor-pointer transition-all shadow-md shadow-indigo-500/15"
                            >
                              ⚡ Simular Aprovação do Pix (Gateway Sandbox)
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                  </div>
                )}

              </div>
            </div>

          </div>
        </div>

      ) : (

        // 3. ACTUAL STREAM FEED PLAYER & CHAT AREA
        <div className="flex-1 flex flex-col xl:flex-row gap-6 h-full xl:h-full min-h-0 overflow-y-auto xl:overflow-hidden">
          
          {/* Broadcaster render viewport */}
          <div className="flex-initial xl:flex-1 flex flex-col gap-4 min-w-0 h-auto xl:h-full shrink-0 xl:shrink overflow-y-visible xl:overflow-y-auto pr-1">
            <div className="bg-[#0E0E10] border border-[#2A2A2E] rounded-2xl relative aspect-video overflow-hidden group flex items-center justify-center shadow-lg bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-neutral-900 via-[#0E0E10] to-[#0A0A0C]">
              
              <video
                ref={videoElementRef}
                autoPlay
                playsInline
                muted={isMuted}
                className={`w-full h-full object-contain ${remoteStream ? 'block' : 'hidden'} ${
                  connectionStatus === 'reconnecting' || connectionStatus === 'failed' ? 'opacity-45 filter blur-[2px]' : ''
                } transition-all duration-300`}
              />

              {!remoteStream && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 text-[#6B6B76]">
                  <RefreshCw className="w-10 h-10 mb-3 text-[#005ae6] animate-spin" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-300">Conectando ao Sinal WebRTC</h3>
                  <p className="text-xs text-neutral-500 max-w-sm mt-1 leading-relaxed">Carregando canais de dados e estabelecendo sessões ponto-a-ponto síncronas...</p>
                </div>
              )}

              {remoteStream && connectionStatus === 'reconnecting' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 text-center p-6 text-amber-500">
                  <RefreshCw className="w-8 h-8 mb-2 text-amber-400 animate-spin" />
                  <h3 className="text-xs font-bold font-mono uppercase tracking-wider">Conexão Instável • Re-Sincronizando</h3>
                  <p className="text-[10px] text-zinc-400 mt-1 max-w-xs leading-relaxed">
                    Sinal WebRTC fraco ou oscilando. Tentando restabelecer conexão de vídeo ponto-a-ponto de forma automática...
                  </p>
                </div>
              )}

              {remoteStream && connectionStatus === 'failed' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 text-center p-6 text-red-500">
                  <AlertCircle className="w-8 h-8 mb-2 text-red-500 animate-pulse" />
                  <h3 className="text-xs font-bold font-mono uppercase tracking-wider text-red-400">Falha na Conexão</h3>
                  <p className="text-[10px] text-zinc-400 mt-1 max-w-xs leading-relaxed">
                    Não foi possível manter o feed ponto-a-ponto ativo. Clique abaixo para forçar recarregamento síncrono.
                  </p>
                  <button
                    onClick={() => {
                      showToast('Forçando reinicialização do peer...', 'info');
                      initializeViewerSignaling();
                    }}
                    className="mt-3.5 bg-[#ef4444]/20 hover:bg-[#ef4444]/30 border border-[#ef4444]/30 text-white font-mono font-bold text-[10px] px-4 py-2 rounded-lg cursor-pointer transition-colors shadow-lg"
                  >
                    Tentar Reiniciar Sinal
                  </button>
                </div>
              )}

              {remoteStream && (
                <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity bg-black/80 backdrop-blur-md px-3.5 py-2 rounded-xl border border-[#2A2A2E]">
                  <div className="flex items-center gap-2 text-[10px] font-mono">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span>Live (Conectado Peer-To-Peer)</span>
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setIsMuted(prev => !prev)}
                      className="text-neutral-400 hover:text-white transition-colors cursor-pointer mr-1"
                      title={isMuted ? "Ativar Som" : "Mutar Áudio"}
                    >
                      {isMuted ? <VolumeX className="w-4 h-4 text-neutral-500" /> : <Volume2 className="w-4 h-4 text-emerald-400" />}
                    </button>
                    
                    <button
                      onClick={() => {
                        showToast('Forçando reinicialização do peer...', 'info');
                        initializeViewerSignaling();
                      }}
                      className="text-neutral-400 hover:text-white transition-colors cursor-pointer mr-1"
                      title="Reiniciar Conexão"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>

                    <button
                      onClick={toggleFullscreen}
                      className="text-neutral-400 hover:text-white transition-colors cursor-pointer"
                      title="Tela Cheia"
                    >
                      <Maximize2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Quick spec cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-mono shrink-0">
              <div className="bg-[#0E0E10] border border-[#2A2A2E] p-3 rounded-xl">
                <span className="text-[8px] text-[#6B6B76] uppercase">Código da transmissão</span>
                <div className="text-xs font-bold text-neutral-200 mt-0.5 truncate">{roomId}</div>
              </div>
              <div className="bg-[#0E0E10] border border-[#2A2A2E] p-3 rounded-xl">
                <span className="text-[8px] text-[#6B6B76] uppercase">Qualidade do Vídeo</span>
                <div className="text-xs font-bold text-emerald-400 mt-0.5">Alta Definição</div>
              </div>
              <div className="bg-[#0E0E10] border border-[#2A2A2E] p-3 rounded-xl">
                <span className="text-[8px] text-[#6B6B76] uppercase">Latência</span>
                <div className="text-xs font-bold text-blue-400 mt-0.5">Ultrabaixa</div>
              </div>
            </div>
          </div>

          {/* Right Live chat interface */}
          <div className="w-full xl:w-80 bg-[#0E0E10] border border-[#2A2A2E] rounded-2xl h-[320px] sm:h-[400px] xl:h-full flex flex-col justify-between shrink-0">
            
            {/* Header chat metadata */}
            <div className="p-4 border-b border-[#2A2A2E] flex justify-between items-center shrink-0 bg-[#141417]/30 rounded-t-2xl">
              <span className="text-xs font-bold uppercase tracking-wider text-[#6B6B76] font-mono flex items-center gap-1.5">
                <MessageSquare className="w-4 h-4 text-[#aa9df3]" />
                <span>Chat em Tempo Real</span>
              </span>

              <div className="flex items-center gap-1 text-[10px] font-mono bg-emerald-950/40 text-emerald-400 border border-emerald-900/30 px-2 py-0.5 rounded">
                <Users className="w-3 h-3" />
                <span>{viewerCount} Assistindo</span>
              </div>
            </div>

            {/* Chat list */}
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 min-h-0">
              {chatMessages.length === 0 ? (
                <div className="my-auto text-center p-4">
                  <MessageSquare className="w-8 h-8 text-neutral-800 mx-auto mb-2" />
                  <h4 className="text-[11px] font-mono uppercase text-[#8E8E99]">Nenhuma mensagem ainda</h4>
                  <p className="text-[10px] text-neutral-500 mt-0.5 leading-snug">Envie uma pergunta ou comentário.</p>
                </div>
              ) : (
                chatMessages.map((msg) => (
                  <div key={msg.id} className="text-xs leading-relaxed bg-[#0A0A0C]/50 border border-[#2A2A2E]/40 p-2.5 rounded-xl font-sans">
                    <div className="flex justify-between items-baseline mb-0.5">
                      <span className="font-bold text-neutral-300 truncate max-w-[120px]">{msg.sender}</span>
                      <span className="text-[9px] font-mono text-neutral-600 shrink-0">{msg.time}</span>
                    </div>
                    <p className="text-neutral-400 break-all">{msg.text}</p>
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Footer chat bar input */}
            <form onSubmit={handleSendChatMessage} className="p-3 border-t border-[#2A2A2E] bg-[#0A0A0C]/40 rounded-b-2xl">
              <div className="flex gap-1.5 bg-[#0A0A0C] border border-[#2A2A2E] rounded-xl p-1/2 shrink-0">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onFocus={(e) => {
                    setTimeout(() => {
                      e.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    }, 300);
                  }}
                  placeholder="Comente na live..."
                  className="flex-1 bg-transparent px-3 py-1.5 text-xs text-neutral-200 placeholder-neutral-700 outline-none"
                />
                <button
                  type="submit"
                  className="p-2 bg-[#005ae6] hover:bg-[#004bb3] text-white rounded-lg transition-colors cursor-pointer shrink-0"
                  title="Enviar mensagem"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </form>

          </div>

        </div>
      )}

    </div>
  );
};
