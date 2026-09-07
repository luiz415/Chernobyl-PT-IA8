import type { PartyTab } from "../types";

// ============================================================================
// PARTICIPAÇÃO EM PT — mapa compartilhado id → nomes das PTs
// ============================================================================
// Mesma derivação do memo `characterInParty` de Meus Personagens (CharTable):
// varre `selectedIds` das PTs que o App já mantém em memória (listener do
// Firestore) — NENHUMA leitura adicional. Serve tanto para personagens
// normais quanto para personagens de Service, porque os dois entram em
// `selectedIds` com o próprio id (Character.id / WaitingService.id /
// SharedService.id via sharedServiceToWaiting).
//
// Usado pelas guias "Services" (WaitingListPanel) e "Meus Services"
// (MyServicesPanel) para o indicador "Em PT" — o mesmo comportamento da
// coluna PT de Meus Personagens, atualizado automaticamente quando o
// personagem entra ou sai de uma PT (as props de PTs são reativas).
// ============================================================================

/** Map id → nomes das PTs em que a entidade participa (ordem de varredura). */
export function buildPartyMembershipNames(parties: PartyTab[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  parties.forEach(party => {
    const name = String(party.name || "").trim() || "PT sem nome";
    (party.selectedIds || []).forEach(id => {
      const list = map.get(id);
      if (list) list.push(name);
      else map.set(id, [name]);
    });
  });
  return map;
}
