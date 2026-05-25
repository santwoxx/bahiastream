import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { db } from '../firebase/config';
import { API_URL } from '../config/api';
import { collection, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import { 
  ShieldAlert, 
  Coins, 
  Tv, 
  Users, 
  Check, 
  X, 
  Activity, 
  DollarSign, 
  ArrowLeft, 
  TrendingUp,
  Sliders,
  Award,
  Loader2
} from 'lucide-react';

interface AdminPanelProps {
  onExit: () => void;
}

interface Payment {
  id: string;
  payerId: string;
  streamerId: string;
  amount: number;
  platformFee: number;
  streamerFee: number;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: any;
}

interface Withdrawal {
  id: string;
  userId: string;
  userDisplayName?: string;
  userEmail?: string;
  pixKey?: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: any;
}

export const AdminPanel: React.FC<AdminPanelProps> = ({ onExit }) => {
  const { user } = useAuth();
  const { showToast } = useToast();

  const [payments, setPayments] = useState<Payment[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [loading, setLoading] = useState(true);

  // Administrative stats
  const [platformEarnings, setPlatformEarnings] = useState(0);
  const [processedTxCount, setProcessedTxCount] = useState(0);

  // Real data loading from Firestore
  useEffect(() => {
    if (!db) {
      setPayments([]);
      setWithdrawals([]);
      setPlatformEarnings(0);
      setProcessedTxCount(0);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      // Query payments from Firestore live
      const paymentsQuery = query(collection(db, 'payments'), orderBy('createdAt', 'desc'), limit(50));
      const unsubscribePayments = onSnapshot(paymentsQuery, (snapshot) => {
        const list: Payment[] = [];
        let feesSum = 0;
        let count = 0;
        snapshot.forEach((doc) => {
          const item = { id: doc.id, ...doc.data() } as Payment;
          list.push(item);
          if (item.status === 'approved') {
            feesSum += item.platformFee || (item.amount * 0.50);
            count++;
          }
        });
        setPayments(list);
        setPlatformEarnings(feesSum);
        setProcessedTxCount(count);
        setLoading(false);
      }, (error) => {
        console.error('Error fetching payments from Firestore:', error);
        setPayments([]);
        setLoading(false);
      });

      // Query withdrawals from Firestore live
      const withdrawalsQuery = query(collection(db, 'withdrawalRequests'), orderBy('createdAt', 'desc'), limit(50));
      const unsubscribeWithdrawals = onSnapshot(withdrawalsQuery, (snapshot) => {
        const list: Withdrawal[] = [];
        snapshot.forEach((doc) => {
          list.push({ id: doc.id, ...doc.data() } as Withdrawal);
        });
        setWithdrawals(list);
      }, (error) => {
        console.error('Error fetching withdrawal requests from Firestore:', error);
        setWithdrawals([]);
      });

      return () => {
        unsubscribePayments();
        unsubscribeWithdrawals();
      };
    } catch (err) {
      console.error('Error establishing Firestore live connections:', err);
      setPayments([]);
      setWithdrawals([]);
      setLoading(false);
    }
  }, []);

  const handleApprovePayment = async (paymentId: string) => {
    try {
      const mockToken = `header.${btoa(JSON.stringify({ user_id: user?.uid, email: user?.email, email_verified: true, role: 'admin' }))}.signature`;
      const res = await fetch(`${API_URL}/api/payments/${paymentId}/approve`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${mockToken}` }
      });

      if (res.ok) {
        showToast('Pagamento Pix validado e saldo creditado ao streamer!', 'success');
        
        // Optimistic UI updates for local fallback mock users
        setPayments(prev => prev.map(p => p.id === paymentId ? { ...p, status: 'approved' } : p));
      } else {
        const text = await res.text();
        let errorMsg = 'Erro ao processar alteração.';
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
    }
  };

  const handleRejectPayment = async (paymentId: string) => {
    try {
      const mockToken = `header.${btoa(JSON.stringify({ user_id: user?.uid, email: user?.email, email_verified: true, role: 'admin' }))}.signature`;
      const res = await fetch(`${API_URL}/api/payments/${paymentId}/reject`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${mockToken}` }
      });

      if (res.ok) {
        showToast('Comprovante Pix descartado/rejeitado.', 'info');
        setPayments(prev => prev.map(p => p.id === paymentId ? { ...p, status: 'rejected' } : p));
      } else {
        const text = await res.text();
        let errorMsg = 'Erro ao rejeitar.';
        try {
          const parsed = JSON.parse(text);
          errorMsg = parsed.error || errorMsg;
        } catch (_) {
          errorMsg = text || errorMsg;
        }
        showToast(errorMsg, 'error');
      }
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  const handleApproveWithdrawal = async (requestId: string) => {
    try {
      const mockToken = `header.${btoa(JSON.stringify({ user_id: user?.uid, email: user?.email, email_verified: true, role: 'admin' }))}.signature`;
      const res = await fetch(`${API_URL}/api/withdrawals/${requestId}/approve`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${mockToken}` }
      });

      if (res.ok) {
        showToast('Saque aprovado! Pix despido para conta bancária do streamer.', 'success');
        setWithdrawals(prev => prev.map(w => w.id === requestId ? { ...w, status: 'approved' } : w));
      } else {
        const text = await res.text();
        let errorMsg = 'Erro ao processar saque.';
        try {
          const parsed = JSON.parse(text);
          errorMsg = parsed.error || errorMsg;
        } catch (_) {
          errorMsg = text || errorMsg;
        }
        showToast(errorMsg, 'error');
      }
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  const handleRejectWithdrawal = async (requestId: string) => {
    try {
      const mockToken = `header.${btoa(JSON.stringify({ user_id: user?.uid, email: user?.email, email_verified: true, role: 'admin' }))}.signature`;
      const res = await fetch(`${API_URL}/api/withdrawals/${requestId}/reject`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${mockToken}` }
      });

      if (res.ok) {
        showToast('Saque recusado. Saldos de faturamento restaurados na carteira do streamer.', 'info');
        setWithdrawals(prev => prev.map(w => w.id === requestId ? { ...w, status: 'rejected' } : w));
      } else {
        const text = await res.text();
        let errorMsg = 'Erro ao estornar saque.';
        try {
          const parsed = JSON.parse(text);
          errorMsg = parsed.error || errorMsg;
        } catch (_) {
          errorMsg = text || errorMsg;
        }
        showToast(errorMsg, 'error');
      }
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  const activePixAlerts = payments.filter(p => p.status === 'pending');
  const activeWithdrawRequests = withdrawals.filter(w => w.status === 'pending');

  return (
    <div className="flex-1 w-full max-w-7xl mx-auto px-6 py-8 flex flex-col gap-8">
      
      {/* Admin Title segment */}
      <div className="flex items-center gap-4 border-b border-[#2A2A2E]/50 pb-6 shrink-0">
        <button
          onClick={onExit}
          className="p-2 hover:bg-[#0E0E10] border border-[#2A2A2E] text-neutral-400 hover:text-white rounded-lg transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <span className="text-xs font-mono font-bold text-emerald-400 uppercase tracking-wider block">GOVERNANCE & FINANCIAL CONTROL</span>
          <h1 className="text-xl font-bold text-neutral-100 mt-1 uppercase tracking-tight">Painel de Auditoria Administrativa</h1>
        </div>
      </div>

      {/* Platform high fidelity metrics bento layout */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        
        <div className="bg-[#0E0E10] border border-[#2A2A2E] p-5 rounded-xl">
          <span className="text-[10px] font-mono text-[#6B6B76] uppercase tracking-wider font-bold block">Taxas Acumuladas (Plataforma)</span>
          <div className="flex justify-between items-baseline mt-2">
            <h3 className="text-2xl font-mono font-extrabold text-[#3b82f6]">R$ {platformEarnings.toFixed(2)}</h3>
            <span className="text-[10px] font-mono text-emerald-500 font-bold bg-emerald-950/40 px-1.5 py-0.5 rounded">Rake 50%</span>
          </div>
        </div>

        <div className="bg-[#0E0E10] border border-[#2A2A2E] p-5 rounded-xl">
          <span className="text-[10px] font-mono text-[#6B6B76] uppercase tracking-wider font-bold block">Registros Pix Aprovados</span>
          <div className="flex justify-between items-baseline mt-2">
            <h3 className="text-2xl font-mono font-extrabold text-neutral-100">{processedTxCount}</h3>
            <TrendingUp className="w-4 h-4 text-[#3b82f6]" />
          </div>
        </div>

        <div className="bg-[#0E0E10] border border-[#2A2A2E] p-5 rounded-xl">
          <span className="text-[10px] font-mono text-[#6B6B76] uppercase tracking-wider font-bold block">Pix Pendentes de Conciliação</span>
          <div className="flex justify-between items-baseline mt-2">
            <h3 className={`text-2xl font-mono font-extrabold ${activePixAlerts.length > 0 ? 'text-amber-500' : 'text-neutral-500'}`}>
              {activePixAlerts.length}
            </h3>
            <Activity className={`w-4 h-4 ${activePixAlerts.length > 0 ? 'text-amber-500 animate-pulse' : 'text-neutral-600'}`} />
          </div>
        </div>

        <div className="bg-[#0E0E10] border border-[#2A2A2E] p-5 rounded-xl">
          <span className="text-[10px] font-mono text-[#6B6B76] uppercase tracking-wider font-bold block">Surgimento de Saques</span>
          <div className="flex justify-between items-baseline mt-2">
            <h3 className={`text-2xl font-mono font-extrabold ${activeWithdrawRequests.length > 0 ? 'text-blue-500 animate-pulse' : 'text-neutral-500'}`}>
              {activeWithdrawRequests.length}
            </h3>
            <Coins className="w-4 h-4 text-blue-500" />
          </div>
        </div>

      </div>

      {/* Admin Operations Split Columns */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* 1. LEFT COLUMN: Pending/Processed Pix Subscription payments (col-span-6) */}
        <div className="lg:col-span-6 bg-[#0E0E10] border border-[#2A2A2E] rounded-xl overflow-hidden shadow-lg">
          <div className="p-4 border-b border-[#2A2A2E] bg-[#141417]/40 flex justify-between items-center">
            <span className="text-xs font-mono font-black text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
              <Sliders className="w-4 h-4 text-[#3b82f6]" />
              <span>Conciliação de Comprovantes Pix</span>
            </span>
          </div>

          <div className="p-4 flex flex-col gap-3 min-h-[300px]">
            {loading ? (
              <div className="flex-1 flex items-center justify-center p-8 text-xs font-mono text-[#6B6B76]">
                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando auditorias...
              </div>
            ) : payments.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-12 text-[#6B6B76] border border-dashed border-[#2A2A2E] rounded-xl bg-[#0A0A0C]/20">
                <ShieldAlert className="w-8 h-8 text-neutral-800 mb-2" />
                <span className="text-xs font-mono text-neutral-400">Ledger Limpo</span>
                <p className="text-[10px] text-neutral-500 mt-0.5">Sem solicitações de ingresso pendentes.</p>
              </div>
            ) : (
              payments.map((p) => (
                <div key={p.id} className="bg-[#0A0A0C] border border-[#2A2A2E] p-3 rounded-xl font-mono text-xs flex flex-col gap-2">
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-[#aa9df3]">{p.id}</span>
                    <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase border ${
                      p.status === 'pending' ? 'bg-amber-950/40 text-amber-500 border-amber-900/30' :
                      p.status === 'approved' ? 'bg-emerald-950/40 text-emerald-400 border-emerald-950/40' :
                      'bg-red-950/40 text-red-500 border-red-950/40'
                    }`}>
                      {p.status}
                    </span>
                  </div>

                  <div className="text-[10px] text-[#6B6B76] grid grid-cols-2 gap-y-1 py-1 bg-[#141417]/20 p-2 rounded">
                    <span>Viewer: {p.payerId.substring(0, 12)}...</span>
                    <span>Streamer: {p.streamerId.substring(0, 12)}...</span>
                    <span>Data: {typeof p.createdAt === 'string' ? p.createdAt.substring(11, 19) : 'Recente'}</span>
                  </div>

                  <div className="flex justify-between items-baseline pt-1">
                    <div className="flex gap-2">
                      <span className="text-neutral-300 font-extrabold text-sm">R$ {p.amount.toFixed(2)}</span>
                      <span className="text-[9px] text-neutral-500 self-center">Plataforma (10%): R$ {p.platformFee.toFixed(2)}</span>
                    </div>

                    {p.status === 'pending' && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleApprovePayment(p.id)}
                          className="bg-emerald-600/20 hover:bg-emerald-600 text-[10px] font-bold text-emerald-400 hover:text-white p-1 px-2.5 rounded transition-colors cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleRejectPayment(p.id)}
                          className="bg-red-600/20 hover:bg-red-600 text-[10px] font-bold text-red-400 hover:text-white p-1 px-2.5 rounded transition-colors cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 2. RIGHT COLUMN: Streamers cash withdrawal requests (col-span-6) */}
        <div className="lg:col-span-6 bg-[#0E0E10] border border-[#2A2A2E] rounded-xl overflow-hidden shadow-lg">
          <div className="p-4 border-b border-[#2A2A2E] bg-[#141417]/40">
            <span className="text-xs font-mono font-black text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
              <Coins className="w-4 h-4 text-blue-400" />
              <span>Saques Cadastrados pelos Streamers</span>
            </span>
          </div>

          <div className="p-4 flex flex-col gap-3 min-h-[300px]">
            {withdrawals.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-12 text-[#6B6B76] border border-dashed border-[#2A2A2E] rounded-xl bg-[#0A0A0C]/20 animate-pulse">
                <Coins className="w-8 h-8 text-neutral-800 mb-2" />
                <span className="text-xs font-mono text-neutral-400">Fila Saques Completa</span>
                <p className="text-[10px] text-neutral-500 mt-0.5">Nenhuma doação elegível em repasse.</p>
              </div>
            ) : (
              withdrawals.map((w) => (
                <div key={w.id} className="bg-[#0A0A0C] border border-[#2A2A2E] p-3 rounded-xl font-mono text-xs flex flex-col gap-2">
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-blue-400">{w.id}</span>
                    <span className={`px-2 py-0.5 rounded text-[8px] font-bold uppercase border ${
                      w.status === 'pending' ? 'bg-amber-950/40 text-amber-500 border-amber-900/30' :
                      w.status === 'approved' ? 'bg-emerald-950/40 text-emerald-400 border-emerald-950/40' :
                      'bg-red-950/40 text-red-500 border-red-950/40'
                    }`}>
                      {w.status}
                    </span>
                  </div>

                  {/* Requester User Info Block */}
                  <div className="text-[10px] text-[#8E8E99] flex flex-col gap-1 bg-[#141417]/30 p-2.5 rounded-lg border border-[#2A2A2E]/30 my-1">
                    <div className="flex justify-between">
                      <span className="font-sans text-neutral-400 font-medium">Streamer:</span>
                      <span className="font-sans text-neutral-200 font-bold">{w.userDisplayName || 'Usuário'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-sans text-neutral-400">E-mail:</span>
                      <span className="text-neutral-300 select-all">{w.userEmail || 'Não informado'}</span>
                    </div>
                    <div className="flex justify-between items-center mt-1 pt-1 border-t border-[#2A2A2E]/20">
                      <span className="font-sans text-neutral-400 font-medium">Chave PIX:</span>
                      <span className="text-emerald-400 font-bold bg-emerald-950/30 px-2 py-0.5 rounded border border-emerald-900/30 select-all">
                        {w.pixKey || 'Não cadastrada'}
                      </span>
                    </div>
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-neutral-200 font-extrabold text-sm">R$ {w.amount.toFixed(2)}</span>

                    {w.status === 'pending' && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleApproveWithdrawal(w.id)}
                          className="bg-emerald-600/20 hover:bg-emerald-600 text-[10px] font-bold text-emerald-400 hover:text-white p-1 px-2 rounded cursor-pointer transition-colors"
                        >
                          Efetuar PIX (Aprovar)
                        </button>
                        <button
                          onClick={() => handleRejectWithdrawal(w.id)}
                          className="bg-red-600/20 hover:bg-red-600 text-[10px] font-bold text-red-400 hover:text-white p-1 px-2 rounded cursor-pointer transition-colors"
                        >
                          Recusar Saque
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

      </div>

    </div>
  );
};
