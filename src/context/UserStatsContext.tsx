import React, { createContext, useContext, useState } from "react";
import { collection, query, where, orderBy, limit as fireLimit, startAfter, getDocs, getCountFromServer, type DocumentData, type QueryDocumentSnapshot } from "firebase/firestore";
import { db } from "../firebase/config";
import { useAuth } from "./AuthContext";

// ============================================================================
// USER STATS CONTEXT — Centraliza estatísticas do usuário
// ============================================================================
// Este Context centraliza as estatísticas do usuário atual e do ranking global.
// Elimina duplicações e fornece cache em memória.
// ============================================================================

interface UserStatsData {
  totalPtsConcluidas?: number;
  totalPtsSoulwar?: number;
  totalPtsSanguine?: number;
  totalMortes?: number;
  totalDuracaoMs?: number;
  totalParticipacoes?: number;
  servers?: Record<string, number>;
  partners?: Record<string, number>;
  ptsSemMorte?: number;
  ptsComMorte?: number;
  sequenciaAtualSemMorte?: number;
  maxSequenciaSemMorte?: number;
  ultimaAtualizacao?: any;
  totalRcDoado?: number;
  totalRcDoadoAprovado?: number;
  services?: number;
  rankingScore?: number;
}

interface RankingEntry {
  uid: string;
  nome: string;
  score: number;
  concluidas: number;
  totalParticipacoes: number;
  totalMortes: number;
  totalDuracaoMs: number;
  totalPtsSoulwar: number;
  totalPtsSanguine: number;
  ptsSemMorte: number;
  ptsComMorte: number;
  sequenciaAtualSemMorte: number;
  maxSequenciaSemMorte: number;
  servers: Record<string, number>;
  partners: Record<string, number>;
  ultimaAtualizacao?: any;
  totalRcDoadoAprovado: number;
  services: number;
}

interface UserStatsContextType {
  // Stats do usuário atual
  userStats: UserStatsData | null;
  
  // Ranking
  rankingEntries: RankingEntry[];
  rankingLoading: boolean;
  rankingHasMore: boolean;
  loadMoreRanking: () => Promise<void>;
  refreshRanking: () => Promise<void>;
  getUserPosition: () => Promise<number | null>;
}

const UserStatsContext = createContext<UserStatsContextType | null>(null);

const PAGE_SIZE = 20;

export function UserStatsProvider({ children }: { children: React.ReactNode }) {
  const { currentUser, allUsers } = useAuth();
  
  // Stats do usuário atual
  const [userStats] = useState<UserStatsData | null>(null);
  
  // Ranking
  const [rankingEntries, setRankingEntries] = useState<RankingEntry[]>([]);
  const [rankingLoading, setRankingLoading] = useState(false);
  const [rankingHasMore, setRankingHasMore] = useState(false);
  const lastDocRef = React.useRef<QueryDocumentSnapshot<DocumentData, DocumentData> | null>(null);
  
  // ============================================================================
  // LISTENER: UserStats do usuário atual
  // ============================================================================
  // NOTA: O App.tsx já mantém um listener de userStats/{uid} com lógica
  // específica. Este Context NÃO cria listener duplicado. As estatísticas são
  // fornecidas via prop pelo App.tsx.
  // ============================================================================
  
  // ============================================================================
  // RANKING (Lazy Loading)
  // ============================================================================
  
  const parseRankingDoc = (docSnap: QueryDocumentSnapshot<DocumentData, DocumentData>): RankingEntry | null => {
    const data = docSnap.data();
    if (typeof data.rankingScore !== "number") return null;
    
    const user = allUsers.find(u => u.uid === docSnap.id);
    
    return {
      uid: docSnap.id,
      nome: user?.nome || data._nome || `Jogador ${docSnap.id.slice(0, 6)}`,
      score: data.rankingScore || 0,
      concluidas: typeof data.totalPtsConcluidas === "number" ? data.totalPtsConcluidas : 0,
      totalParticipacoes: typeof data.totalParticipacoes === "number" ? data.totalParticipacoes : (data.totalPtsConcluidas || 0),
      totalMortes: typeof data.totalMortes === "number" ? data.totalMortes : 0,
      totalDuracaoMs: typeof data.totalDuracaoMs === "number" ? data.totalDuracaoMs : 0,
      totalPtsSoulwar: typeof data.totalPtsSoulwar === "number" ? data.totalPtsSoulwar : 0,
      totalPtsSanguine: typeof data.totalPtsSanguine === "number" ? data.totalPtsSanguine : 0,
      ptsSemMorte: typeof data.ptsSemMorte === "number" ? data.ptsSemMorte : 0,
      ptsComMorte: typeof data.ptsComMorte === "number" ? data.ptsComMorte : 0,
      sequenciaAtualSemMorte: typeof data.sequenciaAtualSemMorte === "number" ? data.sequenciaAtualSemMorte : 0,
      maxSequenciaSemMorte: typeof data.maxSequenciaSemMorte === "number" ? data.maxSequenciaSemMorte : 0,
      servers: (data.servers && typeof data.servers === "object") ? data.servers as Record<string, number> : {},
      partners: (data.partners && typeof data.partners === "object") ? data.partners as Record<string, number> : {},
      ultimaAtualizacao: data.ultimaAtualizacao,
      totalRcDoadoAprovado: typeof data.totalRcDoadoAprovado === "number" ? data.totalRcDoadoAprovado : 0,
      services: typeof data.services === "number" ? data.services : 0,
    };
  };
  
  const loadInitialRanking = async () => {
    if (!db || rankingLoading) return;
    
    setRankingLoading(true);
    try {
      const q = query(
        collection(db, "userStats"),
        orderBy("rankingScore", "desc"),
        fireLimit(PAGE_SIZE)
      );
      const snap = await getDocs(q);
      const entries: RankingEntry[] = [];
      
      snap.forEach(docSnap => {
        const parsed = parseRankingDoc(docSnap);
        if (parsed) entries.push(parsed);
      });
      
      setRankingEntries(entries);
      lastDocRef.current = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
      setRankingHasMore(snap.docs.length === PAGE_SIZE);
    } catch (err) {
      console.error("Erro ao carregar ranking:", err);
    } finally {
      setRankingLoading(false);
    }
  };
  
  const loadMoreRanking = async () => {
    if (!rankingHasMore || !lastDocRef.current || rankingLoading || !db) return;
    
    setRankingLoading(true);
    try {
      const qNext = query(
        collection(db, "userStats"),
        orderBy("rankingScore", "desc"),
        startAfter(lastDocRef.current),
        fireLimit(PAGE_SIZE)
      );
      const snap = await getDocs(qNext);
      const nextEntries: RankingEntry[] = [];
      
      snap.forEach(docSnap => {
        const parsed = parseRankingDoc(docSnap);
        if (parsed) nextEntries.push(parsed);
      });
      
      setRankingEntries(prev => {
        const map = new Map<string, RankingEntry>();
        prev.forEach(e => map.set(e.uid, e));
        nextEntries.forEach(e => map.set(e.uid, e));
        return Array.from(map.values()).sort((a, b) => b.score - a.score);
      });
      
      lastDocRef.current = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : lastDocRef.current;
      setRankingHasMore(snap.docs.length === PAGE_SIZE);
    } catch (err) {
      console.error("Erro ao carregar mais ranking:", err);
    } finally {
      setRankingLoading(false);
    }
  };
  
  const refreshRanking = async () => {
    setRankingEntries([]);
    lastDocRef.current = null;
    setRankingHasMore(false);
    await loadInitialRanking();
  };
  
  const getUserPosition = async (): Promise<number | null> => {
    if (!currentUser || !userStats || typeof userStats.rankingScore !== "number" || !db) return null;
    
    try {
      const myScore = userStats.rankingScore;
      const countSnap = await getCountFromServer(
        query(collection(db, "userStats"), where("rankingScore", ">", myScore))
      );
      return countSnap.data().count + 1;
    } catch (err) {
      console.error("Erro ao buscar posição do usuário:", err);
      return null;
    }
  };
  
  return (
    <UserStatsContext.Provider value={{
      userStats,
      rankingEntries,
      rankingLoading,
      rankingHasMore,
      loadMoreRanking,
      refreshRanking,
      getUserPosition,
    }}>
      {children}
    </UserStatsContext.Provider>
  );
}

export function useUserStats() {
  const context = useContext(UserStatsContext);
  if (!context) {
    throw new Error("useUserStats deve ser usado dentro de UserStatsProvider");
  }
  return context;
}