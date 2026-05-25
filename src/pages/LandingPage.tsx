import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useAuth } from '../context/AuthContext';
import { 
  Tv, Sparkles, Zap, ArrowRight, Lock, Play, Mail, User, X, 
  Film, Flame, Shield, Compass, ChevronRight, Coins, Copy, Check, Loader2, AlertTriangle
} from 'lucide-react';
import { GuestViewer } from '../components/GuestViewer';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase/config';
import { API_URL } from '../config/api';

interface LandingPageProps {
  onEnterApp: () => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({ onEnterApp }) => {
  const { user, signInWithGoogle, signInWithEmail, signUpWithEmail } = useAuth();
  
  // Modal controllers
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  
  // Real active rooms list
  const [realRooms, setRealRooms] = useState<any[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(true);
  
  // Fields state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [pixKey, setPixKey] = useState('');
  
  // UI status
  const [errorMsg, setErrorMsg] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  // Realtime Active Rooms Listener with robust REST API polling fallback
  useEffect(() => {
    let intervalId: any;
    
    const parseTimestampToMs = (createdAt: any): number => {
      if (!createdAt) return 0;
      if (typeof createdAt === 'number') return createdAt;
      if (typeof createdAt === 'string') return new Date(createdAt).getTime() || 0;
      if (typeof createdAt === 'object') {
        if (typeof createdAt.seconds === 'number') return createdAt.seconds * 1000;
        if (typeof createdAt._seconds === 'number') return createdAt._seconds * 1000;
      }
      return 0;
    };

    const fetchRooms = async () => {
      try {
        const response = await fetch(`${API_URL}/api/landing/rooms`);
        if (response.ok) {
          const data = await response.json();
          // Sort by creation time desc
          const sorted = data.map((room: any) => ({
            id: room.id,
            name: room.name || 'Sala sem nome',
            streamerId: room.streamerId || '',
            pricePerHour: room.pricePerHour || 0,
            status: room.status || 'active',
            createdAt: room.createdAt
          })).sort((a: any, b: any) => {
            const timeA = parseTimestampToMs(a.createdAt);
            const timeB = parseTimestampToMs(b.createdAt);
            return timeB - timeA;
          });
          setRealRooms(sorted);
        }
      } catch (err) {
        console.warn('Public API rooms fetch error:', err);
      } finally {
        setLoadingRooms(false);
      }
    };

    // First fetch immediately
    fetchRooms();

    // Set up standard polling of 3 seconds to keep it real-time
    intervalId = setInterval(fetchRooms, 3000);

    // Try to register live onSnapshot if available
    let unsubscribe: (() => void) | undefined;
    if (db) {
      const q = query(
        collection(db, 'rooms'),
        where('status', '==', 'active')
      );
      try {
        unsubscribe = onSnapshot(q, (snapshot) => {
          const activeRooms: any[] = [];
          snapshot.forEach((doc) => {
            const data = doc.data();
            activeRooms.push({
              id: doc.id,
              name: data.name || 'Sala sem nome',
              streamerId: data.streamerId || '',
              pricePerHour: data.pricePerHour || 0,
              status: data.status || 'active',
              createdAt: data.createdAt
            });
          });
          
          setRealRooms(prev => {
            const map = new Map();
            prev.forEach(r => map.set(r.id, r));
            activeRooms.forEach(r => map.set(r.id, r));
            return Array.from(map.values())
              .filter(r => r.status === 'active')
              .sort((a: any, b: any) => {
                const timeA = parseTimestampToMs(a.createdAt);
                const timeB = parseTimestampToMs(b.createdAt);
                return timeB - timeA;
              });
          });
          setLoadingRooms(false);
        }, (error) => {
          console.warn('Realtime rooms restricted or offline. Staying on REST API polling.', error);
        });
      } catch (e) {
        console.warn('Failed to set up onSnapshot:', e);
      }
    }

    return () => {
      if (unsubscribe) unsubscribe();
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  const handleOpenAuth = (mode: 'login' | 'register') => {
    setAuthMode(mode);
    setErrorMsg('');
    setShowAuthModal(true);
  };

  const handleOAuthGoogle = async () => {
    setActionLoading(true);
    setErrorMsg('');
    try {
      await signInWithGoogle();
      onEnterApp();
    } catch (err: any) {
      setErrorMsg(err.message || 'Falha ao autenticar com Conta Google.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setErrorMsg('Por favor, preencha todos os campos obrigatórios.');
      return;
    }
    if (authMode === 'register' && !name) {
      setErrorMsg('Por favor, preencha seu nome de exibição.');
      return;
    }

    setActionLoading(true);
    setErrorMsg('');
    try {
      if (authMode === 'login') {
        await signInWithEmail(email, password);
      } else {
        await signUpWithEmail(email, password, name, pixKey);
      }
      setShowAuthModal(false);
      onEnterApp();
    } catch (err: any) {
      console.error(err);
      if (err.code === 'auth/email-already-in-use') {
        setErrorMsg('Este endereço de e-mail já está em uso.');
      } else if (err.code === 'auth/weak-password') {
        setErrorMsg('A senha deve conter no mínimo 6 caracteres.');
      } else if (err.code === 'auth/invalid-credential') {
        setErrorMsg('E-mail ou senha incorretos.');
      } else if (err.code === 'auth/operation-not-allowed' || (err.message && err.message.includes('operation-not-allowed'))) {
        setErrorMsg('O provedor de E-mail/Senha não está ativo no Firebase Authentication! Acesse o console do Firebase, vá em Authentication > Sign-in method e habilite o provedor de E-mail/Senha, ou conecte-se usando sua Conta Google.');
      } else {
        setErrorMsg(err.message || 'Erro inesperado na autenticação.');
      }
    } finally {
      setActionLoading(false);
    }
  };

  // Quick helper to enter app directly if logged in, or ask to login
  const handleWatchClick = () => {
    if (user) {
      onEnterApp();
    } else {
      handleOpenAuth('login');
    }
  };

  return (
    <div className="relative min-h-screen bg-[#0A0A0C] text-[#E0E0E6] overflow-hidden flex flex-col font-sans">
      
      {/* Background Decorative Mesh Gradients */}
      <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-[#005ae6]/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-10 right-10 w-[400px] h-[400px] bg-[#E52222]/10 rounded-full blur-[100px] pointer-events-none" />

      {/* Navigation Headers */}
      <nav className="relative z-10 max-w-7xl w-full mx-auto px-6 h-18 flex items-center justify-between border-b border-[#2A2A2E]/30 bg-[#0A0A0C]/50 backdrop-blur-md sticky top-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-[#005ae6] to-[#E52222] flex items-center justify-center shadow-lg shadow-[#005ae6]/20">
            <Tv className="w-4.5 h-4.5 text-white animate-pulse" />
          </div>
          <span className="font-bold tracking-tight text-white uppercase text-sm">
            Bahia Stream
          </span>
        </div>

        <div className="flex items-center gap-4">
          {user ? (
            <button
              onClick={onEnterApp}
              className="flex items-center gap-1.5 bg-[#005ae6] hover:bg-[#004bb3] border border-blue-500/20 text-xs font-mono font-bold text-white py-2 px-4 rounded-lg cursor-pointer transition-all"
            >
              Workspace <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <div className="flex items-center gap-2.5">
              <button
                onClick={() => handleOpenAuth('login')}
                className="text-xs font-mono font-bold text-neutral-400 hover:text-white py-2 px-3 transition-colors cursor-pointer"
              >
                Login
              </button>
              <button
                onClick={() => handleOpenAuth('register')}
                className="bg-[#005ae6] hover:bg-[#004bb3] text-xs font-mono font-bold text-white py-2 px-4 rounded-lg shadow-md hover:shadow-[#005ae6]/20 transition-all cursor-pointer"
              >
                Cadastrar Grátis
              </button>
            </div>
          )}
        </div>
      </nav>

      {/* Hero Section */}
      <main className="relative z-10 flex-1 flex flex-col items-center px-6 text-center max-w-6xl mx-auto py-12 md:py-16">
        
        {/* Simplified Header Pill */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="inline-flex items-center gap-2 px-3 py-1 bg-[#141417] border border-[#2A2A2E] rounded-full text-xs text-neutral-300 font-mono mb-6"
        >
          <Sparkles className="w-3.5 h-3.5 text-[#E52222] animate-pulse" />
          <span>A maneira mais rápida de assistir e transmitir</span>
        </motion.div>

        {/* Simplified Title */}
        <motion.h1
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="text-4xl md:text-5xl lg:text-6xl font-black tracking-tight text-white max-w-4xl leading-[1.1] font-sans"
        >
          Transmita e assista ao vivo sem complicação
        </motion.h1>

        {/* Simplified Description */}
        <motion.p
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="text-sm md:text-base text-neutral-400 mt-5 max-w-3xl leading-relaxed font-sans"
        >
          Crie transmissões privadas ou públicas em segundos. Compartilhe sua tela, converse em tempo real e monetize com Pix.
        </motion.p>

        {/* Core Direct Action Buttons */}
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="flex flex-col sm:flex-row gap-4 mt-8 justify-center w-full max-w-md"
        >
          <button
            onClick={() => {
              if (user) {
                onEnterApp();
              } else {
                handleOpenAuth('login');
              }
            }}
            className="flex items-center justify-center gap-2 bg-[#005ae6] hover:bg-[#004bb3] text-sm font-mono font-bold text-white py-3 px-8 rounded-xl shadow-xl shadow-[#005ae6]/20 hover:shadow-[#005ae6]/30 transition-all cursor-pointer group"
          >
            <span>Começar Agora</span>
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </button>

          <button
            onClick={() => {
              const el = document.getElementById('lives-gallery');
              if (el) el.scrollIntoView({ behavior: 'smooth' });
            }}
            className="flex items-center justify-center gap-2 bg-[#141417] hover:bg-[#1C1C22] border border-[#2A2A2E] text-sm font-mono font-bold text-neutral-300 py-3 px-6 rounded-xl transition-all cursor-pointer"
          >
            <span>Explorar Lives</span>
          </button>
        </motion.div>

        {/* NEW SECTION: "Assistir Transmissões" Realtime Gallery */}
        <motion.section 
          initial={{ opacity: 0, y: 25 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="w-full mt-16 text-left border border-[#2A2A2E]/50 bg-[#0E0E10]/70 rounded-2xl p-6 relative overflow-hidden"
        >
          <div className="absolute top-0 left-0 w-full h-[3px] bg-gradient-to-r from-[#005ae6] via-white to-[#E52222]" />
          
          {/* Header segment with tag */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 border-b border-[#2A2A2E]/40 pb-4">
            <div>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-[#005ae6]/10 text-[#3b82f6] text-[10px] font-mono tracking-wider font-bold mb-1 uppercase">
                <Compass className="w-3.5 h-3.5" />
                EXPLORAR CANAIS ATIVOS
              </span>
              <h2 className="text-xl md:text-2xl font-black text-white font-sans flex items-center gap-2">
                <span>Transmissões ao vivo</span>
                <span className="text-xs font-normal text-neutral-400 font-mono hidden sm:inline">// Aproveite transmissões para assistir na hora</span>
              </h2>
            </div>
          </div>

          {/* Real Grid display */}
          {loadingRooms ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-[#005ae6] animate-spin" />
              <span className="text-xs font-mono text-neutral-400 mt-2">Buscando transmissões ao vivo...</span>
            </div>
          ) : realRooms.length === 0 ? (
            <div className="border border-dashed border-[#2A2A2E]/60 rounded-xl flex flex-col items-center justify-center text-center p-12 bg-black/40">
              <div className="w-9 h-9 rounded-full bg-red-950/20 border border-red-500/20 flex items-center justify-center mb-4 text-[#E52222]">
                <Zap className="w-4 h-4 animate-pulse" />
              </div>
              <span className="text-xs font-mono text-neutral-300 font-bold uppercase tracking-wider">Nenhuma transmissão ao vivo no momento</span>
              <p className="text-[11px] text-neutral-500 mt-1 max-w-md leading-relaxed">
                Nenhuma transmissão ao vivo iniciada no momento. Faça login para assistir ou criar sua própria transmissão agora de forma simples!
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              <AnimatePresence mode="popLayout">
                {realRooms.map((room) => (
                  <motion.div
                    layout
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.3 }}
                    key={room.id}
                    className="bg-[#141417] border border-[#2A2A2E] rounded-xl overflow-hidden shadow-lg group hover:border-[#005ae6]/50 transition-all flex flex-col p-5 justify-between"
                  >
                    <div>
                      <div className="flex justify-between items-start">
                        <span className="text-[9px] font-mono text-[#E52222] px-2 py-0.5 bg-[#E52222]/10 border border-[#E52222]/20 rounded uppercase font-bold tracking-wider animate-pulse flex items-center gap-1">
                          <span className="w-1 h-1 rounded-full bg-[#E52222] inline-block"></span>
                          AO VIVO
                        </span>
                        <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded ${
                          room.pricePerHour > 0 
                            ? 'bg-amber-950/80 text-amber-500 border border-amber-700/40' 
                            : 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/40'
                        }`}>
                          {room.pricePerHour > 0 ? `R$ ${room.pricePerHour.toFixed(2)}` : 'ACESSO LIVRE'}
                        </span>
                      </div>

                      <h3 className="text-sm font-bold text-neutral-200 mt-4 line-clamp-2 h-10 group-hover:text-white transition-colors animate-fade-in">
                        {room.name}
                      </h3>
                    </div>

                    <button 
                      onClick={handleWatchClick}
                      className="mt-6 w-full flex items-center justify-center gap-1.5 py-2.5 bg-[#2A2A2E]/50 group-hover:bg-[#005ae6] hover:bg-[#004bb3] border border-[#2A2A2E] group-hover:border-[#005ae6] text-xs font-mono font-bold text-neutral-300 group-hover:text-white rounded-lg transition-all cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>ASSISTIR TRANSMISSÃO</span>
                    </button>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </motion.section>

        {/* Simplified Feature Matrix / Bento Grid representation - No Tech Slop */}
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.5 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12 w-full text-left"
        >
          
          <div className="bg-[#0E0E10] border border-[#2A2A2E]/50 rounded-xl p-5 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-[2px] bg-[#005ae6]" />
            <div className="p-2.5 bg-blue-500/10 rounded-lg w-fit text-[#3b82f6] border border-[#005ae6]/20 mb-3">
              <Flame className="w-5 h-5" />
            </div>
            <h3 className="text-sm font-bold tracking-tight text-neutral-100 font-sans">Transmissão rápida e estável</h3>
            <p className="text-xs text-neutral-400 mt-2 leading-relaxed font-sans">
              Assista e transmita com ótima qualidade e baixa latência diretamente do navegador.
            </p>
          </div>

          <div className="bg-[#0E0E10] border border-[#2A2A2E]/50 rounded-xl p-5 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-[2px] bg-neutral-400" />
            <div className="p-2.5 bg-neutral-300/10 rounded-lg w-fit text-neutral-300 border border-neutral-700/50 mb-3">
              <Zap className="w-5 h-5" />
            </div>
            <h3 className="text-sm font-bold tracking-tight text-neutral-100 font-sans">Pagamento fácil com Pix</h3>
            <p className="text-xs text-neutral-400 mt-2 leading-relaxed font-sans">
              Cobre acesso às suas transmissões com aprovação rápida e segura.
            </p>
          </div>

          <div className="bg-[#0E0E10] border border-[#2A2A2E]/50 rounded-xl p-5 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-[2px] bg-[#E52222]" />
            <div className="p-2.5 bg-[#E52222]/10 rounded-lg w-fit text-[#E52222] border border-[#E52222]/20 mb-3">
              <Shield className="w-5 h-5" />
            </div>
            <h3 className="text-sm font-bold tracking-tight text-neutral-100 font-sans">Privacidade total</h3>
            <p className="text-xs text-neutral-400 mt-2 leading-relaxed font-sans">
              Você controla quem entra nas suas transmissões.
            </p>
          </div>

        </motion.div>
      </main>

      {/* Footer statistics branding */}
      <footer className="relative z-10 h-16 border-t border-[#2A2A2E]/30 bg-[#0E0E10] px-6 flex items-center justify-between text-xs text-[#6B6B76] font-mono mt-auto">
        <span>© 2026 BAHIA STREAM DIGITAL CO.</span>
        <div className="flex gap-4">
          <span>SISTEMA DE TRANSMISSÃO DIGITAL</span>
          <span className="hidden md:inline">|</span>
          <span className="hidden md:inline text-emerald-400 font-bold uppercase tracking-wider">CONEXÃO SEGURA E ATIVA</span>
        </div>
      </footer>

      {/* Authentication Modal */}
      <AnimatePresence>
        {showAuthModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop screen */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-md"
              onClick={() => setShowAuthModal(false)}
            />

            {/* Modal Body */}
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              className="relative bg-[#0E0E10] border border-[#2A2A2E] w-full max-w-sm rounded-2xl overflow-hidden p-6 shadow-2xl z-10"
            >
              {/* Top Bahia Ribbon Banner decoration */}
              <div className="absolute top-0 left-0 w-full h-[6px] flex">
                <div className="w-1/3 h-full bg-[#005ae6]" />
                <div className="w-1/3 h-full bg-white" />
                <div className="w-1/3 h-full bg-[#E52222]" />
              </div>

              {/* Close Button */}
              <button
                onClick={() => setShowAuthModal(false)}
                className="absolute top-4 right-4 text-neutral-500 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="text-center mt-3 mb-5">
                <div className="w-10 h-10 rounded-full bg-[#141417] border border-[#2A2A2E] flex items-center justify-center mx-auto mb-2">
                  <Tv className="w-5 h-5 text-[#3b82f6]" />
                </div>
                <h2 className="text-base font-black tracking-tight text-white uppercase font-mono">
                  {authMode === 'login' ? 'ENTRAR NO' : 'CADASTRAR NO'} <span className="text-[#3b82f6]">BAHIA</span> <span className="text-[#E52222]">STREAM</span>
                </h2>
                <p className="text-xs text-neutral-400 mt-1">
                  Selecione sua forma de login rápida.
                </p>
              </div>

              {/* Form segment */}
              <form onSubmit={handleAuthSubmit} className="space-y-4">
                
                {authMode === 'register' && (
                  <>
                    <div>
                      <label className="block text-[10px] font-mono font-bold text-[#8E8E99] uppercase tracking-wider mb-1.5">Seu Nome Completo</label>
                      <div className="relative">
                        <User className="absolute left-3.5 top-3 w-4 h-4 text-neutral-600" />
                        <input
                          type="text"
                          required
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="Ex: Natan Marinho"
                          className="w-full bg-[#0A0A0C] border border-[#2A2A2E] text-xs rounded-xl pl-10 pr-4 py-2.5 text-neutral-100 placeholder-neutral-700 outline-none focus:border-[#005ae6] transition-all"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[10px] font-mono font-bold text-[#8E8E99] uppercase tracking-wider mb-1.5">Chave PIX (Para resgatar faturamentos)</label>
                      <div className="relative">
                        <Coins className="absolute left-3.5 top-3 w-4 h-4 text-neutral-600" />
                        <input
                          type="text"
                          required={authMode === 'register'}
                          value={pixKey}
                          onChange={(e) => setPixKey(e.target.value)}
                          placeholder="Ex: Celular, CPF, E-mail ou Aleatória"
                          className="w-full bg-[#0A0A0C] border border-[#2A2A2E] text-xs rounded-xl pl-10 pr-4 py-2.5 text-neutral-100 placeholder-neutral-700 outline-none focus:border-[#005ae6] transition-all"
                        />
                      </div>
                    </div>
                  </>
                )}

                <div>
                  <label className="block text-[10px] font-mono font-bold text-[#8E8E99] uppercase tracking-wider mb-1.5">Endereço de E-mail</label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-3 w-4 h-4 text-neutral-600" />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="seuemail@exemplo.com"
                      className="w-full bg-[#0A0A0C] border border-[#2A2A2E] text-xs rounded-xl pl-10 pr-4 py-2.5 text-neutral-100 placeholder-neutral-700 outline-none focus:border-[#005ae6] transition-all"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-mono font-bold text-[#8E8E99] uppercase tracking-wider mb-1.5">Sua Senha</label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-3 w-4 h-4 text-neutral-600" />
                    <input
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="No mínimo 6 caracteres"
                      className="w-full bg-[#0A0A0C] border border-[#2A2A2E] text-xs rounded-xl pl-10 pr-4 py-2.5 text-neutral-100 placeholder-neutral-700 outline-none focus:border-[#005ae6] transition-all"
                    />
                  </div>
                </div>

                {errorMsg && (
                  <div className="text-[11px] text-[#E52222] font-semibold bg-[#E52222]/10 border border-[#E52222]/20 px-3 py-2 rounded-xl text-center">
                    {errorMsg}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={actionLoading}
                  className="w-full bg-gradient-to-r from-[#005ae6] via-[#2563eb] to-[#E52222] hover:opacity-90 text-xs font-mono font-bold text-white py-2.5 rounded-xl transition-all cursor-pointer text-center shrink-0 shadow-lg"
                >
                  {actionLoading ? 'Processando...' : authMode === 'login' ? 'ENTRAR AGORA' : 'CRIAR MINHA CONTA'}
                </button>
              </form>

              {/* Separador visual */}
              <div className="relative flex py-3 items-center">
                <div className="flex-grow border-t border-[#2A2A2E]/50"></div>
                <span className="flex-shrink mx-4 text-[9px] font-mono text-neutral-500 uppercase">Ou use</span>
                <div className="flex-grow border-t border-[#2A2A2E]/50"></div>
              </div>

              {/* Botão Google alternativo */}
              <button
                type="button"
                onClick={handleOAuthGoogle}
                disabled={actionLoading}
                className="w-full flex items-center justify-center gap-2 bg-[#141417] hover:bg-[#1C1C22] border border-[#2A2A2E] text-xs font-mono font-bold text-neutral-200 py-2.5 rounded-xl cursor-pointer"
              >
                {/* SVG Google de alto contraste */}
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/2000">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335" />
                </svg>
                <span>Sua Conta Google</span>
              </button>

              {/* Switch link */}
              <div className="text-center mt-4 text-[11px] text-neutral-500 font-sans">
                {authMode === 'login' ? (
                  <span>
                    Ainda não tem conta?{' '}
                    <button
                      onClick={() => setAuthMode('register')}
                      className="text-[#3b82f6] font-bold hover:underline bg-transparent border-none p-0 cursor-pointer"
                    >
                      Cadastre-se aqui
                    </button>
                  </span>
                ) : (
                  <span>
                    Já tem uma conta cadastrada?{' '}
                    <button
                      onClick={() => setAuthMode('login')}
                      className="text-[#3b82f6] font-bold hover:underline bg-transparent border-none p-0 cursor-pointer"
                    >
                      Faça Login
                    </button>
                  </span>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
};
