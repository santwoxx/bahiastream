import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider, useToast } from './components/Toast';
import { LandingPage } from './pages/LandingPage';
import { Dashboard } from './pages/Dashboard';
import { StreamPage } from './pages/StreamPage';
import { ViewerPage } from './pages/ViewerPage';
import { AdminPanel } from './pages/AdminPanel';
import { TransactionsPage } from './pages/TransactionsPage';
import { 
  Tv, 
  LogOut, 
  User, 
  Coins, 
  ShieldCheck, 
  ChevronRight, 
  Menu, 
  X,
  Plus
} from 'lucide-react';

type AppView = 'landing' | 'dashboard' | 'streamer' | 'viewer' | 'transactions' | 'admin';

function ApplicationShell() {
  const { user, profile, logout, signInWithGoogle } = useAuth();
  const { showToast } = useToast();

  const [currentView, setCurrentView] = useState<AppView>('landing');
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Redirection helpers
  const handleJoinOrCreateRoom = (roomId: string, isStreamerForce?: boolean) => {
    setActiveRoomId(roomId);
    
    // Determine if they are the owner of this room or simple viewer
    const isStreamer = !!(
      isStreamerForce || 
      (profile?.role === 'streamer' && roomId.startsWith('room_'))
    );
    
    const role = profile?.role || (isStreamer ? 'streamer' : 'viewer');
    const currentPage = isStreamer ? 'streamer' : 'viewer';
    
    console.log("[ROLE]", role);
    console.log("[PAGE]", currentPage);
    console.log("[STREAM MODE]", isStreamer ? "BROADCASTER" : "VIEWER");
    console.log("[ROUTE]", isStreamer ? `/stream/${roomId}` : `/watch/${roomId}`);

    if (isStreamer) {
      setCurrentView('streamer');
    } else {
      setCurrentView('viewer');
    }
  };

  const handleNav = (view: AppView) => {
    setCurrentView(view);
    setMobileMenuOpen(false);
  };

  const handleLogout = async () => {
    try {
      await logout();
      setCurrentView('landing');
      showToast('Sua sessão foi encerrada com sucesso.', 'info');
    } catch {
      showToast('Falha ao desautenticar conta.', 'error');
    }
  };

  // 1. LANDING VIEW
  if (currentView === 'landing' && !user) {
    return <LandingPage onEnterApp={() => handleNav('dashboard')} />;
  }

  // If connected, redirect landing view automatically to Dashboard
  if (currentView === 'landing' && user) {
    setCurrentView('dashboard');
  }

  // 2. FULL SCREEN STREAMING EXPERIENCES (Broadcaster & Viewer)
  if (user && currentView === 'streamer' && activeRoomId) {
    console.log("[ROLE]", profile?.role || 'streamer');
    console.log("[PAGE]", 'streamer');
    console.log("[STREAM MODE]", "BROADCASTER");
    return <StreamPage roomId={activeRoomId} onExit={() => handleNav('dashboard')} />;
  }

  if (user && currentView === 'viewer' && activeRoomId) {
    console.log("[ROLE]", profile?.role || 'viewer');
    console.log("[PAGE]", 'viewer');
    console.log("[STREAM MODE]", "VIEWER");
    return <ViewerPage roomId={activeRoomId} onExit={() => handleNav('dashboard')} />;
  }

  // 3. WORKSPACE PORTALS LAYOUT FRAME (Dashboard, Transactions, Admin Panels)
  return (
    <div className="flex flex-col h-screen bg-[#070709] text-[#E0E0E6] font-sans overflow-hidden">
      
      {/* SaaS Navigation Headers */}
      <header className="h-14 border-b border-[#1c1c22] bg-[#0E0E10] flex items-center justify-between px-6 shrink-0 z-20">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded bg-gradient-to-tr from-[#005ae6] to-[#E52222] flex items-center justify-center cursor-pointer" onClick={() => handleNav('dashboard')}>
            <Tv className="w-4 h-4 text-white" />
          </div>
          <span className="font-mono font-bold tracking-tighter text-xs uppercase cursor-pointer" onClick={() => handleNav('dashboard')}>
            BAHIA STREAM <span className="text-[#E52222] font-normal">//</span> LIVE
          </span>
          <span className="hidden sm:inline px-2 py-0.5 bg-[#141417] rounded text-[9px] text-[#8E8E99] border border-[#232328] font-mono">
            STAGING-01
          </span>
        </div>

        {/* Desktop navbar triggers */}
        <div className="hidden md:flex items-center gap-4">
          <button 
            onClick={() => handleNav('dashboard')}
            className={`text-xs font-mono font-semibold hover:text-white transition-colors cursor-pointer ${currentView === 'dashboard' ? 'text-[#3b82f6]' : 'text-neutral-400'}`}
          >
            Dashboard
          </button>
          <button 
            onClick={() => handleNav('transactions')}
            className={`text-xs font-mono font-semibold hover:text-white transition-colors cursor-pointer ${currentView === 'transactions' ? 'text-[#3b82f6]' : 'text-neutral-400'}`}
          >
            Meu Extrato
          </button>
          
          {profile?.role === 'admin' && (
            <button 
              onClick={() => handleNav('admin')}
              className={`text-xs font-mono font-semibold hover:text-white transition-colors cursor-pointer ${currentView === 'admin' ? 'text-emerald-400' : 'text-neutral-400'}`}
            >
              Auditoria Admin
            </button>
          )}
        </div>

        {/* Session details */}
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 bg-[#0A0A0C] border border-[#1c1c22] rounded-lg px-2.5 py-1 text-xs">
            <Coins className="w-3.5 h-3.5 text-amber-500 animate-pulse" />
            <span className="font-mono font-medium text-neutral-300">
              R$ {profile?.balance !== undefined ? profile.balance.toFixed(2) : '0.00'}
            </span>
          </div>

          <div className="flex items-center gap-2.5 bg-[#141417]/40 border border-[#1c1c22] rounded-lg px-2.5 py-1.5">
            <div className="w-5 h-5 rounded-full bg-[#005ae6] flex items-center justify-center text-white font-extrabold text-[9px] uppercase">
              {(profile?.displayName || user?.displayName || user?.email || 'U').substring(0,2)}
            </div>
            
            <div className="text-[10px] leading-tight font-mono hidden lg:block">
              <span className="text-neutral-200 font-semibold max-w-[100px] truncate block">
                {profile?.displayName || user?.displayName || user?.email}
              </span>
              <span className="text-[#6B6B76] text-[9px] uppercase block leading-none mt-0.5">{profile?.role || 'viewer'}</span>
            </div>

            <button 
              onClick={handleLogout}
              className="text-[#6B6B76] hover:text-red-400 p-0.5 ml-1 transition-colors cursor-pointer"
              title="Encerrar Sessão"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Mobile navigation drawer toggle */}
          <button 
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)} 
            className="md:hidden p-1.5 bg-[#141417] border border-[#1c1c22] rounded-lg"
          >
            {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Mobile drop menu drawer */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="md:hidden absolute top-14 left-0 w-full bg-[#0E0E10] border-b border-[#1c1c22] z-30 p-4 font-mono text-sm space-y-3"
          >
            <button 
              onClick={() => handleNav('dashboard')}
              className={`flex items-center justify-between w-full text-left py-2 font-bold ${currentView === 'dashboard' ? 'text-[#3b82f6]' : 'text-neutral-400'}`}
            >
              <span>DASHBOARD EXPLORER</span>
              <ChevronRight className="w-4 h-4" />
            </button>

            <button 
              onClick={() => handleNav('transactions')}
              className={`flex items-center justify-between w-full text-left py-2 font-bold ${currentView === 'transactions' ? 'text-[#3b82f6]' : 'text-neutral-400'}`}
            >
              <span>MEU OPERACIONAL BRUTE</span>
              <ChevronRight className="w-4 h-4" />
            </button>

            {profile?.role === 'admin' && (
              <button 
                onClick={() => handleNav('admin')}
                className="flex items-center justify-between w-full text-left py-2 text-emerald-400 font-bold"
              >
                <span>GERENCIA ADMINISTRATIVA</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            )}

            <div className="pt-3 border-t border-[#1c1c22] flex justify-between items-center text-xs">
              <span className="text-neutral-500">Saldo Atual:</span>
              <span className="text-amber-500 font-bold font-mono">R$ {profile?.balance || '0.00'}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Primary visual content board */}
      <main className="flex-1 overflow-y-auto bg-[#070709] relative flex flex-col min-h-0">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentView}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {currentView === 'dashboard' && (
              <Dashboard 
                onJoinRoom={handleJoinOrCreateRoom} 
                onNavigateToTransactions={() => handleNav('transactions')}
                onNavigateToAdmin={() => handleNav('admin')}
              />
            )}

            {currentView === 'transactions' && (
              <TransactionsPage onExit={() => handleNav('dashboard')} />
            )}

            {currentView === 'admin' && (
              <AdminPanel onExit={() => handleNav('dashboard')} />
            )}
          </motion.div>
        </AnimatePresence>
      </main>

    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ApplicationShell />
      </ToastProvider>
    </AuthProvider>
  );
}
