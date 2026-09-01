// ============================================================================
// Hook compartilhado: lista de usuários elegíveis a serem "Serviceiros"
// ============================================================================
// Retorna os usuários APROVADOS com role VIP ou Boss, ordenados por nome.
// Usado nos modais "Adicionar Service" (WaitingListPanel) e "Solicitar Service"
// (PublicServiceForm) para popular o campo SERVICEIRO com uma lista fixa.
//
// A constante ANY_SERVICEIRO_LABEL define o rótulo padrão da opção "Qualquer
// um", que deve estar sempre presente no dropdown junto com os usuários
// elegíveis, evitando duplicação da string.
// ============================================================================
import { useEffect, useState } from "react";
import { db, isSimulationMode, onSnapshot } from "../firebase/config";
import { collection, query, where } from "firebase/firestore";
import { getEffectiveUserRole } from "../utils/vipAccess";

export const ANY_SERVICEIRO_LABEL = "Qualquer um";

export interface EligibleServiceiro {
  uid: string;
  nome: string;
  role: "VIP" | "Boss";
  vipDays?: number;
  vipExpiresAt?: number | { toMillis?: () => number; seconds?: number } | null;
  serviceiro?: boolean;
}

// Retorna a lista de usuários aprovados com VIP efetivo e permissão Serviceiro. A ordenação é alfabética
// (case-insensitive, pt-BR) para manter o dropdown estável.
export function useEligibleServiceiros(): EligibleServiceiro[] {
  const [sourceUsers, setSourceUsers] = useState<EligibleServiceiro[]>([]);
  const [vipClock, setVipClock] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setVipClock(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    // MODO SIMULAÇÃO: lê os usuários mockados do localStorage
    if (isSimulationMode || !db) {
      try {
        const raw = localStorage.getItem("tibia_sim_users");
        const parsed: any[] = raw ? JSON.parse(raw) : [];
        const list: EligibleServiceiro[] = parsed
          .filter((u: any) => u?.status === "aprovado")
          .map((u: any) => ({ uid: u.uid, nome: u.nome || "Anônimo", role: u.role, vipDays: u.vipDays, vipExpiresAt: u.vipExpiresAt, serviceiro: u.serviceiro === true }));
        list.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));
        setSourceUsers(list);
      } catch {
        setSourceUsers([]);
      }
      return;
    }

    // MODO PRODUÇÃO: escuta a coleção `users` no Firestore filtrando aprovados.
    // O filtro por role é feito no cliente (evita índice composto no Firestore).
    try {
      const q = query(collection(db, "users"), where("status", "==", "aprovado"));
      const unsub = onSnapshot(
        q,
        (snap) => {
          const list: EligibleServiceiro[] = [];
          snap.forEach((docSnap) => {
            const d = docSnap.data() as any;
            list.push({ uid: docSnap.id, nome: d.nome || "Anônimo", role: d.role, vipDays: d.vipDays, vipExpiresAt: d.vipExpiresAt, serviceiro: d.serviceiro === true });
          });
          list.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));
          setSourceUsers(list);
        },
        () => setSourceUsers([])
      );
      return () => unsub();
    } catch {
      setSourceUsers([]);
    }
  }, []);

  const eligible: EligibleServiceiro[] = [];
  sourceUsers.forEach(user => {
    const role = getEffectiveUserRole(user, vipClock);
    if (role === "Boss" || (role === "VIP" && user.serviceiro === true)) {
      eligible.push({ ...user, role });
    }
  });
  return eligible.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));
}