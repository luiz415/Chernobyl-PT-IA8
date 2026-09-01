import React, { createContext, useContext, useState, useCallback } from "react";
import { collection, doc, query, where, deleteDoc } from "firebase/firestore";
import { db, setDoc } from "../firebase/config";
import { useAuth } from "./AuthContext";
import { sendDesktopNotification } from "../utils/desktopNotify";
import { playNotificationSound } from "../utils/notificationSound";
import { isNotificationTypeEnabled } from "../utils/notificationPreferences";

// ============================================================================
// NOTIFICATIONS CONTEXT — Centraliza sistema de notificações
// ============================================================================
// Este Context centraliza o listener de notificações e fornece métodos
// para marcar como lida, processar, etc.
// ============================================================================

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  status: "pending" | "done";
  read?: boolean;
  ignored?: boolean;
  createdAt: number;
  partyId?: string;
  partyName?: string;
  questType?: "soulwar" | "sanguine";
  scheduledTime?: number;
  addedBy?: string;
  paidBy?: string;
  paidAmount?: number;
  paidAmountFormatted?: string;
  changedBy?: string;
  userId?: string;
  targetRole?: string;
  action?: "install_update";
  actionLabel?: string;
  updateVersion?: string;
  participantCharIds?: string[];
  participantSlotData?: Record<string, { itemDropado: string; split: boolean; itemVendido: number }>;
  splitValue?: number;
  attCharsDone?: boolean;
  attCharsDoneAt?: number;
  vipDays?: number;
}

interface NotificationsContextType {
  notifications: Notification[];
  pendingCount: number;
  markAsDone: (id: string) => void;
  markAllAsDone: () => void;
  clearDone: () => void;
  addNotification: (notif: Omit<Notification, "id" | "createdAt" | "status"> & { id?: string; createdAt?: number }) => void;
  desktopEnabled: boolean;
  setDesktopEnabled: (v: boolean) => void;
}

const NotificationsContext = createContext<NotificationsContextType | null>(null);

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { currentUser } = useAuth();
  
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [desktopEnabled, setDesktopEnabled] = useState(() => {
    try {
      const raw = localStorage.getItem("tibia_notify_desktop");
      return raw !== null ? JSON.parse(raw) : true;
    } catch { return true; }
  });
  
  
  // ============================================================================
  // LISTENER: Notificações do usuário
  // ============================================================================
  // NOTA: O App.tsx já mantém um listener otimizado de notifications com lógica
  // complexa de processamento (useNotifications hook). Este Context NÃO cria
  // listener duplicado. As notificações são fornecidas via prop pelo App.tsx.
  // ============================================================================
  
  // ============================================================================
  // ACTIONS
  // ============================================================================
  
  const markAsDone = useCallback((id: string) => {
    setNotifications(prev => 
      prev.map(n => n.id === id ? { ...n, status: "done" as const } : n)
    );
    
    // Deletar do Firestore
    if (db) {
      deleteDoc(doc(db, "notifications", id)).catch(() => {});
    }
  }, []);
  
  const markAllAsDone = useCallback(() => {
    setNotifications(prev => prev.map(n => ({ ...n, status: "done" as const })));
    
    // Deletar todas do Firestore
    if (db && currentUser?.uid) {
      const q = query(
        collection(db, "notifications"),
        where("userId", "==", currentUser.uid)
      );
      
      import("firebase/firestore").then(({ getDocs }) => {
        getDocs(q).then(snap => {
          snap.docs.forEach(d => {
            deleteDoc(doc(db, "notifications", d.id)).catch(() => {});
          });
        });
      });
    }
  }, [currentUser]);
  
  const clearDone = useCallback(() => {
    setNotifications(prev => prev.filter(n => n.status !== "done"));
  }, []);
  
  const addNotification = useCallback((notif: Omit<Notification, "id" | "createdAt" | "status"> & { id?: string; createdAt?: number }) => {
    if (!db) return;
    // Mesmo portão de preferência usado em `useNotifications`: o usuário
    // desligou o tipo no modal "Configurar Notificações" => não entrega.
    // Tipos obrigatórios e desconhecidos sempre passam.
    if (!isNotificationTypeEnabled(notif.type)) return;
    
    const id = notif.id || Date.now().toString() + Math.random().toString(36).slice(2);
    const createdAt = notif.createdAt || Date.now();
    
    const newNotif: Notification = {
      ...notif,
      id,
      createdAt,
      status: "pending",
    };
    
    // Gravar no Firestore
    setDoc(doc(db, "notifications", id), newNotif).catch(() => {});
    
    playNotificationSound();

    // Notificação desktop — evita duplicidade: só envia se ainda não existe
    // pelo ID no estado atual, e usa destino apropriado (url/partyId/tipo)
    const alreadyExists = notifications.find(n => n.id === id);
    if (desktopEnabled && !alreadyExists) {
      sendDesktopNotification(
        newNotif.title,
        newNotif.body,
        () => {
          try {
            // 1) URL direta (Bazaar, Service, links externos)
            if ((newNotif as any).url && typeof (newNotif as any).url === "string") {
              const url = (newNotif as any).url as string;
              if (url.startsWith("/")) {
                // Navegação interna por rota — dispara eventos conhecidos
                if (url.includes("bazaar") || url.includes("bazaar")) {
                  window.dispatchEvent(new CustomEvent("auto-bazaar-run-request", { detail: { source: "notification-click", notificationId: newNotif.id } }));
                } else if (url.includes("service") || url.includes("serviceio") || url.includes("serviceiro")) {
                  window.dispatchEvent(new CustomEvent("navigate-to-service-request", { detail: { notificationId: newNotif.id } }));
                } else {
                  window.dispatchEvent(new CustomEvent("navigate-request", { detail: { url } }));
                }
                return;
              }
              // Link externo (Electron ou navegador)
              const electronRequire = (window as any).require;
              if (electronRequire) {
                try { electronRequire("electron").shell.openExternal(url); } catch {}
                return;
              }
              window.open(url, "_blank", "noopener,noreferrer");
              return;
            }
            // 2) Party / PT — navegação interna pelo partyId
            if (newNotif.partyId) {
              window.dispatchEvent(new CustomEvent("pt-navigate-request", { detail: { partyId: newNotif.partyId, notificationId: newNotif.id } }));
              return;
            }
            // 3) Tipos específicos com destino conhecido
            if (newNotif.type === "bazaar_daily_available" || newNotif.type === "bazaar_interest_ending") {
              window.dispatchEvent(new CustomEvent("auto-bazaar-run-request", { detail: { source: "notification-click", notificationId: newNotif.id } }));
              return;
            }
            if (newNotif.type === "service_request") {
              window.dispatchEvent(new CustomEvent("navigate-to-service-request", { detail: { notificationId: newNotif.id } }));
              return;
            }
            // Service "Qualquer um" do Formulário Público: leva o Boss à guia
            // Services (Lista de Espera) para triagem.
            if (newNotif.type === "service_waiting") {
              window.dispatchEvent(new CustomEvent("services-tab-navigate-request", { detail: { notificationId: newNotif.id } }));
              return;
            }
            // 4) Fallback — abrir painel de notificações (centro)
            window.dispatchEvent(new CustomEvent("open-notification-center"));
          } catch {}
        },
        createdAt,
      );
    }
  }, [desktopEnabled]);
  
  const pendingCount = notifications.filter(n => n.status === "pending").length;
  
  return (
    <NotificationsContext.Provider value={{
      notifications,
      pendingCount,
      markAsDone,
      markAllAsDone,
      clearDone,
      addNotification,
      desktopEnabled,
      setDesktopEnabled,
    }}>
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationsContext);
  if (!context) {
    throw new Error("useNotifications deve ser usado dentro de NotificationsProvider");
  }
  return context;
}