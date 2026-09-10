import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";

/**
 * CANCELAMENTO AUTOMÁTICO DE PRÉ-VENDAS AO REMOVER O PERSONAGEM DA PT.
 *
 * Regra de negócio: uma pré-venda (`characterAcquisitions` com status
 * `pre_approved`) nasce vinculada a uma PT e a um JOGADOR daquela PT. Se o
 * personagem for removido da PT antes de o comprador confirmar a compra, a
 * pré-venda perde o contexto e deve ser cancelada/resetada por completo —
 * sem resíduos que permitam ao comprador aceitar uma negociação cancelada.
 *
 * Por que uma Cloud Function:
 * As Security Rules só permitem o DELETE do documento de pré-venda ao DONO
 * original (ou Boss). Porém, ANTES da Quest qualquer participante da PT pode
 * remover personagens — inclusive um personagem que não é dele. Nesse caso o
 * cliente do removedor não tem permissão para cancelar a pré-venda de
 * terceiro. O Admin SDK cancela aqui de forma centralizada, idempotente e
 * independente de quem removeu ou de o navegador continuar aberto.
 *
 * Segurança e idempotência:
 *   • dispara em qualquer update de `parties/{partyId}`, mas retorna
 *     imediatamente se nenhum id saiu de `selectedIds` (custo mínimo);
 *   • o alvo é o ID determinístico `acq_{ownerUid}_{characterId}` — mesma
 *     derivação de `getCharacterAcquisitionId` no cliente;
 *   • DELETE somente se o documento ainda está `pre_approved` E pertence a
 *     ESTA PT (`partyId`): compra confirmada (`payment_confirmed` em diante)
 *     e negociações de outras PTs são intocáveis;
 *   • transação: se o comprador confirmar em paralelo, o status muda e o
 *     cancelamento é abortado — nunca desfaz uma compra confirmada;
 *   • reexecuções (retry) encontram o documento já apagado e não fazem nada.
 */
if (getApps().length === 0) {
  initializeApp();
}

const firestore = getFirestore();
const ACQUISITIONS_COLLECTION = "characterAcquisitions";

/** Mesma sanitização de `getCharacterAcquisitionId` no cliente (ordem exata). */
function sanitizeIdSegment(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max).replace(/[^a-zA-Z0-9_-]/g, "_");
}

export const cleanupRemovedSlotPreApprovals = onDocumentUpdated(
  {
    document: "parties/{partyId}",
    retry: true,
  },
  async event => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};

    const beforeIds: string[] = Array.isArray(before.selectedIds)
      ? before.selectedIds.map(value => String(value ?? "").trim())
      : [];
    const afterIds = new Set<string>(
      (Array.isArray(after.selectedIds) ? after.selectedIds : []).map((value: unknown) => String(value ?? "").trim()),
    );
    const removedIds = beforeIds.filter(id => id !== "" && !afterIds.has(id));
    if (removedIds.length === 0) return;

    const partyId = String(event.params.partyId || "").trim();
    if (!partyId) return;

    const beforeSlotData = (before.slotData && typeof before.slotData === "object")
      ? before.slotData as Record<string, Record<string, unknown> | undefined>
      : {};

    for (const characterId of removedIds) {
      const slot = beforeSlotData[characterId];
      const ownerUid = String(slot?.ownerUid ?? "").trim();
      // Sem DONO identificado não existe pré-venda possível (a pré-aprovação
      // exige ownerUid); nada a limpar.
      if (!ownerUid) continue;

      const acquisitionId = `acq_${sanitizeIdSegment(ownerUid, 80)}_${sanitizeIdSegment(characterId, 120)}`;
      const ref = firestore.collection(ACQUISITIONS_COLLECTION).doc(acquisitionId);
      try {
        const outcome = await firestore.runTransaction(async transaction => {
          const snapshot = await transaction.get(ref);
          if (!snapshot.exists) return "not_found";
          const data = snapshot.data() || {};
          // Compra já confirmada pelo comprador: negociação intocável.
          if (String(data.status || "") !== "pre_approved") return "not_pre_approved";
          // A pré-venda pertence a outra PT: a remoção nesta não a afeta.
          if (String(data.partyId || "") !== partyId) return "other_party";
          transaction.delete(ref);
          return "cancelled";
        });
        if (outcome === "cancelled") {
          logger.info("Pré-venda cancelada por remoção do personagem da PT", {
            partyId,
            characterId,
            acquisitionId,
          });
        }
      } catch (error) {
        logger.error("Falha ao cancelar pré-venda de personagem removido", {
          partyId,
          characterId,
          acquisitionId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error; // repropaga para o retry da Function
      }
    }
  },
);
