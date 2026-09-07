import { Shield } from "lucide-react";

// ============================================================================
// BADGE "EM PT" — indicador de participação em PT
// ============================================================================
// EXATAMENTE o mesmo indicador da coluna PT de "Meus Personagens" (CharTable):
// escudo violeta com tooltip "Em PT: <nome>". Reutilizado pelas guias
// "Services" (WaitingListPanel) e "Meus Services" (MyServicesPanel) para os
// personagens de Service — nada de indicador novo só para Services.
//
// `partyNames` vem de buildPartyMembershipNames (src/utils/partyMembership),
// derivado das PTs ativas já em memória; sem participação, nada é exibido.
// ============================================================================

export default function PartyMembershipBadge({ partyNames }: { partyNames?: string[] }) {
  if (!partyNames || partyNames.length === 0) return null;
  return (
    <span
      className="inline-flex items-center flex-shrink-0"
      title={`Em PT: ${partyNames.join(", ")}`}
    >
      <Shield size={13} className="text-violet-400" />
    </span>
  );
}
