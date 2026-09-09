// ============================================================================
// TUTORIAL — HISTÓRICO DE PTs DEMONSTRATIVO
// ----------------------------------------------------------------------------
// Projeções fictícias no MESMO formato de users/{uid}/partyHistory (documento
// materializado pelo backend) para o tópico "Meu Histórico". Seis cards com
// estados variados: finalizadas, quest concluída aguardando finalização,
// service prestado e uma tentativa falhada.
// ============================================================================
import type { PersonalPartyHistory } from "../../types";

export function buildDemoHistory(now: number): PersonalPartyHistory[] {
  return [
    {
      id: "demo-hist-1",
      partyId: "demo-hist-1",
      status: "finalized",
      sourceRevision: 1,
      party: { name: "PT Demo — Finalizada", questType: "soulwar", server: "Elysian", leaderName: "Você", questFinalizedAt: now - 3 * 86400000, finalizedAt: now - 3 * 86400000 + 3600000, durationMs: 2 * 3600000 + 41 * 60000 },
      roles: { participant: true, leader: true, owner: true, player: true, divisionParticipant: true, financialRightsHolder: false },
      personalSlots: [
        { slotId: "demo-hs-1", characterName: "Demo Knight", ownerName: "Você", playerName: "Você", deaths: 0, itemDropado: "Soulcutter", itemVendido: 190, paid: true, isService: false, isDivisionBeneficiary: true, divisionValue: 125, split: true },
      ],
      allSlots: [
        { slotId: "demo-hs-1", characterName: "Demo Knight", ownerName: "Você", playerName: "Você", deaths: 0, itemDropado: "Soulcutter", itemVendido: 190, paid: true, isService: false, isDivisionBeneficiary: true, divisionValue: 125, split: true },
        { slotId: "demo-hs-2", characterName: "Demo Sorcerer", ownerName: "Você", playerName: "Demo Ana", deaths: 1, itemDropado: "", itemVendido: 0, paid: true, isService: false, isDivisionBeneficiary: true, divisionValue: 125, split: true },
        { slotId: "demo-hs-3", characterName: "Demo Client One", ownerName: "Demo Marcos", playerName: "Demo Rafael", deaths: 0, itemDropado: "", itemVendido: 0, paid: true, isService: true, isDivisionBeneficiary: false, divisionValue: 0, split: false },
        { slotId: "demo-hs-4", characterName: "Demo Blocker", ownerName: "Você", playerName: "Demo Bruno", deaths: 2, itemDropado: "", itemVendido: 0, paid: true, isService: false, isDivisionBeneficiary: true, divisionValue: 125, split: true },
      ],
      division: { participates: true, beneficiarySlotIds: ["demo-hs-1", "demo-hs-2", "demo-hs-4"], valuePerMember: 125 },
    },
    {
      id: "demo-hist-2",
      partyId: "demo-hist-2",
      status: "quest_finalized",
      sourceRevision: 1,
      party: { name: "PT Demo — Quest Concluída", questType: "sanguine", server: "Lunarian", leaderName: "Demo Ana", questFinalizedAt: now - 20 * 3600000, durationMs: 3 * 3600000 + 5 * 60000 },
      roles: { participant: true, leader: false, owner: true, player: true, divisionParticipant: true, financialRightsHolder: false },
      personalSlots: [
        { slotId: "demo-hs-5", characterName: "Demo Druid", ownerName: "Você", playerName: "Você", deaths: 0, itemDropado: "", itemVendido: 0, paid: false, isService: false, isDivisionBeneficiary: true, divisionValue: 90, split: true },
      ],
      allSlots: [
        { slotId: "demo-hs-5", characterName: "Demo Druid", ownerName: "Você", playerName: "Você", deaths: 0, itemDropado: "", itemVendido: 0, paid: false, isService: false, isDivisionBeneficiary: true, divisionValue: 90, split: true },
        { slotId: "demo-hs-6", characterName: "Demo Paladin", ownerName: "Você", playerName: "Demo Carla", deaths: 1, itemDropado: "Sanguine Coil", itemVendido: 160, paid: false, isService: false, isDivisionBeneficiary: true, divisionValue: 90, split: true },
      ],
      division: { participates: true, beneficiarySlotIds: ["demo-hs-5", "demo-hs-6"], valuePerMember: 90 },
    },
    {
      id: "demo-hist-3",
      partyId: "demo-hist-3",
      status: "finalized",
      sourceRevision: 1,
      party: { name: "PT Demo — Soul War Relâmpago", questType: "soulwar", server: "Mystian", leaderName: "Você", questFinalizedAt: now - 5 * 86400000, finalizedAt: now - 5 * 86400000 + 2 * 3600000, durationMs: 1 * 3600000 + 58 * 60000 },
      roles: { participant: true, leader: true, owner: true, player: true, divisionParticipant: true, financialRightsHolder: false },
      personalSlots: [
        { slotId: "demo-hs-8", characterName: "Demo Berserker", ownerName: "Você", playerName: "Você", deaths: 0, itemDropado: "Soulcrusher", itemVendido: 310, paid: true, isService: false, isDivisionBeneficiary: true, divisionValue: 150, split: true },
      ],
      allSlots: [
        { slotId: "demo-hs-8", characterName: "Demo Berserker", ownerName: "Você", playerName: "Você", deaths: 0, itemDropado: "Soulcrusher", itemVendido: 310, paid: true, isService: false, isDivisionBeneficiary: true, divisionValue: 150, split: true },
        { slotId: "demo-hs-9", characterName: "Demo Templar", ownerName: "Você", playerName: "Demo Bruno", deaths: 0, itemDropado: "", itemVendido: 0, paid: true, isService: false, isDivisionBeneficiary: true, divisionValue: 150, split: true },
        { slotId: "demo-hs-10", characterName: "Demo Rogue", ownerName: "Você", playerName: "Demo Sofia", deaths: 1, itemDropado: "", itemVendido: 0, paid: true, isService: false, isDivisionBeneficiary: true, divisionValue: 150, split: true },
      ],
      division: { participates: true, beneficiarySlotIds: ["demo-hs-8", "demo-hs-9", "demo-hs-10"], valuePerMember: 150 },
    },
    {
      id: "demo-hist-4",
      partyId: "demo-hist-4",
      status: "finalized",
      sourceRevision: 1,
      party: { name: "PT Demo — Sanguine em Dupla", questType: "sanguine", server: "Solarian", leaderName: "Demo Carla", questFinalizedAt: now - 7 * 86400000, finalizedAt: now - 7 * 86400000 + 90 * 60000, durationMs: 2 * 3600000 + 22 * 60000 },
      roles: { participant: true, leader: false, owner: true, player: true, divisionParticipant: true, financialRightsHolder: false },
      personalSlots: [
        { slotId: "demo-hs-11", characterName: "Demo Warlock", ownerName: "Você", playerName: "Você", deaths: 0, itemDropado: "Grand Sanguine Rod", itemVendido: 420, paid: true, isService: false, isDivisionBeneficiary: true, divisionValue: 210, split: true },
      ],
      allSlots: [
        { slotId: "demo-hs-11", characterName: "Demo Warlock", ownerName: "Você", playerName: "Você", deaths: 0, itemDropado: "Grand Sanguine Rod", itemVendido: 420, paid: true, isService: false, isDivisionBeneficiary: true, divisionValue: 210, split: true },
        { slotId: "demo-hs-12", characterName: "Demo Mystic", ownerName: "Você", playerName: "Demo Carla", deaths: 0, itemDropado: "", itemVendido: 0, paid: true, isService: false, isDivisionBeneficiary: true, divisionValue: 210, split: true },
      ],
      division: { participates: true, beneficiarySlotIds: ["demo-hs-11", "demo-hs-12"], valuePerMember: 210 },
    },
    {
      id: "demo-hist-5",
      partyId: "demo-hist-5",
      status: "finalized",
      sourceRevision: 1,
      party: { name: "PT Demo — Service Prestado", questType: "soulwar", server: "Auroria", leaderName: "Você", questFinalizedAt: now - 11 * 86400000, finalizedAt: now - 11 * 86400000 + 3 * 3600000, durationMs: 2 * 3600000 + 55 * 60000 },
      roles: { participant: true, leader: true, owner: false, player: true, divisionParticipant: false, financialRightsHolder: false },
      personalSlots: [
        { slotId: "demo-hs-13", characterName: "Demo Client Done", ownerName: "Demo Igor", playerName: "Você", deaths: 0, itemDropado: "", itemVendido: 0, paid: true, isService: true, isDivisionBeneficiary: false, divisionValue: 0, split: false },
      ],
      allSlots: [
        { slotId: "demo-hs-13", characterName: "Demo Client Done", ownerName: "Demo Igor", playerName: "Você", deaths: 0, itemDropado: "", itemVendido: 0, paid: true, isService: true, isDivisionBeneficiary: false, divisionValue: 0, split: false },
        { slotId: "demo-hs-14", characterName: "Demo Sentinel", ownerName: "Você", playerName: "Demo Rafael", deaths: 1, itemDropado: "", itemVendido: 0, paid: true, isService: false, isDivisionBeneficiary: true, divisionValue: 105, split: true },
        { slotId: "demo-hs-15", characterName: "Demo Scout", ownerName: "Você", playerName: "Demo Ana", deaths: 0, itemDropado: "Soulsoles", itemVendido: 85, paid: true, isService: false, isDivisionBeneficiary: true, divisionValue: 105, split: true },
      ],
      division: { participates: false, beneficiarySlotIds: ["demo-hs-14", "demo-hs-15"], valuePerMember: 105 },
    },
    {
      id: "demo-hist-6",
      partyId: "demo-hist-6",
      status: "failed",
      sourceRevision: 1,
      party: { name: "PT Demo — Falhou", questType: "soulwar", server: "Mystian", leaderName: "Demo Bruno", questFinalizedAt: now - 13 * 86400000, finalizedAt: now - 13 * 86400000, durationMs: 62 * 60000 },
      roles: { participant: true, leader: false, owner: true, player: true, divisionParticipant: false, financialRightsHolder: false },
      personalSlots: [
        { slotId: "demo-hs-7", characterName: "Demo Monk", ownerName: "Você", playerName: "Você", deaths: 3, itemDropado: "", itemVendido: 0, paid: false, isService: false, isDivisionBeneficiary: false, divisionValue: 0, split: false },
      ],
      allSlots: [
        { slotId: "demo-hs-7", characterName: "Demo Monk", ownerName: "Você", playerName: "Você", deaths: 3, itemDropado: "", itemVendido: 0, paid: false, isService: false, isDivisionBeneficiary: false, divisionValue: 0, split: false },
      ],
      division: { participates: false, beneficiarySlotIds: [], valuePerMember: 0 },
    },
  ];
}
