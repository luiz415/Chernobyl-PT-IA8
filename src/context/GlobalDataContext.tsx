import React, { createContext, useContext, useState, useCallback } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../firebase/config";
import type { PartyTab, Character, WaitingService } from "../types";

// ============================================================================
// GLOBAL DATA CONTEXT — Centraliza listeners globais do Firestore
// ============================================================================
// Este Context centraliza os principais listeners do sistema, eliminando
// duplicações e reduzindo consumo do Firestore.
// ============================================================================

interface GlobalDataContextType {
  // Users (lista completa)
  allUsers: any[];
  
  // Parties
  parties: PartyTab[];
  
  // Shared Characters
  sharedCharacters: Character[];
  
  // Notifications
  notifications: any[];
  
  // App Settings
  appSettings: {
    minimumAverageDonation: number;
    firestoreLoggerPaused: boolean;
  };
  vipPlans: {
    plan30PriceRC: number;
    plan90PriceRC: number;
  } | null;
  
  // Presence
  presenceMap: Record<string, any>;
  
  // Waiting List (lazy)
  waitingList: WaitingService[] | null;
  
  // Loading states
  isLoadingWaitingList: boolean;
  
  // Lazy loaders
  loadWaitingList: () => Promise<void>;
}

const GlobalDataContext = createContext<GlobalDataContextType | null>(null);

export function GlobalDataProvider({ children }: { children: React.ReactNode }) {
  // Users
  const [allUsers] = useState<any[]>([]);
  
  // Parties
  const [parties] = useState<PartyTab[]>([]);
  
  // Shared Characters
  const [sharedCharacters] = useState<Character[]>([]);
  
  // Notifications
  const [notifications] = useState<any[]>([]);
  
  // App Settings
  const [appSettings] = useState({
    minimumAverageDonation: 10,
    firestoreLoggerPaused: false
  });
  const [vipPlans] = useState<{ plan30PriceRC: number; plan90PriceRC: number } | null>(null);
  
  // Presence
  const [presenceMap] = useState<Record<string, any>>({});
  
  // Waiting List (lazy)
  const [waitingList, setWaitingList] = useState<WaitingService[] | null>(null);
  const [isLoadingWaitingList, setIsLoadingWaitingList] = useState(false);
  
  // ============================================================================
  // SEM LISTENERS ATIVOS
  // ============================================================================
  // Este Context permanece disponível para uma refatoração futura, mas não deve
  // consumir Firestore enquanto seus dados não forem utilizados pela aplicação.
  // A fonte única atual de usuários é o AuthContext; manter outro listener em
  // users aqui duplicava leituras sem benefício funcional.
  // ============================================================================
  
  // ============================================================================
  // LAZY LOADERS
  // ============================================================================
  
  const loadWaitingList = useCallback(async () => {
    if (waitingList !== null || isLoadingWaitingList || !db) return;
    
    setIsLoadingWaitingList(true);
    try {
      const snap = await getDocs(collection(db, "waitingList"));
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as WaitingService));
      setWaitingList(list);
    } catch (err) {
      console.error("Erro ao carregar waitingList:", err);
    } finally {
      setIsLoadingWaitingList(false);
    }
  }, [waitingList, isLoadingWaitingList]);
  
  // ============================================================================
  // PROVIDER
  // ============================================================================
  
  return (
    <GlobalDataContext.Provider value={{
      allUsers,
      parties,
      sharedCharacters,
      notifications,
      appSettings,
      vipPlans,
      presenceMap,
      waitingList,
      isLoadingWaitingList,
      loadWaitingList,
    }}>
      {children}
    </GlobalDataContext.Provider>
  );
}

export function useGlobalData() {
  const context = useContext(GlobalDataContext);
  if (!context) {
    throw new Error("useGlobalData deve ser usado dentro de GlobalDataProvider");
  }
  return context;
}