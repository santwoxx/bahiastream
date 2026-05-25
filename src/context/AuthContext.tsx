import React, { createContext, useContext, useEffect, useState } from 'react';
import { 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  User as FirebaseUser,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile
} from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db, auth, googleProvider } from '../firebase/config';
import { handleFirestoreError, OperationType } from '../firebase/errorHandler';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: 'admin' | 'streamer' | 'viewer';
  balance: number;
  pixKey?: string;
  createdAt: any;
}

interface AuthContextProps {
  user: FirebaseUser | null;
  profile: UserProfile | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, pass: string) => Promise<void>;
  signUpWithEmail: (email: string, pass: string, name: string, pixKey?: string) => Promise<void>;
  logout: () => Promise<void>;
  changeRole: (newRole: 'streamer' | 'viewer') => Promise<void>;
}

const AuthContext = createContext<AuthContextProps | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsubscribeProfile: (() => void) | undefined;

    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);

      if (firebaseUser) {
        const userRef = doc(db, 'users', firebaseUser.uid);
        
        try {
          // Check if profile exists in Firestore
          const docSnap = await getDoc(userRef);
          
          if (!docSnap.exists()) {
            // New User Registration - Default role to 'viewer'
            // Keep email_verified checked if present
            const newProfile = {
              email: firebaseUser.email || '',
              displayName: firebaseUser.displayName || 'Novo Espectador',
              role: 'viewer' as const,
              balance: 0,
              pixKey: '',
              createdAt: serverTimestamp()
            };
            
            await setDoc(userRef, newProfile);
            console.log('[AuthContext] Registrado novo perfil no Firestore:', firebaseUser.uid);
          }
        } catch (error) {
          console.warn('[AuthContext] Erro de escrita inicial do perfil:', error);
          // Let client handle or log safely
        }

        // Attach Realtime Listener to user profile to sync balance or role updates instantly
        unsubscribeProfile = onSnapshot(userRef, (snapshot) => {
          if (snapshot.exists()) {
            const data = snapshot.data();
            setProfile({
              uid: firebaseUser.uid,
              email: data.email || firebaseUser.email || '',
              displayName: data.displayName || firebaseUser.displayName || 'Usuário',
              role: (data.role || 'viewer') as 'admin' | 'streamer' | 'viewer',
              balance: data.balance !== undefined ? Number(data.balance) : 0,
              pixKey: data.pixKey || '',
              createdAt: data.createdAt
            });
          }
          setLoading(false);
        }, (error) => {
          // Log according to standard guidelines
          try {
            handleFirestoreError(error, OperationType.GET, `users/${firebaseUser.uid}`);
          } catch (err) {
            console.error('[AuthContext] Conexão com Firestore rejeitada:', err);
          }
          setLoading(false);
        });

      } else {
        setProfile(null);
        setLoading(false);
      }
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeProfile) {
        unsubscribeProfile();
      }
    };
  }, []);

  /**
   * Safe login using popup strategy to avoid iframe blocking
   */
  const signInWithGoogle = async () => {
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error('[AuthContext] Erro no login Google Auth:', err);
      setLoading(false);
      throw err;
    }
  };

  /**
   * Complete Email/Password login workflow
   */
  const signInWithEmail = async (email: string, pass: string) => {
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, pass);
    } catch (err) {
      console.error('[AuthContext] Erro no login por E-mail:', err);
      setLoading(false);
      throw err;
    }
  };

  /**
   * Complete Email/Password signup workflow with Firestore profile registration
   */
  const signUpWithEmail = async (email: string, pass: string, name: string, pixKey?: string) => {
    setLoading(true);
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, pass);
      await updateProfile(userCredential.user, { displayName: name });
      
      const userRef = doc(db, 'users', userCredential.user.uid);
      const newProfile = {
        email: email,
        displayName: name,
        role: 'viewer' as const,
        balance: 0,
        pixKey: pixKey || '',
        createdAt: serverTimestamp()
      };
      await setDoc(userRef, newProfile);
    } catch (err) {
      console.error('[AuthContext] Erro no cadastro por E-mail:', err);
      setLoading(false);
      throw err;
    }
  };

  /**
   * Log out current user
   */
  const logout = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error('[AuthContext] Erro ao deslogar:', err);
    }
  };

  /**
   * Role Switcher Helper: Allows changing from viewer to streamer for testing flows
   */
  const changeRole = async (newRole: 'streamer' | 'viewer') => {
    if (!user) return;
    const userRef = doc(db, 'users', user.uid);
    try {
      await setDoc(userRef, { role: newRole }, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}`);
    }
  };

  return (
    <AuthContext.Provider value={{ user, profile, loading, signInWithGoogle, signInWithEmail, signUpWithEmail, logout, changeRole }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth deve ser utilizado dentro de um AuthProvider');
  }
  return context;
};
