import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { API_URL } from '../config/api';
import { 
  Plus, 
  Search, 
  Tv, 
  Radio, 
  Hash, 
  DollarSign, 
  User, 
  ExternalLink,
  Lock,
  Loader2,
  Coins,
  ShieldCheck,
  Compass,
  Users
} from 'lucide-react';
import { doc, updateDoc, increment, collection, addDoc, serverTimestamp, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase/config';

interface Room {
  id: string;
  name: string;
  streamerId: string;
  pricePerHour: number;
  status: string;
  createdAt: any;
}

interface DashboardProps {
  onJoinRoom: (roomId: string, isStreamer?: boolean) => void;
  onNavigateToTransactions: () => void;
  onNavigateToAdmin: () => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ 
  onJoinRoom, 
  onNavigateToTransactions, 
  onNavigateToAdmin 
}) => {
  const { user, profile } = useAuth();
  const { showToast } = useToast();

  const [rooms, setRooms] = useState<Room[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [inviteCode, setInviteCode] = useState('');

  // Create Room form state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [isPremium, setIsPremium] = useState(false);
  const [roomPrice, setRoomPrice] = useState('25.00');
  const [creating, setCreating] = useState(false);

  // 1. REALTIME FIRESTORE ROOM LIST LISTENER (No polling if Firestore works, fallback polling otherwise!)
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

    const fetchActiveRoomsQuietly = async () => {
      try {
        const mockToken = user ? `header.${btoa(JSON.stringify({ user_id: user.uid, email: user.email, email_verified: true }))}.signature` : '';
        const response = await fetch(`${API_URL}/api/rooms`, {
          headers: {
            'Authorization': mockToken ? `Bearer ${mockToken}` : ''
          }
        });
        if (response.ok) {
          const data = await response.json();
          const mapped = data.map((room: any) => ({
            id: room.id,
            name: room.name || 'Sala sem nome',
            streamerId: room.streamerId || '',
            pricePerHour: room.pricePerHour || 0,
            status: room.status || 'active',
            createdAt: room.createdAt
          }));
          mapped.sort((a: any, b: any) => {
            const timeA = parseTimestampToMs(a.createdAt);
            const timeB = parseTimestampToMs(b.createdAt);
            return timeB - timeA;
          });
          setRooms(mapped);
        }
      } catch (err) {
        console.warn('Fallback: could not fetch active rooms:', err);
      } finally {
        setLoadingRooms(false);
      }
    };

    // First fetch immediately
    fetchActiveRoomsQuietly();

    // Set up continuous fallback API polling interval of 3 seconds
    intervalId = setInterval(fetchActiveRoomsQuietly, 3000);

    let unsubscribe: (() => void) | undefined;
    if (db) {
      const q = query(
        collection(db, 'rooms'),
        where('status', '==', 'active')
      );
      try {
        unsubscribe = onSnapshot(q, (snapshot) => {
          const activeRooms: Room[] = [];
          snapshot.forEach((doc) => {
            const data = doc.data();
            activeRooms.push({
              id: doc.id,
              name: data.name || 'Sala sem nome',
              streamerId: data.streamerId || '',
              pricePerHour: data.pricePerHour || 0,
              status: data.status || 'active',
              createdAt: data.createdAt
            } as Room);
          });
          
          setRooms(prev => {
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
          console.warn('Realtime rooms fetch restricted or offline. Staying on API polling fallback...', error);
        });
      } catch (e) {
        console.warn('Failed to set up onSnapshot in Dashboard:', e);
      }
    }

    return () => {
      if (unsubscribe) unsubscribe();
      if (intervalId) clearInterval(intervalId);
    };
  }, [user]);

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    if (!roomName.trim()) {
      showToast('O nome do canal é obrigatório.', 'error');
      return;
    }

    setCreating(true);
    try {
      const mockToken = `header.${btoa(JSON.stringify({ user_id: user.uid, email: user.email, email_verified: true, role: profile?.role || 'viewer' }))}.signature`;
      const response = await fetch(`${API_URL}/api/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${mockToken}`
        },
        body: JSON.stringify({
          name: roomName,
          pricePerHour: isPremium ? parseFloat(roomPrice) || 0 : 0
        })
      });

      if (response.ok) {
        const data = await response.json();
        showToast('Sessão cadastrada com sucesso! Pronto para transmitir.', 'success');
        setShowCreateModal(false);
        setRoomName('');
        onJoinRoom(data.room.id, true);
      } else {
        const text = await response.text();
        let errorMsg = 'Erro ao registrar sala';
        try {
          const parsed = JSON.parse(text);
          errorMsg = parsed.error || errorMsg;
        } catch (_) {
          errorMsg = text || errorMsg;
        }
        showToast(errorMsg, 'error');
      }
    } catch (err: any) {
      showToast(err.message || 'Erro de rede', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleJoinByCode = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = inviteCode.trim();
    if (!cleanCode) {
      showToast('Digite um código de sala válido.', 'info');
      return;
    }
    const foundRoom = rooms.find(r => r.id === cleanCode);
    const isStreamer = foundRoom ? (foundRoom.streamerId === user?.uid) : false;
    onJoinRoom(cleanCode, isStreamer);
  };

  const filteredRooms = rooms.filter(room => 
    room.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    room.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div id="dashboard_root_container" className="flex-1 w-full max-w-7xl mx-auto px-6 py-8 flex flex-col gap-8">
      
      {/* Header section */}
      <div id="dashboard_header_segment" className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#2A2A2E]/50 pb-6">
        <div>
          <span className="text-xs font-mono font-bold text-[#3b82f6] uppercase tracking-wider">WORKSPACE</span>
          <h1 className="text-2xl font-black text-white mt-1">
            Olá, {profile?.displayName || user?.displayName || user?.email || 'Navegador'}
          </h1>
          <p className="text-xs text-neutral-400 mt-0.5">Explore transmissões ao vivo ou compartilhe sua tela em tempo real.</p>
        </div>

        <div className="flex items-center gap-3">
          <button
            id="transactions_button"
            onClick={onNavigateToTransactions}
            className="flex items-center gap-1.5 bg-[#0E0E10] hover:bg-[#141417] border border-[#2A2A2E] text-xs font-mono font-bold text-neutral-300 py-2 px-4 rounded-xl cursor-pointer transition-all"
          >
            <Coins className="w-4 h-4 text-[#3b82f6]" />
            <span>Meu Histórico financeiro</span>
          </button>
          
          {profile?.role === 'admin' && (
            <button
              id="admin_button"
              onClick={onNavigateToAdmin}
              className="flex items-center gap-1.5 bg-emerald-950/40 text-emerald-400 hover:bg-emerald-600/20 border border-emerald-500/20 text-xs font-mono font-bold py-2 px-4 rounded-xl cursor-pointer transition-all"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>Painel Admin</span>
            </button>
          )}

          <button
            id="create_room_trigger"
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 bg-[#005ae6] hover:bg-[#004bb3] text-xs font-mono font-bold text-white py-2 px-4 rounded-xl cursor-pointer transition-all shadow-md hover:shadow-[#005ae6]/20"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Criar Sala</span>
          </button>
        </div>
      </div>

      {/* Info grid */}
      <div id="dashboard_info_grid" className="grid grid-cols-1 md:grid-cols-12 gap-6 items-stretch">
        
        {/* Balance Card */}
        <div id="balance_card" className="md:col-span-4 bg-[#0E0E10] border border-[#2A2A2E] rounded-xl p-5 flex flex-col justify-between">
          <div className="flex justify-between items-start">
            <div>
              <span className="text-[10px] font-mono text-[#6B6B76] uppercase tracking-wider font-bold block">Faturamento Atual</span>
              <h3 className="text-2xl font-mono font-extrabold text-white mt-1.5">
                R$ {profile?.balance !== undefined ? profile.balance.toFixed(2) : '0.00'}
              </h3>
            </div>
            <div className="p-2.5 bg-[#3b82f6]/10 rounded-lg border border-[#3b82f6]/20 text-[#3b82f6]">
              <DollarSign className="w-5 h-5" />
            </div>
          </div>
          
          <div className="mt-6 pt-4 border-t border-[#2A2A2E]/50 flex items-center justify-between text-xs font-mono">
            <span className="text-neutral-400">Perfil de Acesso</span>
            <span className="text-[#3b82f6] font-bold uppercase">{profile?.role || 'viewer'}</span>
          </div>
        </div>

        {/* Connect via Code */}
        <div id="room_code_entry_card" className="md:col-span-8 bg-[#0E0E10] border border-[#2A2A2E] rounded-xl p-5 flex flex-col justify-center">
          <span className="text-[10px] font-mono text-[#6B6B76] uppercase tracking-wider font-bold block">Acessar canal por ID</span>
          <p className="text-xs text-[#8E8E99] mt-1 pr-6 leading-relaxed">
            Se possuir o identificador único de alguma transmissão ou estiver participando de uma sessão privada, digite a credencial abaixo para ingressar sem lag.
          </p>

          <form onSubmit={handleJoinByCode} className="flex gap-2.5 mt-5">
            <div className="relative flex-1">
              <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Ex: room_9x92b9z"
                className="w-full bg-[#0A0A0C] border border-[#2A2A2E] text-xs font-mono rounded-xl pl-9 pr-4 py-2.5 text-neutral-100 placeholder-neutral-600 outline-none focus:border-[#3b82f6] transition-all"
              />
            </div>
            <button
              type="submit"
              className="bg-[#141417] hover:bg-[#1a1a1f] border border-[#2A2A2E] text-xs font-mono font-bold text-[#E2E2E9] px-5 rounded-xl cursor-pointer transition-all active:scale-95"
            >
              Entrar na Sala
            </button>
          </form>
        </div>

      </div>

      {/* Main Exploration Panel */}
      <div id="exploration_wrapper" className="flex flex-col gap-5 bg-[#08080A]/20 p-5 border border-[#1C1C21] rounded-2xl">
        
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-[#1C1C21]/80 pb-4 gap-4">
          <div className="flex items-center gap-2">
            <Compass className="w-5 h-5 text-[#3b82f6]" />
            <span className="text-sm font-bold uppercase tracking-wider text-neutral-300 font-mono">
              Sinais e Transmissões Ao Vivo
            </span>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-neutral-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Pesquisar transmissões ativas..."
              className="w-full bg-[#0E0E10] border border-[#2A2A2E] text-xs rounded-xl pl-9 pr-3 py-2 text-neutral-100 placeholder-neutral-600 outline-none focus:border-[#3b82f6] transition-all"
            />
          </div>
        </div>

        {loadingRooms ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((n) => (
              <div key={n} className="bg-[#0E0E10] border border-[#2A2A2E] rounded-xl h-44 p-5 animate-pulse flex flex-col justify-between">
                <div className="space-y-2">
                  <div className="h-4 bg-[#1c1c22] rounded w-2/3" />
                  <div className="h-3 bg-[#1c1c22] rounded w-1/2" />
                </div>
                <div className="h-8 bg-[#1c1c22] rounded w-full" />
              </div>
            ))}
          </div>
        ) : filteredRooms.length === 0 ? (
          <div className="border border-dashed border-[#1C1C21] rounded-2xl flex flex-col items-center justify-center text-center p-12 bg-[#0E0E10]/20">
            <Tv className="w-10 h-10 text-neutral-600 mb-2" />
            <span className="text-xs font-mono text-[#8E8E99] font-semibold">Nenhuma transmissão real ativa</span>
            <p className="text-[11px] text-[#6B6B76] mt-1 max-w-sm">No momento não há nenhuma stream sendo transmitida por outros usuários. Deseja iniciar compartilhando sua tela agora?</p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="mt-4 flex items-center gap-1.5 bg-[#005ae6] hover:bg-[#004bb3] text-[10px] font-mono font-bold text-white py-1.5 px-3 rounded-lg cursor-pointer transition-all"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Estrear Minha Tela</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredRooms.map((room) => (
              <motion.div
                key={room.id}
                layout
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-[#0E0E10] border border-[#2A2A2E] bg-[radial-gradient(ellipse_at_bottom_right,_var(--tw-gradient-stops))] from-[#0e0e10] via-[#0c0c0e] to-neutral-900/45 rounded-xl p-5 hover:border-[#3b82f6]/50 transition-all flex flex-col justify-between group"
              >
                <div>
                  <div className="flex justify-between items-start">
                    <span className="text-[9px] font-mono text-[#6B6B76] px-2 py-0.5 bg-[#0A0A0C] border border-[#2A2A2E] rounded">
                      ID: {room.id.substring(0, 10)}...
                    </span>
                    <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded ${
                      room.pricePerHour > 0 
                        ? 'bg-amber-950/50 text-amber-500 border border-amber-955/40' 
                        : 'bg-emerald-950/50 text-emerald-400 border border-emerald-900/40'
                    }`}>
                      {room.pricePerHour > 0 ? `R$ ${room.pricePerHour.toFixed(2)} / Pix` : 'FREE ACCESS'}
                    </span>
                  </div>

                  <h3 className="text-sm font-bold text-neutral-200 mt-4 truncate group-hover:text-white transition-colors">{room.name}</h3>
                  <p className="text-[11px] text-[#6B6B76] mt-1 flex items-center gap-1 font-mono">
                    <User className="w-3 h-3 text-neutral-500" />
                    <span>Dono do Sinal: {room.streamerId.substring(0, 12)}...</span>
                  </p>
                </div>

                <button
                  onClick={() => onJoinRoom(room.id, room.streamerId === user?.uid)}
                  className="mt-6 flex items-center justify-center gap-1.5 w-full bg-[#141417] hover:bg-[#005ae6] hover:text-white border border-[#2A2A2E] hover:border-[#005ae6] text-xs font-mono font-bold text-neutral-200 py-2 rounded-lg cursor-pointer transition-all"
                >
                  <span>Assistir</span>
                  <ExternalLink className="w-3 h-3" />
                </button>
              </motion.div>
            ))}
          </div>
        )}

      </div>

      {/* Create Room Modal overlay */}
      <AnimatePresence>
        {showCreateModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
            <div className="fixed inset-0 bg-black/80 pointer-events-auto" onClick={() => setShowCreateModal(false)} />
            
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              className="relative bg-[#0E0E10] border border-[#2A2A2E] p-6 rounded-2xl max-w-md w-full shadow-2xl z-10"
            >
              <h2 className="text-base font-bold text-neutral-100 flex items-center gap-1.5 border-b border-[#2A2A2E] pb-3 mb-4 font-mono">
                <Radio className="w-4 h-4 text-[#005ae6]" />
                <span>Criar uma Transmissão ao vivo</span>
              </h2>

              <form onSubmit={handleCreateRoom} className="space-y-4">
                
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-mono text-neutral-400">Nome do Canal / Transmissão</label>
                  <input
                    type="text"
                    required
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                    placeholder="Ex: Minha live de programação"
                    className="w-full bg-[#0A0A0C] border border-[#2A2A2E] text-xs rounded-xl p-3 text-neutral-100 placeholder-neutral-700 outline-none focus:border-[#005ae6]"
                  />
                </div>

                {/* Premium toggle access rule */}
                <div className="bg-[#0A0A0C] p-3 rounded-xl border border-[#2A2A2E] space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-mono font-semibold block text-neutral-300">Sala Privada Premium (Pix)</span>
                      <span className="text-[10px] text-[#6B6B76] leading-snug">Habilite taxa de acesso por Pix validado manual.</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={isPremium}
                        onChange={(e) => setIsPremium(e.target.checked)}
                        className="sr-only peer" 
                      />
                      <div className="w-9 h-5 bg-[#2A2A2E] rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-neutral-800 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#005ae6] peer-checked:after:bg-white"></div>
                    </label>
                  </div>

                  {isPremium && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="flex flex-col gap-1 pt-2 border-t border-[#2A2A2E]/50"
                    >
                      <label className="text-[10px] font-mono text-neutral-400">Valor do Ingresso (R$ por Conexão)</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-mono text-[#6B6B76]">R$</span>
                        <input
                          type="text"
                          value={roomPrice}
                          onChange={(e) => setRoomPrice(e.target.value)}
                          placeholder="25.00"
                          className="w-full bg-[#0E0E10] border border-[#2A2A2E] text-xs font-mono rounded-xl pl-9 pr-3 py-2 text-neutral-100 placeholder-neutral-700 outline-none focus:border-[#005ae6]"
                        />
                      </div>
                    </motion.div>
                  )}
                </div>

                <div className="flex gap-2.5 pt-4 border-t border-[#2A2A2E]/50">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="flex-1 bg-transparent hover:bg-neutral-900 border border-[#2A2A2E] text-xs font-mono font-semibold text-[#8E8E99] py-2.5 rounded-xl cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={creating}
                    className="flex-1 bg-[#005ae6] hover:bg-[#004bb3] text-xs font-mono font-bold text-white py-2.5 rounded-xl cursor-pointer transition-all flex items-center justify-center gap-1"
                  >
                    {creating ? 'Registrando...' : 'Estrear Tela'}
                  </button>
                </div>

              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
};
