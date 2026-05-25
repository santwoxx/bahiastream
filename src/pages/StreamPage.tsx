import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { getSocket } from '../services/socket';
import { API_URL } from '../config/api';
import { RTC_ICE_CONFIG } from '../services/webrtc';
import { 
  Tv, 
  Users, 
  Terminal, 
  Video, 
  Copy, 
  Check, 
  X, 
  Send, 
  Play, 
  Square, 
  Activity, 
  AlertTriangle,
  Volume2,
  VolumeX,
  MessageSquare,
  Sliders,
  Wifi
} from 'lucide-react';

interface StreamPageProps {
  roomId: string;
  onExit: () => void;
}

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  time: string;
}

export const StreamPage: React.FC<StreamPageProps> = ({ roomId, onExit }) => {
  const { user, profile } = useAuth();
  const { showToast } = useToast();

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [viewersList, setViewersList] = useState<string[]>([]);
  const [isAudioEnabled, setIsAudioEnabled] = useState(false);
  const [quality, setQuality] = useState<'1080p' | '720p' | '480p'>('1080p');
  
  // Chat state
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Technical Diagnostics logs
  const [diagnosticsLogs, setDiagnosticsLogs] = useState<string[]>([
    'Canal de sinalização inicializado.',
    `Aguardando ativação do dispositivo na sala: ${roomId}`
  ]);

  const addLog = (text: string) => {
    const time = new Date().toLocaleTimeString();
    setDiagnosticsLogs(prev => [`[${time}] ${text}`, ...prev].slice(0, 30));
  };

  const videoElementRef = useRef<HTMLVideoElement>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const socket = getSocket();

  // WebRTC technical tracking states
  const [socketStatus, setSocketStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const peerCandidatesQueueRef = useRef<Map<string, any[]>>(new Map());

  // WebRTC Live Diagnostics HUD states
  const [showDiagHUD, setShowDiagHUD] = useState(false);
  const [peerStats, setPeerStats] = useState<any[]>([]);
  const prevStatsRef = useRef<Map<string, { bytesSent: number; packetsSent: number; packetsLost: number; timestamp: number }>>(new Map());

  useEffect(() => {
    // We do not call startScreenShare() here on mount to avoid violating
    // Chrome's user gesture security policies (transient activation).
    return () => {
      stopScreenShare();
    };
  }, []);

  useEffect(() => {
    if (!user || !stream) return;

    // Connect and Join ROOM
    socket.connect();
    
    const joinRoomPayload = () => {
      socket.emit('join-room', {
        roomId,
        userId: user.uid,
        role: 'streamer'
      });
      addLog(`Ingresso na sala emitido em papel de STREAMER.`);
    };

    joinRoomPayload();

    // Client-side Heartbeat Ping Loop to keep streaming container connection alive
    const pingInterval = setInterval(() => {
      if (socket.connected) {
        socket.emit('heartbeat-ping');
        console.log('[Heartbeat Streamer] Ping enviado com sucesso para manter transmissão ativa.');
      }
    }, 12000);

    // Socket status loggers
    socket.off('connect');
    socket.on('connect', () => {
      addLog(`[REDE] Conexão restabelecida com o servidor de sinalização.`);
      setSocketStatus('connected');
      joinRoomPayload();
    });

    socket.off('disconnect');
    socket.on('disconnect', (reason) => {
      addLog(`[REDE] Sinalização desconectada: ${reason}. Tentando reconectar automaticamente...`);
      setSocketStatus('disconnected');
    });

    // SOCKET LISTENERS

    socket.off('viewer-joined');
    socket.on('viewer-joined', async (payload: { viewerId: string; userId: string }) => {
      const { viewerId, userId } = payload;
      addLog(`Espectador conectando: ${viewerId} (${userId})`);
      setViewersList(prev => [...new Set([...prev, userId])]);

      try {
        peerCandidatesQueueRef.current.set(viewerId, []);

        // Clean any duplicate connection for this userId (prevents viewers fantasmas)
        for (const [existingViewerId, existingPc] of peersRef.current.entries()) {
          if ((existingPc as any).userId === userId) {
            existingPc.close();
            peersRef.current.delete(existingViewerId);
            peerCandidatesQueueRef.current.delete(existingViewerId);
            addLog(`Inutilizada conexão redundante obsoleta anterior para o espectador ${userId}`);
          }
        }

        // Clean existing connection for this specific viewerId socket
        const existingPc = peersRef.current.get(viewerId);
        if (existingPc) {
          existingPc.close();
          addLog(`Inutilizada conexão redundante obsoleta para o espectador ${viewerId}`);
        }

        // Instantiate real RTCPeerConnection for the viewer
        const pc = new RTCPeerConnection(RTC_ICE_CONFIG);
        (pc as any).userId = userId;
        peersRef.current.set(viewerId, pc);

        // Feed local stream video and audio tracks
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => {
            const sender = pc.addTrack(track, streamRef.current!);
            
            // Set dynamic encoding priorities
            if (track.kind === 'video') {
              track.contentHint = 'detail'; // optimize for screensharing detail
              try {
                const params = sender.getParameters();
                if (!params.encodings) params.encodings = [{}];
                if (params.encodings[0]) {
                  params.encodings[0].networkPriority = 'high';
                  params.encodings[0].priority = 'high';
                  params.encodings[0].maxBitrate = quality === '1085p' || (quality as string) === '1080p' ? 4000000 : (quality === '720p' ? 2000000 : 800000);
                }
                sender.setParameters(params).catch(e => console.warn('Erro ao configurar bitrates iniciais:', e));
              } catch (e) {
                console.warn('Erro ao parametrizar sender de video:', e);
              }
            }
          });
          addLog(`Tracks do display inseridos com prioridade de rede em ${viewerId}`);
        } else {
          addLog(`AVISO: Espectador conectado mas nenhuma track de vídeo está ativa.`);
        }

        // Handle candidate gatherings
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            socket.emit('send-ice-candidate', {
              targetId: viewerId,
              candidate: event.candidate.toJSON()
            });
            console.log('[LOG] ICE_SENT to', viewerId);
          }
        };

        pc.onconnectionstatechange = () => {
          addLog(`Estado de conexão com ${viewerId}: ${pc.connectionState}`);
        };

        pc.oniceconnectionstatechange = async () => {
          addLog(`Física (ICE) com ${viewerId}: ${pc.iceConnectionState}`);
          if (pc.iceConnectionState === 'failed') {
            addLog(`ICE falhou com ${viewerId}. Solicitando reinício de ICE automático...`);
            try {
              const offer = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(offer);
              socket.emit('send-offer', {
                targetId: viewerId,
                sdp: offer
              });
              addLog(`ICE Restart SDP Offer disparado com sucesso para ${viewerId}`);
            } catch (err: any) {
              addLog(`Erro ao acionar auto ICE Restart para ${viewerId}: ${err.message}`);
            }
          }
        };

        // Create initial SDP OFFER
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.emit('send-offer', {
          targetId: viewerId,
          sdp: offer
        });

        addLog(`SDP Offer emitida para ${viewerId}`);
        console.log('[LOG] OFFER_SENT to', viewerId);
      } catch (err: any) {
        addLog(`Erro ao criar peer para ${viewerId}: ${err.message}`);
      }
    });

    socket.off('receive-answer');
    socket.on('receive-answer', async (payload: { senderId: string; sdp: any }) => {
      const { senderId, sdp } = payload;
      addLog(`SDP Answer recebida de ${senderId}`);
      console.log('[LOG] ANSWER_RECEIVED from', senderId);
      
      const pc = peersRef.current.get(senderId);
      if (pc) {
        try {
          await pc.setRemoteDescription(sdp);
          addLog(`SDP remoto configurado com sucesso para ${senderId}`);

          // Process queued ICE candidates
          const queue = peerCandidatesQueueRef.current.get(senderId) || [];
          for (const cand of queue) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(cand));
            } catch (err: any) {
              console.warn('Erro ao configurar ICE candidate enfileirado:', err);
            }
          }
          peerCandidatesQueueRef.current.delete(senderId);
        } catch (err: any) {
          addLog(`Erro ao carregar setup SDP de ${senderId}: ${err.message}`);
        }
      }
    });

    socket.off('receive-ice-candidate');
    socket.on('receive-ice-candidate', async (payload: { senderId: string; candidate: any }) => {
      const { senderId, candidate } = payload;
      console.log('[LOG] ICE_RECEIVED from', senderId);
      const pc = peersRef.current.get(senderId);
      if (pc && candidate) {
        if (!pc.remoteDescription) {
          if (!peerCandidatesQueueRef.current.has(senderId)) {
            peerCandidatesQueueRef.current.set(senderId, []);
          }
          peerCandidatesQueueRef.current.get(senderId)!.push(candidate);
          addLog(`[WebRTC] ICE candidate enfileirado para ${senderId} (SDP remoto pendente).`);
          return;
        }
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err: any) {
          console.warn('Erro ao configurar ICE candidate:', err);
        }
      }
    });

    socket.off('viewer-left');
    socket.on('viewer-left', (payload: { viewerId: string }) => {
      const { viewerId } = payload;
      addLog(`Espectador encerrou recepção de sinal: ${viewerId}`);
      
      const pc = peersRef.current.get(viewerId);
      if (pc) {
        pc.close();
        peersRef.current.delete(viewerId);
      }
    });

    socket.off('room-metrics-updated');
    socket.on('room-metrics-updated', (payload: { viewerCount: number }) => {
      setViewerCount(payload.viewerCount);
    });

    socket.off('chat-msg');
    socket.on('chat-msg', (msg: ChatMessage) => {
      setChatMessages(prev => [...prev, msg]);
    });

    return () => {
      // Clear heartbeat ping interval
      clearInterval(pingInterval);

      // Disconnection cleanup loops
      socket.off('connect');
      socket.off('disconnect');
      socket.off('viewer-joined');
      socket.off('receive-answer');
      socket.off('receive-ice-candidate');
      socket.off('viewer-left');
      socket.off('room-metrics-updated');
      socket.off('chat-msg');
      
      peersRef.current.forEach(pc => pc.close());
      peersRef.current.clear();
      
      socket.disconnect();
    };
  }, [roomId, user, stream]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // WebRTC Stats Periodic Poller (Runs every 1 second when stream is active)
  useEffect(() => {
    if (!stream) {
      setPeerStats([]);
      return;
    }

    const intervalId = setInterval(async () => {
      const statsList: any[] = [];

      for (const [viewerId, pc] of peersRef.current.entries()) {
        const userId = (pc as any).userId || 'Desconhecido';
        let bitrate = 0;
        let packetLoss = 0;
        let rtt = 0;
        let resolution = '1920x1080'; // default target spec fallback
        let fps = 30; // target spec fallback
        let jitter = 0;
        let qualityLimitation = 'none';
        let activeTracksCount = 0;

        try {
          if (pc.signalingState === 'closed') {
            continue;
          }

          const statsReport = await pc.getStats();
          let bytesSentNow = 0;
          let packetsSentNow = 0;
          let packetsLostNow = 0;
          const timestampNow = Date.now();

          // Count tracks being forwarded to check if media transmission exists
          pc.getSenders().forEach(sender => {
            if (sender.track) activeTracksCount++;
          });

          statsReport.forEach((report) => {
            // Outbound Video track metrics
            if (report.type === 'outbound-rtp' && report.kind === 'video') {
              bytesSentNow = report.bytesSent || 0;
              packetsSentNow = report.packetsSent || 0;
              qualityLimitation = report.qualityLimitationReason || 'none';
              if (report.frameWidth && report.frameHeight) {
                resolution = `${report.frameWidth}x${report.frameHeight}`;
              }
              if (report.framesPerSecond) {
                fps = report.framesPerSecond;
              }
            }

            // Remote Inbound track statistics returned from viewer
            if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
              packetsLostNow = report.packetsLost || 0;
              jitter = (report.jitter || 0) * 1000; // ms
              rtt = (report.roundTripTime || 0) * 1000; // ms
            }
          });

          // Calculate bit rate and packet loss ratios over delta
          const prev = prevStatsRef.current.get(viewerId);
          if (prev) {
            const timeDiffSec = (timestampNow - prev.timestamp) / 1000;
            if (timeDiffSec > 0) {
              const bytesDiff = bytesSentNow - prev.bytesSent;
              const packetsSentDiff = packetsSentNow - prev.packetsSent;
              const packetsLostDiff = packetsLostNow - prev.packetsLost;

              // Bitrate in kbps
              bitrate = Math.max(0, Math.round(((bytesDiff * 8) / timeDiffSec) / 1000));

              // Safe loss ratio
              if (packetsSentDiff > 0 && packetsLostDiff > 0) {
                packetLoss = Math.round((packetsLostDiff / (packetsSentDiff + packetsLostDiff)) * 1000) / 10;
              } else if (packetsLostNow > 0 && packetsSentNow > 0) {
                packetLoss = Math.round((packetsLostNow / (packetsSentNow + packetsLostNow)) * 1000) / 10;
              }
            }
          }

          // Cache current snapshots for future differentials
          prevStatsRef.current.set(viewerId, {
            bytesSent: bytesSentNow,
            packetsSent: packetsSentNow,
            packetsLost: packetsLostNow,
            timestamp: timestampNow
          });

          statsList.push({
            viewerId,
            userId,
            connectionState: pc.connectionState,
            iceConnectionState: pc.iceConnectionState,
            signalingState: pc.signalingState,
            bitrate,
            packetLoss,
            rtt: Math.round(rtt),
            jitter: Math.round(jitter),
            resolution,
            fps,
            qualityLimitation,
            activeTracksCount
          });
        } catch (err) {
          console.warn(`[WebRTC Stats Poller] Falha ao ler conexão para ${viewerId}:`, err);
        }
      }

      setPeerStats(statsList);
    }, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, [stream]);

  const streamRef = useRef<MediaStream | null>(null);

  // High performance Display Capturer
  const startScreenShare = async () => {
    console.log('[LOG] Starting screen capture');
    setStreamError(null);
    addLog('Iniciando captura de ecrã/tela...');

    // 9. Fallback check before calling getDisplayMedia
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      console.error('[LOG] navigator.mediaDevices.getDisplayMedia is NOT available.');
      const errorMsg = 'API de captura de tela não disponível (getDisplayMedia inexistente). Certifique-se de que está usando HTTPS/Modo Seguro.';
      addLog(`[LOG] Display media denied: ${errorMsg}`);
      setStreamError(errorMsg);
      showToast(errorMsg, 'error');
      return;
    }

    try {
      console.log('[LOG] Requesting display media');
      addLog('Solicitando getDisplayMedia ao navegador...');

      const captureStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 }
        },
        audio: isAudioEnabled
      });

      console.log('[LOG] Display media granted');
      addLog('Permissão concedida pelo sistema!');

      streamRef.current = captureStream;
      setStream(captureStream);
      addLog(`Captura ativa! ID da Track: ${captureStream.getVideoTracks()[0]?.id}`);
      console.log('[LOG] STREAM_CAPTURE_STARTED');

      if (videoElementRef.current) {
        console.log('[LOG] Rendering stream immediately to <video> element');
        videoElementRef.current.srcObject = captureStream;
        videoElementRef.current.play()
          .then(() => {
            console.log('[LOG] Video element playback succeeded.');
          })
          .catch((playErr) => {
            console.warn('[LOG] Video playback failed or autoplay was blocked:', playErr);
            addLog(`AVISO ao reproduzir vídeo: ${playErr.message}`);
          });
      }

      // Add tracks to any pre-connected peers (recovery edge-case)
      peersRef.current.forEach((pc) => {
        captureStream.getTracks().forEach(track => {
          pc.addTrack(track, captureStream);
        });
      });

      // Listening to manually stopping stream from browser toolbar
      captureStream.getVideoTracks()[0].onended = () => {
        addLog('Captura finalizada pelo usuário através do navegador.');
        stopScreenShare();
      };

    } catch (err: any) {
      console.error('[LOG] Display media denied. Error details:', err);
      const reason = err.name === 'NotAllowedError'
        ? 'Permissão negada ou compartilhamento cancelado pelo usuário.'
        : err.message || 'Permissão negada para captura de tela.';
      
      setStreamError(reason);
      addLog(`[LOG] Display media denied: ${reason}`);
      showToast(`Erro na captura: ${reason}`, 'error');
    }
  };

  const stopScreenShare = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setStream(null);
    addLog('Captura encerrada localmente.');
  };

  const handleToggleAudio = () => {
    const newState = !isAudioEnabled;
    setIsAudioEnabled(newState);
    addLog(`Configuração de captura de áudio modificada para: ${newState ? 'ATIVO' : 'DESATIVADO'}`);
    showToast(`Áudio de transmissão ${newState ? 'habilitado' : 'desabilitado'}. Reinicie para aplicar.`, 'info');
  };

  const applyQualityChange = async (newQuality: '1080p' | '720p' | '480p') => {
    setQuality(newQuality);
    if (!streamRef.current) return;
    
    addLog(`Alterando qualidade de transmissão para ${newQuality}...`);
    
    let width = 1920;
    let height = 1080;
    let frameRate = 30;
    
    if (newQuality === '720p') {
      width = 1280;
      height = 720;
      frameRate = 30;
    } else if (newQuality === '480p') {
      width = 854;
      height = 480;
      frameRate = 15;
    }

    // Try dynamic track constraints first (Seamless, no browser select popup!)
    try {
      const activeVideoTrack = streamRef.current.getVideoTracks()[0];
      if (activeVideoTrack) {
        await activeVideoTrack.applyConstraints({
          width: { ideal: width },
          height: { ideal: height },
          frameRate: { ideal: frameRate }
        });

        // Loop all active peers and update their bitrate bounds dynamically
        peersRef.current.forEach((pc) => {
          const senders = pc.getSenders();
          const videoSender = senders.find(s => s.track?.kind === 'video');
          if (videoSender) {
            try {
              const params = videoSender.getParameters();
              if (!params.encodings) params.encodings = [{}];
              if (params.encodings[0]) {
                params.encodings[0].maxBitrate = newQuality === '1080p' ? 4000000 : (newQuality === '720p' ? 2000000 : 800000);
                videoSender.setParameters(params).catch(e => console.warn('Falha ao readequar bitrates do sender:', e));
              }
            } catch (err) {
              console.warn('Erro ao configurar params do sender:', err);
            }
          }
        });

        addLog(`Qualidade reajustada dinamicamente via constraints para ${newQuality} (${width}x${height}@${frameRate}fps)`);
        showToast(`Qualidade ajustada para ${newQuality} sem interrupções!`, 'success');
        return; // Success! Skip display prompt fallback
      }
    } catch (constraintErr: any) {
      addLog(`applyConstraints falhou ou não é suportado: ${constraintErr.message}. Usando alternativa tradicional...`);
    }
    
    // Traditional physical fallback (requires user window choice re-prompt)
    // Stop current video track
    const videoTrack = streamRef.current.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.stop();
    }
    
    try {
      const newScreenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: width },
          height: { ideal: height },
          frameRate: { ideal: frameRate }
        },
        audio: isAudioEnabled
      });
      
      const newVideoTrack = newScreenStream.getVideoTracks()[0];
      
      // Replace tracks in all RTCPeerConnections
      peersRef.current.forEach((pc) => {
        const senders = pc.getSenders();
        const videoSender = senders.find(s => s.track?.kind === 'video');
        if (videoSender && newVideoTrack) {
          videoSender.replaceTrack(newVideoTrack);
        }
      });
      
      // Reconstitute MediaStream with old audio if any
      const audioTrack = streamRef.current.getAudioTracks()[0];
      if (audioTrack && newScreenStream.getAudioTracks().length === 0) {
        newScreenStream.addTrack(audioTrack);
      }
      
      streamRef.current = newScreenStream;
      setStream(newScreenStream);
      
      if (videoElementRef.current) {
        videoElementRef.current.srcObject = newScreenStream;
      }
      
      addLog(`Resolução alterada por reinicialização para ${newQuality} (${width}x${height}@${frameRate}fps)`);
      showToast(`Qualidade de transmissão alterada para ${newQuality}`, 'success');
      
      newVideoTrack.onended = () => {
        addLog('Captura finalizada pelo usuário.');
        stopScreenShare();
      };
    } catch (err: any) {
      addLog(`Reconfiguração de track rejeitada: ${err.message}`);
      showToast('Falha ao reajustar qualidade de compressão de tela.', 'error');
    }
  };

  const copyRoomCode = () => {
    navigator.clipboard.writeText(roomId);
    setCopiedCode(true);
    showToast('Código de sala copiado para área de transferência!', 'success');
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    const newMsg: ChatMessage = {
      id: Math.random().toString(36).substring(2, 9),
      sender: profile?.displayName || user?.displayName || user?.email || 'Streamer',
      text: chatInput,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    socket.emit('chat-msg', newMsg);
    setChatMessages(prev => [...prev, newMsg]);
    setChatInput('');
  };

  const handleDeactivateRoom = async () => {
    addLog('Finalizando transmissão... Fechando dispositivos e conexões...');
    showToast('Encerrando transmissão...', 'info');

    // 1. Encerra getDisplayMedia() e para todas as tracks
    stopScreenShare();

    // 2. Fecha todas as conexões WebRTC PeerConnections ativas
    peersRef.current.forEach((pc, viewerId) => {
      try {
        pc.close();
        addLog(`Conexão WebRTC com espectador ${viewerId} finalizada.`);
      } catch (err) {
        // ignore close error
      }
    });
    peersRef.current.clear();

    // 3. Desconecta o socket de sinalização para limpar trackers
    try {
      socket.disconnect();
    } catch (err) {
      // ignore
    }

    // 4. Faz a chamada HTTP DELETE para desativar a sala no banco
    try {
      const mockToken = `header.${btoa(JSON.stringify({ user_id: user?.uid, email: user?.email, email_verified: true, role: 'streamer' }))}.signature`;
      await fetch(`${API_URL}/api/rooms/${roomId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${mockToken}`
        }
      });
      showToast('Sessão encerrada com sucesso.', 'success');
    } catch (err: any) {
      console.warn('Erro ao desativar sala via API:', err.message);
    }

    // 5. Retorna para o painel principal
    onExit();
  };

  return (
    <div className="flex-1 w-full max-w-7xl mx-auto px-4 py-6 flex flex-col xl:flex-row gap-6 h-full xl:h-[calc(100vh-80px)] overflow-y-auto xl:overflow-hidden">
      
      {/* LEFT SECTION: Stream Video Feed Board and diagnostics Console */}
      <div className="flex-initial xl:flex-1 flex flex-col gap-5 min-w-0 h-auto xl:h-full shrink-0 xl:shrink overflow-y-visible xl:overflow-y-auto pr-1">
        
        {/* Stream Banner Header */}
        <div className="bg-[#0E0E10] border border-[#2A2A2E] rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-950/40 border border-red-500/20 flex items-center justify-center text-red-400">
              <Tv className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-sans font-bold text-red-500 bg-red-950 px-2 py-0.5 rounded border border-red-900/40 tracking-wider">TRANSMISSOR</span>
                <span className="text-[10px] text-neutral-500 font-mono">CÓDIGO: {roomId}</span>
                <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                  socketStatus === 'connected' ? 'bg-emerald-950/40 border-emerald-900/40 text-emerald-400' : 'bg-red-950/40 border-red-900/40 text-red-400'
                }`}>
                  ESTADO: CONECTADO
                </span>
              </div>
              <h1 className="text-sm font-bold text-neutral-200 mt-1 uppercase tracking-tight">Painel de Transmissão</h1>
            </div>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <button
              onClick={copyRoomCode}
              className="flex-1 sm:flex-initial flex items-center justify-center gap-1 bg-[#141417] hover:bg-[#1c1c22] border border-[#2A2A2E] text-[11px] font-mono font-bold text-neutral-300 py-2 px-3 rounded-lg cursor-pointer max-w-xs transition-colors"
            >
              {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedCode ? 'Copiado!' : 'Copiar Convite'}</span>
            </button>

            <button
              onClick={handleDeactivateRoom}
              className="flex-1 sm:flex-initial flex items-center justify-center gap-1 bg-red-950/60 hover:bg-red-900 text-red-400 hover:text-white border border-red-900/30 text-[11px] font-mono font-bold py-2 px-3 rounded-lg cursor-pointer transition-colors"
            >
              <Square className="w-3 h-3" />
              <span>Finalizar transmissão</span>
            </button>
          </div>
        </div>

        {/* Video Stage Render */}
        <div className="bg-[#0E0E10] border border-[#2A2A2E] rounded-2xl relative aspect-video overflow-hidden group flex items-center justify-center shadow-lg bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-neutral-900 via-[#0E0E10] to-[#0A0A0C]">
          
          <video
            ref={videoElementRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-contain ${stream ? 'block' : 'hidden'}`}
          />

          {!stream && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 text-[#6B6B76]">
              {streamError ? (
                <div className="flex flex-col items-center max-w-md bg-[#13090B]/90 border border-red-900/40 p-6 rounded-2xl animate-fade-in">
                  <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 mb-3">
                    <AlertTriangle className="w-5 h-5" />
                  </div>
                  <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-red-400 mb-1">Restrição de Permissão Detectada</h3>
                  <p className="text-[11px] text-zinc-400 leading-relaxed mb-4">
                    O navegador bloqueou o recurso de compartilhamento de tela. Isso geralmente ocorre devido a restrições de segurança do iframe sandbox (painel de desenvolvimento interno).
                  </p>
                  <p className="text-[11px] text-[#10b981] font-medium leading-relaxed mb-4">
                    👉 <strong>Para resolver, clique no botão abaixo para abrir o aplicativo em uma nova aba completa</strong>, ou use o botão no topo direito do visualizador!
                  </p>
                  <div className="bg-[#0A0A0C] border border-[#2A2A2E] rounded-xl p-3 text-left w-full mb-4">
                    <p className="text-[9px] font-mono text-zinc-500 break-words leading-relaxed">
                      Erro retornado: {streamError}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 justify-center w-full">
                    <button
                      onClick={() => {
                        window.open(window.location.href, '_blank');
                      }}
                      className="bg-[#005ae6] hover:bg-[#004bb3] text-[10px] font-mono font-bold text-white px-4 py-2.5 rounded-lg transition-colors cursor-pointer"
                    >
                      Abrir em Nova Aba ↗
                    </button>
                    <button
                      onClick={startScreenShare}
                      className="bg-[#1C1C22] hover:bg-[#2A2A35] text-[10px] font-mono font-bold text-neutral-300 px-4 py-2.5 rounded-lg border border-[#2A2A2E] transition-colors cursor-pointer"
                    >
                      Tentar Novamente
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <Video className="w-12 h-12 mb-3 text-neutral-600 animate-pulse" />
                  <h3 className="text-sm font-bold uppercase tracking-wider text-neutral-200">Pronto para Broadcast</h3>
                  <p className="text-xs text-neutral-500 max-w-sm mt-1.5 leading-relaxed">Clique no botão abaixo para selecionar qual tela compartilhar. O navegador exibirá a janela nativa imediatamente.</p>
                  
                  <button
                    id="btn-estrear-tela"
                    onClick={startScreenShare}
                    className="mt-6 bg-[#10b981] hover:bg-[#059669] text-xs font-mono font-bold text-white py-2.5 px-6 rounded-xl cursor-pointer transition-all flex items-center gap-2 shadow-md shadow-emerald-500/20 hover:scale-[1.02] active:scale-[0.98]"
                  >
                    <Play className="w-3.5 h-3.5 text-white fill-white" /> Estrear Tela
                  </button>
                </>
              )}
            </div>
          )}

          {/* Quick inline audio controls inside stage */}
          {stream && (
            <div className="absolute bottom-4 left-4 right-4 flex flex-wrap justify-between items-center gap-2 bg-black/80 backdrop-blur-md px-3.5 py-2 rounded-xl border border-[#2A2A2E] text-[10px] font-mono">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                <span className="text-[#8E8E99]">Transmissão Ativa</span>
                <span className="text-emerald-400">({quality})</span>
              </div>
              
              <div className="flex items-center gap-3">
                {/* Integration of the Diagnostic Monitor Switch */}
                <button
                  type="button"
                  onClick={() => setShowDiagHUD(!showDiagHUD)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded text-[8px] font-bold border transition-all cursor-pointer ${
                    showDiagHUD
                      ? 'bg-blue-950/85 border-blue-500/40 text-blue-400 shadow-sm'
                      : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-neutral-200'
                  }`}
                  title="Painel de Diagnósticos WebRTC em Tempo Real"
                >
                  <Wifi className={`w-3 h-3 ${showDiagHUD ? 'text-blue-400' : 'text-neutral-500'}`} />
                  <span>WEBRTC DIAGS</span>
                </button>

                {/* Resolution selectors */}
                <div className="flex items-center gap-1 border-r border-[#2A2A2E] pr-3 mr-1">
                  <Sliders className="w-3 h-3 text-[#3b82f6] mr-1" />
                  {(['1080p', '720p', '480p'] as const).map((q) => (
                    <button
                      key={q}
                      onClick={() => applyQualityChange(q)}
                      className={`px-1.5 py-0.5 rounded text-[8px] font-bold ${
                        quality === q
                          ? 'bg-[#005ae6] text-white'
                          : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-900'
                      } transition-all cursor-pointer`}
                    >
                      {q}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-neutral-500">Áudio:</span>
                  <button 
                    onClick={handleToggleAudio}
                    className="text-[#8E8E99] hover:text-white flex items-center transition-colors cursor-pointer"
                    title={`${isAudioEnabled ? 'Desabilitar' : 'Habilitar'} Captura de Áudio`}
                  >
                    {isAudioEnabled ? <Volume2 className="w-3.5 h-3.5 text-emerald-400" /> : <VolumeX className="w-3.5 h-3.5 text-[#6B6B76]" />}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Real-time WebRTC Diagnostic Monitoring Overlay HUD */}
          <AnimatePresence>
            {showDiagHUD && (
              <motion.div
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 40 }}
                className="absolute top-4 right-4 bottom-16 w-80 bg-black/90 backdrop-blur-lg border border-[#2A2A2E]/90 rounded-xl p-4 flex flex-col gap-3 text-left text-[11px] font-mono z-20 text-[#C1C1CB] shadow-2xl overflow-y-auto"
              >
                <div className="flex items-center justify-between border-b border-[#2A2A2E]/70 pb-2">
                  <div className="flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 text-emerald-450 animate-pulse" />
                    <span className="font-bold text-neutral-200">TELEMETRIA WEBRTC</span>
                  </div>
                  <button
                    onClick={() => setShowDiagHUD(false)}
                    className="p-1 hover:bg-neutral-900 rounded text-neutral-500 hover:text-white transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Overall Stream Health Rating */}
                {peerStats.length > 0 ? (
                  peerStats.map((peer, idx) => {
                    // Quick health classification
                    let healthRating = 'EXCELENTE';
                    let healthColor = 'text-emerald-400 bg-emerald-950/40 border-emerald-900/40';
                    if (peer.packetLoss > 5 || peer.rtt > 250) {
                      healthRating = 'DEGRADADO';
                      healthColor = 'text-red-400 bg-red-950/40 border-red-900/40';
                    } else if (peer.packetLoss > 1 || peer.rtt > 100) {
                      healthRating = 'REGULAR';
                      healthColor = 'text-amber-400 bg-amber-950/40 border-amber-900/40';
                    }

                    // Bottleneck classification helper
                    let limitReason = 'Nenhum (Hardware / Rede OK)';
                    if (peer.qualityLimitation === 'cpu') {
                      limitReason = 'Gargalo de CPU (Consumo alto)';
                    } else if (peer.qualityLimitation === 'bandwidth') {
                      limitReason = 'Banda Insuficiente (Congestionado)';
                    } else if (peer.qualityLimitation === 'other') {
                      limitReason = 'Gargalo Interno Limitado';
                    }

                    return (
                      <div key={peer.viewerId} className="flex flex-col gap-2">
                        <div className="flex items-center justify-between bg-neutral-900/60 p-2 rounded-lg border border-neutral-800/60">
                          <span className="text-zinc-500 font-bold">CLIENTE #{idx + 1}:</span>
                          <span className="text-zinc-300 truncate max-w-[120px] font-sans font-bold" title={peer.userId}>
                            {peer.userId}
                          </span>
                        </div>

                        {/* Signaling / Connection Status Tags */}
                        <div className="grid grid-cols-2 gap-1.5 text-[9px]">
                          <div className="bg-[#121215] border border-neutral-850 p-1.5 rounded-md">
                            <div className="text-zinc-500">PEER CONN:</div>
                            <div className={`font-bold uppercase mt-0.5 ${
                              peer.connectionState === 'connected' ? 'text-emerald-450' : 'text-amber-500'
                            }`}>{peer.connectionState}</div>
                          </div>
                          <div className="bg-[#121215] border border-neutral-850 p-1.5 rounded-md">
                            <div className="text-zinc-500">ICE STATE:</div>
                            <div className={`font-bold uppercase mt-0.5 ${
                              peer.iceConnectionState === 'connected' ? 'text-emerald-450' : 'text-amber-500'
                            }`}>{peer.iceConnectionState}</div>
                          </div>
                        </div>

                        {/* Overall Health Tag */}
                        <div className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg border text-[10px] font-bold ${healthColor}`}>
                          <span>SINAL DE REDE:</span>
                          <span>{healthRating}</span>
                        </div>

                        {/* Essential numeric Metrics Display */}
                        <div className="bg-[#141416]/50 border border-[#2A2A2E]/55 rounded-xl p-2.5 flex flex-col gap-2">
                          
                          {/* Bitrate Outgoing */}
                          <div className="flex justify-between items-center border-b border-[#2A2A2E]/10 pb-1.5">
                            <span className="text-zinc-400 text-[10px] flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-blue-500" /> Bitrate Enviado:
                            </span>
                            <span className="text-neutral-100 font-mono font-bold text-xs">{peer.bitrate} kbps</span>
                          </div>

                          {/* Packet Loss */}
                          <div className="flex justify-between items-center border-b border-[#2A2A2E]/10 pb-1.5">
                            <span className="text-zinc-400 text-[10px] flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-red-400" /> Perda de Pacotes:
                            </span>
                            <span className={`font-bold font-mono text-xs ${peer.packetLoss > 1 ? 'text-red-400' : 'text-emerald-400'}`}>
                              {peer.packetLoss}%
                            </span>
                          </div>

                          {/* Round-trip Time */}
                          <div className="flex justify-between items-center border-b border-[#2A2A2E]/10 pb-1.5">
                            <span className="text-zinc-400 text-[10px] flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" /> Latência (RTT):
                            </span>
                            <span className={`font-bold font-mono text-xs ${peer.rtt > 150 ? 'text-red-400' : 'text-neutral-100'}`}>
                              {peer.rtt} ms
                            </span>
                          </div>

                          {/* Jitter */}
                          <div className="flex justify-between items-center border-b border-[#2A2A2E]/10 pb-1.5">
                            <span className="text-zinc-400 text-[10px] flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Jitter:
                            </span>
                            <span className="text-neutral-150 font-mono font-bold">{peer.jitter} ms</span>
                          </div>

                          {/* Render Specification: Width x Height & Frame rate */}
                          <div className="flex justify-between items-center border-b border-[#2A2A2E]/10 pb-1.5">
                            <span className="text-zinc-400 text-[10px] flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" /> Resolução / FPS:
                            </span>
                            <span className="text-neutral-100 font-mono text-[10px]">{peer.resolution} @ {peer.fps}fps</span>
                          </div>

                          {/* Bottleneck / Limit Reason */}
                          <div className="flex flex-col gap-0.5 mt-1">
                            <span className="text-zinc-500 text-[9px] uppercase tracking-wider">Fator Limitador:</span>
                            <span className={`text-[10px] font-bold mt-0.5 ${
                              peer.qualityLimitation === 'none' ? 'text-neutral-300' : 'text-amber-400 font-sans'
                            }`}>
                              {limitReason}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="my-auto text-center flex flex-col items-center justify-center p-4 py-8 border border-[#2D2D34]/30 rounded-xl bg-neutral-950/40">
                    <Wifi className="w-8 h-8 text-neutral-600 mb-2 animate-bounce" />
                    <span className="text-neutral-300 text-[11px] font-sans font-medium uppercase tracking-wider">Aguardando Conexão</span>
                    <p className="text-[10px] text-neutral-500 mt-2 font-sans leading-relaxed">
                      Sua stream está ativa localmente. A contagem de telemetria ponto a ponto WebRTC iniciará assim que o espectador se conectar a seu feed de vídeo.
                    </p>
                  </div>
                )}

                {/* Handy Troubleshoot Guide tips drawer always integrated at bottom */}
                <div className="mt-auto bg-blue-950/25 border border-blue-900/35 rounded-lg p-2.5 text-[9px] leading-relaxed text-blue-300 font-sans">
                  <div className="flex items-center gap-1.5 font-bold uppercase tracking-wide text-blue-200 mb-1">
                    <AlertTriangle className="w-3.5 h-3.5 text-blue-400" />
                    <span>Dicas de Solução:</span>
                  </div>
                  <ul className="list-disc pl-3.5 space-y-1">
                    <li>Se houver perda de pacotes ou engate, utilize a resolução 720p ou 480p nas opções.</li>
                    <li>Congestionamentos sérios costumam ser gerados por NAT ou limites da conexão do próprio espectador.</li>
                    <li>Caso o limitador seja <strong>CPU</strong>, feche outras tarefas pesadas no navegador.</li>
                  </ul>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Live diagnostics logs system terminal removed for non-technical UI presentation */}

      </div>

      {/* RIGHT SECTION: Real-time Live Chat and user engagement logs */}
      <div className="w-full xl:w-80 bg-[#0E0E10] border border-[#2A2A2E] rounded-2xl h-[320px] sm:h-[400px] xl:h-full flex flex-col justify-between shrink-0">
        
        {/* Chat metadata */}
        <div className="p-4 border-b border-[#2A2A2E] flex justify-between items-center shrink-0 bg-[#141417]/30 rounded-t-2xl">
          <span className="text-xs font-bold uppercase tracking-wider text-[#6B6B76] font-mono flex items-center gap-1.5">
            <MessageSquare className="w-4 h-4 text-[#3b82f6]" />
            <span>Chat em Tempo Real</span>
          </span>

          <div className="flex items-center gap-1 text-[10px] font-mono bg-emerald-950/40 text-emerald-400 border border-emerald-900/30 px-2 py-0.5 rounded">
            <Users className="w-3 h-3" />
            <span>{viewerCount} Assistindo</span>
          </div>
        </div>

        {/* Messaging Box Panel */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 min-h-0">
          {chatMessages.length === 0 ? (
            <div className="my-auto text-center p-4">
              <MessageSquare className="w-8 h-8 text-neutral-800 mx-auto mb-2" />
              <h4 className="text-[11px] font-mono uppercase text-[#8E8E99]">Canal Vazio</h4>
              <p className="text-[10px] text-neutral-500 mt-0.5 leading-snug">Envie um olá aos seus espectadores síncronos.</p>
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

        {/* Messaging input footer form */}
        <form onSubmit={handleSendChat} className="p-3 border-t border-[#2A2A2E] bg-[#0A0A0C]/40 rounded-b-2xl">
          <div className="flex gap-1.5 bg-[#0A0A0C] border border-[#2A2A2E] rounded-xl p-1 shrink-0">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onFocus={(e) => {
                setTimeout(() => {
                  e.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }, 300);
              }}
              placeholder="Digite sua mensagem de chat..."
              className="flex-1 bg-transparent px-3 py-1.5 text-xs text-neutral-200 placeholder-neutral-700 outline-none"
            />
            <button
              type="submit"
              className="p-2 bg-[#005ae6] hover:bg-[#004bb3] text-white rounded-lg transition-colors cursor-pointer shrink-0"
              title="Transmitir Conversa"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>
        </form>

      </div>

    </div>
  );
};
