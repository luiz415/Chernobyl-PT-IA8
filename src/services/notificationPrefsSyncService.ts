import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../firebase/config";
import {
  NOTIFICATION_PREFERENCES,
  isNotificationTypeEnabled,
} from "../utils/notificationPreferences";
import { readBazarNotifyMinutes, readBazarTimezoneOffsetMinutes } from "../utils/bazaarTime";

// ============================================================================
// SINCRONIZAÇÃO DE PREFERÊNCIAS → FIRESTORE (`userNotificationPrefs/{uid}`)
// ============================================================================
//
// As preferências de notificação vivem no localStorage do DISPOSITIVO. O
// backend (watchers de Bazaar/PT e o trigger de push) também precisa delas —
// para respeitar o que o usuário ligou/desligou e para conhecer a antecedência
// dos leilões e o fuso — sem nunca depender do app estar aberto.
//
// Este serviço espelha as preferências no Firestore sempre que:
//   • o usuário faz login (backfill — cobre quem nunca abriu as configurações);
//   • o usuário altera algo relevante (modal Configurar Notificações,
//     antecedência do Bazaar).
//
// Estrutura do documento:
//   {
//     typeEnabled: { "<tipo>": boolean, … },   // TODOS os tipos do modal
//     bazaarNotifyMinutes: 3,                  // antecedência (1-60)
//     bazaarTimezoneOffsetMinutes: -180,       // fuso do Bazaar
//     ptReminder30/15/5: boolean,              // janelas do lembrete de PT
//     updatedAt
//   }
//
// Regra de ouro: sincronizar é ACESSÓRIO — qualquer falha é silenciosa e o
// app continua funcionando apenas com as preferências locais.
// ============================================================================

const PREFS_COLLECTION = "userNotificationPrefs";

export interface CloudNotificationPrefs {
  typeEnabled: Record<string, boolean>;
  bazaarNotifyMinutes: number;
  bazaarTimezoneOffsetMinutes: number;
  ptReminder30: boolean;
  ptReminder15: boolean;
  ptReminder5: boolean;
}

function readLegacyToggle(storageKey: string): boolean {
  try {
    return localStorage.getItem(storageKey) !== "false";
  } catch {
    return true;
  }
}

/** Lê as preferências ATUAIS deste dispositivo (fonte: localStorage). */
export function readLocalNotificationPrefs(): CloudNotificationPrefs {
  const typeEnabled: Record<string, boolean> = {};
  NOTIFICATION_PREFERENCES.forEach(item => {
    typeEnabled[item.id] = isNotificationTypeEnabled(item.id);
  });
  return {
    typeEnabled,
    bazaarNotifyMinutes: readBazarNotifyMinutes(),
    bazaarTimezoneOffsetMinutes: readBazarTimezoneOffsetMinutes(),
    ptReminder30: readLegacyToggle("notif_pt_30"),
    ptReminder15: readLegacyToggle("notif_pt_15"),
    ptReminder5: readLegacyToggle("notif_pt_5"),
  };
}

/**
 * Espelha as preferências locais no Firestore. Idempotente e silencioso.
 */
export async function syncNotificationPrefsToCloud(uid: string): Promise<void> {
  const targetUid = String(uid || "").trim();
  if (!targetUid || !db) return;
  try {
    const prefs = readLocalNotificationPrefs();
    await setDoc(doc(db, PREFS_COLLECTION, targetUid), {
      ...prefs,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch {
    // Acesso negado/offline: as preferências continuam valendo localmente.
  }
}