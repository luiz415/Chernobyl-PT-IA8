// ============================================================================
// TUTORIAL — SERVICES DEMONSTRATIVOS (fila pública "Services")
// ----------------------------------------------------------------------------
// Entradas fictícias da Lista de Espera para o tópico "Services". Contatos de
// WhatsApp usam o prefixo reservado 55 00 9....: número impossível, nunca
// abre conversa real.
// ============================================================================
import type { WaitingService } from "../../types";

export function buildDemoWaitingList(now: number): WaitingService[] {
  const base = { whatsappCountry: "55", whatsappArea: "00", addedBy: "Formulário Público", createdBy: "demo-uid-cliente", notes: "" };
  return [
    { ...base, id: "demo-ws-1", personagem: "Demo Client One", ownerName: "Demo Marcos", servidor: "Elysian", voc: "EK", level: 380, valorCombinado: 350, dataAdicionado: new Date(now - 2 * 86400000).toISOString().slice(0, 10), whatsappNumber: "900000001", quest: "soulwar", paymentMethod: "pix", createdAt: now - 2 * 86400000, createdByName: "Demo Marcos", firstMessageSentAt: now - 86400000 },
    { ...base, id: "demo-ws-2", personagem: "Demo Client Two", ownerName: "Demo Paula", servidor: "Lunarian", voc: "ED", level: 355, valorCombinado: 300, dataAdicionado: new Date(now - 86400000).toISOString().slice(0, 10), whatsappNumber: "900000002", quest: "sanguine", paymentMethod: "rc", createdAt: now - 86400000, createdByName: "Demo Paula", notes: "Cliente prefere PT à noite." },
    { ...base, id: "demo-ws-3", personagem: "Demo Client Three", ownerName: "Demo Igor", servidor: "Solarian", voc: "RP", level: 340, valorCombinado: 320, dataAdicionado: new Date(now - 6 * 3600000).toISOString().slice(0, 10), whatsappNumber: "900000003", quest: "soulwar", paymentMethod: "5050", createdAt: now - 6 * 3600000, createdByName: "Demo Igor" },
    { ...base, id: "demo-ws-4", personagem: "Demo Client Four", ownerName: "Demo Bianca", servidor: "Mystian", voc: "MS", level: 333, valorCombinado: 285, dataAdicionado: new Date(now - 30 * 3600000).toISOString().slice(0, 10), whatsappNumber: "900000010", quest: "sanguine", paymentMethod: "pix", createdAt: now - 30 * 3600000, createdByName: "Demo Bianca", notes: "Só pode jogar aos sábados." },
    { ...base, id: "demo-ws-5", personagem: "Demo Client Five", ownerName: "Demo Larissa", servidor: "Mystian", voc: "MS", level: 336, valorCombinado: 300, dataAdicionado: new Date(now - 12 * 3600000).toISOString().slice(0, 10), whatsappNumber: "900000005", quest: "sanguine", paymentMethod: "rc", createdAt: now - 12 * 3600000, createdByName: "Demo Larissa" },
    { ...base, id: "demo-ws-6", personagem: "Demo Client Seven", ownerName: "Demo Túlio", servidor: "Auroria", voc: "EK", level: 358, valorCombinado: 330, dataAdicionado: new Date(now - 3 * 3600000).toISOString().slice(0, 10), whatsappNumber: "900000011", quest: "soulwar", paymentMethod: "combinado", createdAt: now - 3 * 3600000, createdByName: "Demo Túlio", firstMessageSentAt: now - 3600000 },
  ];
}
