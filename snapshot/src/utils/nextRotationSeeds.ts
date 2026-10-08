import type { PartyCustomMember, PartyTab } from "../types";
import { computeSanguineOutcome, sanguineSlotBaseRot } from "./sanguineRotation";
import { toFirestoreMillis } from "./firestoreTimestamp";

// ============================================================================
// SANGUINE — "PRÓXIMA ROTAÇÃO": SEMENTES DA NOVA PT (fonte única, módulo puro)
// ----------------------------------------------------------------------------
// O modal "Próxima Rotação" devolve os ids selecionados (Drop? = Não) da PT
// de ORIGEM. Este módulo separa esses ids em:
//
//   • `normalIds` + `slotSeed` — personagens normais (selectedIds da PT):
//     DONO/JOGADOR congelados da PT de origem + rotação PLANEJADA
//     (rotação-base imutável + 1). Comportamento IDÊNTICO ao que o
//     App.handleCreateNextRotation sempre fez.
//
//   • `customSeed` — membros EXTERNOS ("+ Externo", id `cust_...`): NUNCA
//     podem entrar em `selectedIds` da nova PT, porque não existe
//     Character/snapshot/fonte viva para resolvê-los — o backfill de
//     snapshots os "ressuscitava" como personagens VAZIOS (Personagem "" e
//     Conta com código mascarado), perdendo os dados das colunas Personagem
//     e Conta. Eles renascem na nova PT como `customMembers` DE NOVO, com o
//     cadastro ÍNTEGRO da PT anterior (label = Personagem, ownerName,
//     servidor, voc, level, flags) e o MESMO id; o slot herda DONO/JOGADOR,
//     a rotação planejada e o COOLDOWN do Bakragore importado pela MESMA
//     fórmula aplicada aos personagens normais (`computeSanguineOutcome`
//     com Drop=Não → conclusão da PT de origem + 72h). Sem
//     `questFinalizedAt` persistido, nenhum cooldown é importado (campo
//     ausente — mesmo comportamento de hoje).
//
// Módulo PURO (sem Firebase/React): determinístico e testável. Consumidor:
// App.handleCreateNextRotation → App.createParty.
// ============================================================================

/** Semente de slot de personagem NORMAL (selectedIds) da nova PT. */
export interface NextRotationSlotSeed {
  owner: string;
  ownerUid: string;
  player: string;
  playerUid?: string;
  sgRotPlanned?: number;
}

/**
 * Semente de membro EXTERNO da nova PT: o customMember da PT de origem
 * (dados cadastrais preservados) + os dados de slot herdados (DONO/JOGADOR,
 * rotação planejada e cooldown importado).
 */
export interface NextRotationCustomSeed {
  member: PartyCustomMember;
  slot: {
    owner: string;
    player: string;
    playerUid?: string;
    sgRotPlanned?: number;
    /** Fim do cooldown do Bakragore importado (epoch ms); ausente = sem dado. */
    sgBakraCooldownUntil?: number;
  };
}

export interface NextRotationSeeds {
  /** Ids que seguem o fluxo normal (`suggestedIds` do createParty). */
  normalIds: string[];
  /** Sementes de slot dos personagens normais, por id. */
  slotSeed: Record<string, NextRotationSlotSeed>;
  /** Sementes dos membros externos (viram customMembers na nova PT). */
  customSeed: NextRotationCustomSeed[];
  /** Donos (uids) dos personagens normais — convidados da PT privada. */
  ownerUids: string[];
}

/**
 * Monta as sementes da nova PT da "Próxima Rotação" a partir da PT de ORIGEM
 * e dos ids selecionados no modal (Drop? = Não).
 */
export function buildNextRotationSeeds(sourceParty: PartyTab, selectedIds: string[]): NextRotationSeeds {
  const slotSeed: Record<string, NextRotationSlotSeed> = {};
  const customSeed: NextRotationCustomSeed[] = [];
  const normalIds: string[] = [];
  const ownerUids = new Set<string>();

  selectedIds.forEach(id => {
    const slot = sourceParty.slotData?.[id];

    // MEMBRO EXTERNO ("+ Externo") da PT de origem.
    const custom = sourceParty.customMembers?.find(c => c.id === id);
    if (custom) {
      // Cooldown importado pela MESMA regra dos personagens normais.
      const outcome = computeSanguineOutcome(false, sanguineSlotBaseRot(sourceParty, id), toFirestoreMillis(sourceParty.questFinalizedAt));
      customSeed.push({
        member: { ...custom },
        slot: {
          owner: slot?.owner || custom.ownerName || "",
          player: slot?.player || "",
          ...(slot?.playerUid ? { playerUid: slot.playerUid } : {}),
          sgRotPlanned: sanguineSlotBaseRot(sourceParty, id) + 1,
          ...(outcome.sgBakraCooldownUntil !== null ? { sgBakraCooldownUntil: outcome.sgBakraCooldownUntil } : {}),
        },
      });
      return;
    }

    // PERSONAGEM NORMAL — comportamento original preservado.
    normalIds.push(id);
    const snap = sourceParty.memberSnapshots?.[id];
    const ownerUid = slot?.ownerUid || snap?.ownerUid || "";
    const owner = slot?.owner || snap?.ownerName || "";
    slotSeed[id] = {
      owner,
      ownerUid,
      player: slot?.player || owner,
      playerUid: slot?.playerUid || ownerUid || undefined,
      // ROTAÇÃO PLANEJADA da nova PT: a rotação-base IMUTÁVEL congelada na
      // conclusão da PT de origem + 1 (Drop? = Não avança a rotação). A
      // nova PT já NASCE com a rotação correta, mesmo que o personagem
      // vivo do dono (offline) ainda não tenha refletido o resultado — o
      // personagem importado da lista de disponíveis segue sendo a fonte
      // da verdade (a exibição usa o MAIOR entre os dois).
      sgRotPlanned: sanguineSlotBaseRot(sourceParty, id) + 1,
    };
    if (ownerUid) ownerUids.add(ownerUid);
  });

  return { normalIds, slotSeed, customSeed, ownerUids: Array.from(ownerUids) };
}
