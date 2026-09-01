// ============================================================================
// PTs — núcleo PURO de lembretes de horário e atualização de drops.
// ============================================================================
//
// Os lembretes "PT em 30/15/5 minutos" eram gerados por um `setInterval` de
// 60s no hook useNotifications (frontend) e a notificação de "drops/valores
// salvos" era computada localmente pelo receptor a partir do listener de
// parties. Os dois dependiam do app aberto — com o app fechado, o usuário
// perdia o lembrete (e o push não existia).
//
// Migração para o backend (`ptWatch.ts`):
//   • Lembretes: CF agendada a cada minuto, janelas de 5 min (28-32/13-17/3-7)
//     — granularidade idêntica à do frontend, sem timer local;
//   • Drops: trigger onDocumentUpdated em `parties/{id}` detecta a mudança do
//     campo `dropsValuesSavedAt` no INSTANTE em que o salvamento acontece.
//
// Este arquivo é 100% puro (sem Firebase) — compilável e testável em Node.
// ============================================================================

/** Forma mínima de uma PT lida do Firestore (campos usados nas notificações). */
export interface PartyLike {
  id: string;
  name: string;
  ptType?: string;
  horarioTimestamp?: number;
  questConcluida?: boolean;
  questFalha?: boolean;
  archived?: boolean;
  ptStartedAt?: number;
  isPaused?: boolean;
  selectedIds?: string[];
  customMembers?: Array<{ label?: string }>;
  slotData?: Record<string, { owner?: string; player?: string }>;
  dropsValuesSaved?: boolean;
  dropsValuesSavedAt?: number;
  dropsValuesSavedBy?: string;
}

/** Personagem mínimo para resolução de dono. */
export interface CharLike {
  id: string;
  ownerUid?: string;
  ownerName?: string;
  personagem?: string;
}

/** Preferências de lembrete do usuário (espelho do localStorage no Firestore). */
export interface PtReminderPrefs {
  reminder30?: boolean;
  reminder15?: boolean;
  reminder5?: boolean;
  /** Preferência de "drops/valores atualizados" (usada pelo trigger de PT). */
  ptUpdatedEnabled?: boolean;
  /** Tipo desligado no modal "Configurar Notificações" → sem lembrete. */
  enabled?: boolean;
}

export interface PtReminderPlan {
  notificationId: string;
  markerId: string;
  userId: string;
  type: "pt_reminder";
  title: string;
  body: string;
  partyId: string;
  partyName: string;
  questType: "soulwar" | "sanguine";
  scheduledTime: number;
  createdAt: number;
  status: "pending";
}

export interface PtUpdatedPlan {
  notificationId: string;
  markerId: string;
  userId: string;
  type: "pt_updated";
  title: string;
  body: string;
  partyId: string;
  partyName: string;
  questType: "soulwar" | "sanguine";
  createdAt: number;
  status: "pending";
}

export const PT_REMINDER_WINDOWS = [
  { label: "30", min: 28, max: 32 },
  { label: "15", min: 13, max: 17 },
  { label: "5", min: 3, max: 7 },
] as const;

/**
 * Resolve os UIDs dos membros de uma PT — o mesmo critério do
 * `isUserInParty` do frontend:
 *   • personagens selecionados (selectedIds → ownerUid);
 *   • membros customizados cujo rótulo contém o nome do usuário;
 *   • slots com owner/player = nome do usuário.
 * `usersByName` mapeia nome normalizado (minúsculas, sem espaços extras) → uid.
 */
export function resolvePartyMemberUids(input: {
  party: PartyLike;
  charsById: Record<string, CharLike>;
  usersByName: Record<string, string>;
}): Set<string> {
  const uids = new Set<string>();
  const party = input.party || ({} as PartyLike);

  (Array.isArray(party.selectedIds) ? party.selectedIds : []).forEach(charId => {
    const char = input.charsById[String(charId)];
    const ownerUid = String(char?.ownerUid || "").trim();
    if (ownerUid) uids.add(ownerUid);
  });

  const names = new Set<string>();
  (Array.isArray(party.customMembers) ? party.customMembers : []).forEach(member => {
    const label = String(member?.label || "").trim().toLowerCase();
    if (label) names.add(label);
  });
  Object.values(party.slotData || {}).forEach(slot => {
    const owner = String(slot?.owner || "").trim().toLowerCase();
    const player = String(slot?.player || "").trim().toLowerCase();
    if (owner) names.add(owner);
    if (player) names.add(player);
  });

  names.forEach(name => {
    // O rótulo do membro custom pode conter o nome ("Fulano (amigo)") —
    // mesma semântica do frontend (`label.includes(userName)`).
    Object.entries(input.usersByName).forEach(([candidateName, uid]) => {
      if (name.includes(candidateName)) uids.add(uid);
    });
  });

  return uids;
}

function reminderWindowEnabled(prefs: PtReminderPrefs, label: string): boolean {
  if (label === "30") return prefs.reminder30 !== false;
  if (label === "15") return prefs.reminder15 !== false;
  if (label === "5") return prefs.reminder5 !== false;
  return true;
}

/**
 * Planeja os lembretes de horário para o instante `nowMs`.
 *
 * Janelas de 5 minutos (28-32/13-17/3-7 antes do horário) — idênticas ao
 * frontend, garantindo captura mesmo com execução a cada 1 minuto. O
 * horário e o uid entram no id do marcador: PT reagendada = novo evento = novo
 * lembrete (correto). Idempotente por marcador.
 */
export function planPtReminders(input: {
  nowMs: number;
  parties: PartyLike[];
  memberUidsByParty: Record<string, Set<string>>;
  prefsByUid: Record<string, PtReminderPrefs>;
  existingMarkerIds: Set<string>;
}): PtReminderPlan[] {
  const plans: PtReminderPlan[] = [];
  const seen = new Set<string>();

  input.parties.forEach(party => {
    const partyId = String(party?.id || "").trim();
    const scheduledTime = Number(party?.horarioTimestamp);
    if (!partyId || !Number.isFinite(scheduledTime) || scheduledTime <= 0) return;
    if (party.questConcluida || party.archived || party.questFalha) return;
    // PT iniciada (e não pausada) não precisa mais de lembrete.
    if (party.ptStartedAt && !party.isPaused) return;

    const members = input.memberUidsByParty[partyId];
    if (!members || members.size === 0) return;

    const diffMin = Math.round((scheduledTime - input.nowMs) / 60000);
    const questType: "soulwar" | "sanguine" = party.ptType === "sanguine" ? "sanguine" : "soulwar";
    const sigla = questType === "sanguine" ? "SG" : "SW";

    PT_REMINDER_WINDOWS.forEach(({ label, min, max }) => {
      if (diffMin < min || diffMin > max) return;

      members.forEach(uid => {
        const prefs = input.prefsByUid[uid] || {};
        if (prefs.enabled === false) return;
        if (!reminderWindowEnabled(prefs, label)) return;

        // Id por usuário — cada membro tem seu próprio marcador/doc (mesma
        // forma de pt_updated_{partyId}_{savedAt}_{uid}). Sem o uid, o `seen`
        // abaixo e o id do doc `notifications` colidiriam entre membros.
        const markerId = `pt_reminder_${label}_${partyId}_${scheduledTime}_${uid}`;
        if (input.existingMarkerIds.has(markerId)) return;
        if (seen.has(markerId)) return;
        seen.add(markerId);

        plans.push({
          notificationId: markerId,
          markerId,
          userId: uid,
          type: "pt_reminder",
          title: `PT em ${label} minutos!`,
          body: `A PT "${party.name}" para ${sigla} começa em ${label} minutos.`,
          partyId,
          partyName: party.name,
          questType,
          scheduledTime,
          createdAt: input.nowMs,
          status: "pending",
        });
      });
    });
  });

  return plans;
}

/**
 * Planeja as notificações de "drops e valores atualizados" a partir da
 * mudança REAL do campo `dropsValuesSavedAt` (trigger de update na PT).
 * O autor do salvamento NÃO é notificado (`saverUid`, resolvido de
 * `dropsValuesSavedBy` via usersByName — mesma regra do frontend).
 */
export function planPtUpdatedNotifications(input: {
  nowMs: number;
  before: PartyLike;
  after: PartyLike;
  memberUids: Set<string>;
  saverUid?: string;
}): PtUpdatedPlan[] {
  const beforeSavedAt = Number(input.before?.dropsValuesSavedAt || 0);
  const afterSavedAt = Number(input.after?.dropsValuesSavedAt || 0);
  const changed = afterSavedAt > 0 && afterSavedAt !== beforeSavedAt;
  if (!changed) return [];

  const party = input.after;
  const partyId = String(party.id || "").trim();
  if (!partyId) return [];

  const saverName = String(party.dropsValuesSavedBy || "Um membro").trim() || "Um membro";
  const questType: "soulwar" | "sanguine" = party.ptType === "sanguine" ? "sanguine" : "soulwar";
  const sigla = questType === "sanguine" ? "SG" : "SW";

  const plans: PtUpdatedPlan[] = [];
  input.memberUids.forEach(uid => {
    // O próprio autor do salvamento não é notificado.
    if (input.saverUid && uid === input.saverUid) return;
    const markerId = `pt_updated_${partyId}_${afterSavedAt}_${uid}`;
    plans.push({
      notificationId: markerId,
      markerId,
      userId: uid,
      type: "pt_updated",
      title: "🔄 Itens e Valores Atualizados!",
      body: `${saverName} salvou os drops e valores da PT "${party.name}" (${sigla}).`,
      partyId,
      partyName: party.name,
      questType,
      createdAt: input.nowMs,
      status: "pending",
    });
  });
  return plans;
}