import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { db } from '../firebase/config';
import { API_URL } from '../config/api';
import { collection, query, where, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { 
  ArrowLeft, 
  Coins, 
  ArrowUpRight, 
  ArrowDownLeft, 
  Clock, 
  CheckCircle, 
  AlertTriangle,
  Send,
  Loader2,
  Wallet
} from 'lucide-react';

interface TransactionsPageProps {
  onExit: () => void;
}

interface TransactionLog {
  id: string;
  userId: string;
  type: 'credit' | 'debit';
  amount: number;
  referenceId: string;
  createdAt: any;
}

export const TransactionsPage: React.FC<TransactionsPageProps> = ({ onExit }) => {
  const { user, profile } = useAuth();
  const { showToast } = useToast();

  const [transactions, setTransactions] = useState<TransactionLog[]>([]);
  const [loading, setLoading] = useState(true);

  // Withdrawal Cashout action form state
  const [cashoutAmount, setCashoutAmount] = useState('50.00');
  const [pixKey, setPixKey] = useState(profile?.pixKey || '');
  const [withdrawing, setWithdrawing] = useState(false);

  // Keep pixKey in sync with profile updates
  useEffect(() => {
    if (profile?.pixKey) {
      setPixKey(profile.pixKey);
    }
  }, [profile?.pixKey]);

  useEffect(() => {
    if (!user) return;

    if (!db) {
      setTransactions([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      // Construct dynamic query to read current user transactions list
      const txsQuery = query(
        collection(db, 'transactions'),
        where('userId', '==', user.uid)
      );

      const unsubscribe = onSnapshot(txsQuery, (snapshot) => {
        const list: TransactionLog[] = [];
        snapshot.forEach((doc) => {
          list.push({ id: doc.id, ...doc.data() } as TransactionLog);
        });
        
        // Sort in-memory to avoid needing a Firestore composite index
        list.sort((a, b) => {
          const timeA = a.createdAt ? (typeof a.createdAt === 'string' ? new Date(a.createdAt).getTime() : a.createdAt.seconds * 1000) : 0;
          const timeB = b.createdAt ? (typeof b.createdAt === 'string' ? new Date(b.createdAt).getTime() : b.createdAt.seconds * 1000) : 0;
          return timeB - timeA;
        });

        setTransactions(list.slice(0, 40));
        setLoading(false);
      }, (error) => {
        console.error('Transactions direct query failed:', error);
        setTransactions([]);
        setLoading(false);
      });

      return () => unsubscribe();
    } catch (err) {
      console.error('Error in transactions fetch:', err);
      setTransactions([]);
      setLoading(false);
    }
  }, [user]);

  const handleRequestWithdrawal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    const amountValue = parseFloat(cashoutAmount);
    if (isNaN(amountValue) || amountValue <= 0) {
      showToast('Digite um valor monetário positivo para sacar.', 'error');
      return;
    }

    if (!pixKey.trim()) {
      showToast('Por favor, informe a sua Chave PIX para fins de transferência.', 'error');
      return;
    }

    if ((profile?.balance || 0) < amountValue) {
      showToast(`Saldo insuficiente. Seu faturamento atual é: R$ ${(profile?.balance || 0).toFixed(2)}`, 'error');
      return;
    }

    setWithdrawing(true);
    try {
      const mockToken = `header.${btoa(JSON.stringify({ user_id: user.uid, email: user.email, email_verified: true, role: profile?.role || 'streamer' }))}.signature`;
      const response = await fetch(`${API_URL}/api/withdrawals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${mockToken}`
        },
        body: JSON.stringify({
          amount: amountValue,
          pixKey: pixKey.trim()
        })
      });

      if (response.ok) {
        showToast('Pedido de saque registrado! Aguarde compensação admin.', 'success');
        setCashoutAmount('50.00');
        
        // Append optimistic log
        const optimisticId = 'with_pending_' + Math.random().toString(36).substring(2, 6);
        setTransactions(prev => [
          {
            id: optimisticId,
            userId: user.uid,
            type: 'debit',
            amount: amountValue,
            referenceId: 'Saque Pendente',
            createdAt: new Date().toISOString()
          },
          ...prev
        ]);
      } else {
        const text = await response.text();
        let errorMsg = 'Erro ao efetivar solitação de resgate.';
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
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <div className="flex-1 w-full max-w-7xl mx-auto px-6 py-8 flex flex-col gap-8">
      
      {/* Structural visual title bars */}
      <div className="flex items-center gap-4 border-b border-[#2A2A2E]/50 pb-6 shrink-0">
        <button
          onClick={onExit}
          className="p-2 hover:bg-[#0E0E10] border border-[#2A2A2E] text-neutral-400 hover:text-white rounded-lg transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <span className="text-xs font-mono font-bold text-[#3b82f6] uppercase tracking-wider block">ACCOUNT ARITHMETIC LEDGER</span>
          <h1 className="text-xl font-bold text-neutral-100 mt-1 uppercase tracking-tight">Extrato & Carteira Financeira</h1>
        </div>
      </div>

      {/* Main operational ledger interfaces */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* Left payout requester (col-span-4) */}
        <div className="lg:col-span-4 bg-[#0E0E10] border border-[#2A2A2E] rounded-xl p-5 flex flex-col gap-4 relative">
          <div className="absolute top-0 left-0 w-full h-1 bg-[#005ae6]" />
          
          <div className="flex justify-between items-center">
            <h3 className="text-xs font-bold text-neutral-300 uppercase tracking-wider font-mono">Resgatar Lucros</h3>
            <Wallet className="w-5 h-5 text-[#3b82f6]" />
          </div>

          <p className="text-xs text-neutral-400 leading-relaxed font-sans">
            Streamers qualificados podem resgatar lucros compensados de transmissões instantaneamente. O valor solicitado será debitado e processado pela mesa administrativa do RT-Cast.
          </p>

          <div className="bg-[#0A0A0C] border border-[#232328] p-4 rounded-xl flex justify-between items-center">
            <div>
              <span className="text-[10px] font-mono text-[#6B6B76] uppercase">Saldo Transferível</span>
              <h2 className="text-xl font-mono font-bold text-white mt-1">
                R$ {profile?.balance !== undefined ? profile.balance.toFixed(2) : '0.00'}
              </h2>
            </div>
            <Coins className="w-6 h-6 text-amber-500 animate-pulse" />
          </div>

          {profile?.role === 'viewer' ? (
            <div className="p-4 bg-[#141417]/40 border border-[#2A2A2E] rounded-xl text-center">
              <AlertTriangle className="w-5 h-5 text-[#8E8E99] mx-auto mb-1.5" />
              <p className="text-[11px] text-neutral-400 font-sans">Apenas usuários operantes como <span className="font-bold text-[#3b82f6]">Streamer</span> ou <span className="font-bold text-[#3b82f6]">Admin</span> podem solicitar saques de comissões.</p>
            </div>
          ) : (
            <form onSubmit={handleRequestWithdrawal} className="space-y-4 pt-2">
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-mono text-neutral-400 uppercase">Quantia do Saque (R$)</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs font-mono text-[#6B6B76]">R$</span>
                  <input
                    type="text"
                    required
                    value={cashoutAmount}
                    onChange={(e) => setCashoutAmount(e.target.value)}
                    placeholder="50.00"
                    className="w-full bg-[#0A0A0C] border border-[#232328] font-mono text-xs rounded-xl pl-9 pr-3 py-2.5 text-neutral-100 placeholder-neutral-700 outline-none focus:border-[#005ae6]"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-mono text-neutral-400 uppercase">Sua Chave PIX</label>
                <div className="relative">
                  <input
                    type="text"
                    required
                    value={pixKey}
                    onChange={(e) => setPixKey(e.target.value)}
                    placeholder="E-mail, Celular, CPF ou Aleatória"
                    className="w-full bg-[#0A0A0C] border border-[#232328] font-mono text-xs rounded-xl px-3.5 py-2.5 text-neutral-100 placeholder-neutral-700 outline-none focus:border-[#005ae6]"
                  />
                </div>
                <span className="text-[9px] text-[#6B6B76] leading-normal font-sans">
                  Esta chave Pix será salva em seu perfil e enviada diretamente para a auditoria dos administradores.
                </span>
              </div>

              <button
                type="submit"
                disabled={withdrawing}
                className="w-full bg-[#005ae6] hover:bg-[#004bb3] text-xs font-mono font-bold text-white py-2.5 rounded-xl cursor-pointer transition-colors flex items-center justify-center gap-1"
              >
                {withdrawing ? 'Processando Saque...' : 'Efetuar Pedido de Saque'}
              </button>
            </form>
          )}
        </div>

        {/* Right transactional table timeline ledger (col-span-8) */}
        <div className="lg:col-span-8 bg-[#0E0E10] border border-[#2A2A2E] rounded-xl overflow-hidden flex flex-col shadow-lg">
          <div className="p-4 border-b border-[#2A2A2E] bg-[#141417]/30">
            <span className="text-xs font-mono font-black text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-[#3b82f6]" />
              <span>Histórico de Operações e Lançamentos</span>
            </span>
          </div>

          <div className="p-4 flex flex-col gap-3 min-h-[350px]">
            {loading ? (
              <div className="flex-1 flex items-center justify-center text-xs font-mono text-[#6B6B76]">
                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando extrato sincronizado...
              </div>
            ) : transactions.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-12 text-[#6B6B76] border border-dashed border-[#2A2A2E] rounded-xl bg-[#0A0A0C]/20">
                <Coins className="w-10 h-10 text-neutral-800 mb-2" />
                <span className="text-xs font-mono text-neutral-300">Sem Movimentações</span>
                <p className="text-[10px] text-neutral-500 mt-1 max-w-xs leading-snug">Seu extrato de repasses e ingressos está sem alterações registradas no Ledger do Firestore.</p>
              </div>
            ) : (
              transactions.map((tx) => (
                <div key={tx.id} className="bg-[#0A0A0C] border border-[#2A2A2E] p-3 rounded-xl flex items-center justify-between font-mono text-xs">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${
                      tx.type === 'credit' 
                        ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/30' 
                        : 'bg-red-950/40 text-red-400 border border-red-900/40'
                    }`}>
                      {tx.type === 'credit' ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-neutral-200">
                          {tx.type === 'credit' ? 'Credito de Ingresso' : 'Debito de Paga/Saque'}
                        </span>
                        <span className="text-[9px] text-[#6B6B76] bg-[#141417] px-1.5 py-0.2 rounded">
                          REF: {tx.referenceId ? tx.referenceId.substring(0, 12) : 'tx'}
                        </span>
                      </div>
                      <span className="text-[9px] text-neutral-500 block mt-0.5">
                        {typeof tx.createdAt === 'string' ? tx.createdAt.substring(0, 19).replace('T', ' ') : 'Agendado'}
                      </span>
                    </div>
                  </div>

                  <span className={`font-extrabold text-sm ${tx.type === 'credit' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {tx.type === 'credit' ? '+' : '-'} R$ {tx.amount.toFixed(2)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

      </div>

    </div>
  );
};
