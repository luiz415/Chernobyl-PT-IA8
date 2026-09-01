import React, { createContext, useContext, useState, useEffect } from "react";
import { collection, doc, query, where, onSnapshot } from "firebase/firestore";
import { db } from "../firebase/config";
import { useAuth } from "./AuthContext";
import type { VipCreditRequest } from "../types";
import type { Donation } from "../types/donations";

// ============================================================================
// BOSS DATA CONTEXT — Exclusivo para funcionalidades administrativas do Boss
// ============================================================================
// Este Context só é montado quando o BossAdminPanel está aberto.
// Centraliza dados administrativos (donations, vipRequests, userLogs, etc.).
// ============================================================================

interface BossDataContextType {
  donations: Donation[];
  vipRequests: VipCreditRequest[];
  userLogs: Array<{
    uid: string;
    updatedAt: string;
    stats: {
      totalReads: number;
      totalWrites: number;
      totalDeletes: number;
      byCollection: Record<string, { reads: number; writes: number; deletes: number }>;
    };
  }>;
  allUserStats: Record<string, { totalRcDoadoAprovado: number; totalPtsConcluidas: number }>;
  bossNotifications: Array<{
    id: string;
    title: string;
    body: string;
    createdAt: number;
    ignored?: boolean;
    ignoredAt?: number;
    ignoredBy?: string;
    type?: string;
  }>;
  donationChar: string;
}

const BossDataContext = createContext<BossDataContextType | null>(null);

export function BossDataProvider({ children }: { children: React.ReactNode }) {
  const { currentUser, userProfile } = useAuth();
  
  // Estado dos dados
  const [donations, setDonations] = useState<Donation[]>([]);
  const [vipRequests, setVipRequests] = useState<VipCreditRequest[]>([]);
  const [userLogs, setUserLogs] = useState<any[]>([]);
  const [allUserStats, setAllUserStats] = useState<Record<string, any>>({});
  const [bossNotifications, setBossNotifications] = useState<any[]>([]);
  const [donationChar, setDonationChar] = useState("A definir pelo administrador");
  
  // ============================================================================
  // LISTENERS — Apenas enquanto o BossAdminPanel está aberto
  // ============================================================================
  
  useEffect(() => {
    if (!currentUser || userProfile?.role !== "Boss" || !db) return;
    
    const unsubs: Array<() => void> = [];
    
    // 1. Donations
    const donationsUnsub = onSnapshot(collection(db, "donations"), (snap) => {
      const list: Donation[] = snap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          userId: data.userId || "",
          userName: data.userName || "Anônimo",
          userEmail: data.userEmail || "",
          amount: data.amount || 0,
          fromCharacter: data.fromCharacter || "",
          toCharacter: data.toCharacter || "",
          donationDate: data.donationDate || "",
          createdAt: data.createdAt || new Date().toISOString(),
          status: data.status || "pendente",
          approvedBy: data.approvedBy,
          approvedByName: data.approvedByName,
          approvedAt: data.approvedAt
        } as Donation;
      });
      setDonations(list);
    }, () => {});
    unsubs.push(donationsUnsub);
    
    // 2. VIP Requests
    const vipUnsub = onSnapshot(collection(db, "vipCreditRequests"), (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as VipCreditRequest));
      list.sort((a, b) => (b.clientCreatedAt || 0) - (a.clientCreatedAt || 0));
      setVipRequests(list);
    }, () => {});
    unsubs.push(vipUnsub);
    
    // 3. User Logs
    const logsUnsub = onSnapshot(collection(db, "user_logs"), (snap) => {
      const list = snap.docs.map(d => {
        const data = d.data();
        return {
          uid: d.id,
          updatedAt: data.updatedAt || "",
          stats: {
            totalReads: data.stats?.totalReads || 0,
            totalWrites: data.stats?.totalWrites || 0,
            totalDeletes: data.stats?.totalDeletes || 0,
            byCollection: (data.stats?.byCollection || {}) as Record<string, { reads: number; writes: number; deletes: number }>,
          },
        };
      });
      setUserLogs(list);
    }, () => {});
    unsubs.push(logsUnsub);
    
    // 4. All User Stats
    const statsUnsub = onSnapshot(collection(db, "userStats"), (snap) => {
      const map: Record<string, any> = {};
      snap.docs.forEach(d => {
        const data = d.data();
        map[d.id] = {
          totalRcDoadoAprovado: typeof data.totalRcDoadoAprovado === "number" ? data.totalRcDoadoAprovado : 0,
          totalPtsConcluidas: typeof data.totalPtsConcluidas === "number" ? data.totalPtsConcluidas : 0,
        };
      });
      setAllUserStats(map);
    }, () => {});
    unsubs.push(statsUnsub);
    
    // 5. Boss Notifications
    const notifQ = query(
      collection(db, "notifications"),
      where("targetRole", "==", "Boss")
    );
    const notifUnsub = onSnapshot(notifQ, (snap) => {
      const list = snap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          title: data.title || "",
          body: data.body || "",
          createdAt: data.createdAt || Date.now(),
          ignored: data.ignored === true,
          ignoredAt: data.ignoredAt,
          ignoredBy: data.ignoredBy,
          type: data.type || "request_entry"
        };
      }).sort((a, b) => b.createdAt - a.createdAt);
      setBossNotifications(list);
    }, () => {});
    unsubs.push(notifUnsub);
    
    // 6. Donation Settings
    const settingsUnsub = onSnapshot(doc(db, "settings", "donation_settings"), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setDonationChar(data.donationCharacter || data.characterName || "A definir pelo administrador");
      }
    }, () => {});
    unsubs.push(settingsUnsub);
    
    return () => {
      unsubs.forEach(unsub => unsub());
    };
  }, [currentUser, userProfile?.role]);
  
  return (
    <BossDataContext.Provider value={{
      donations,
      vipRequests,
      userLogs,
      allUserStats,
      bossNotifications,
      donationChar,
    }}>
      {children}
    </BossDataContext.Provider>
  );
}

export function useBossData() {
  const context = useContext(BossDataContext);
  if (!context) {
    throw new Error("useBossData deve ser usado dentro de BossDataProvider");
  }
  return context;
}