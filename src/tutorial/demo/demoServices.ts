// ============================================================================
// TUTORIAL — "MEUS SERVICES" DEMONSTRATIVO (painel do Serviceiro)
// ----------------------------------------------------------------------------
// Services e solicitações fictícias no formato real (SharedService /
// ServiceRequest) para o tópico "Meus Services" — permite mostrar o painel
// por dentro mesmo para quem não é VIP/Serviceiro. Contatos de WhatsApp usam
// o prefixo reservado 55 00 9…: número impossível, nunca abre conversa real.
// ============================================================================
import type { ServiceRequest, SharedService } from "../../types";

export function buildDemoSharedServices(now: number): SharedService[] {
  const base = { whatsappCountry: "55", whatsappArea: "00", serviceiroUid: "demo-uid-you", serviceiroNome: "Você" };
  return [
    // ── Disponíveis (aguardando atendimento) ───────────────────────────────
    { ...base, id: "demo-svc-1", personagem: "Demo Client One", ownerName: "Demo Marcos", servidor: "Elysian", voc: "EK", level: 380, valorCombinado: 350, notes: "Cliente do formulário público.", whatsappNumber: "900000001", quest: "soulwar", paymentMethod: "pix", dataService: new Date(now - 2 * 86400000).toISOString().slice(0, 10), status: "disponivel", lucroService: 0, createdAt: now - 2 * 86400000, updatedAt: now - 2 * 86400000, firstMessageSentAt: now - 86400000 },
    { ...base, id: "demo-svc-2", personagem: "Demo Client Two", ownerName: "Demo Paula", servidor: "Lunarian", voc: "ED", level: 355, valorCombinado: 0, notes: "", whatsappNumber: "900000002", quest: "sanguine", paymentMethod: "5050", dataService: new Date(now - 86400000).toISOString().slice(0, 10), status: "disponivel", lucroService: 0, createdAt: now - 86400000, updatedAt: now - 86400000 },
    { ...base, id: "demo-svc-3", personagem: "Demo Client Five", ownerName: "Demo Larissa", servidor: "Mystian", voc: "MS", level: 336, valorCombinado: 300, notes: "Prefere PT no fim de semana.", whatsappNumber: "900000005", quest: "sanguine", paymentMethod: "rc", dataService: new Date(now - 12 * 3600000).toISOString().slice(0, 10), status: "disponivel", lucroService: 0, createdAt: now - 12 * 3600000, updatedAt: now - 12 * 3600000 },
    { ...base, id: "demo-svc-4", personagem: "Demo Client Six", ownerName: "Demo Otávio", servidor: "Auroria", voc: "RP", level: 361, valorCombinado: 340, notes: "", whatsappNumber: "900000006", quest: "soulwar", paymentMethod: "pix", dataService: new Date(now - 5 * 3600000).toISOString().slice(0, 10), status: "disponivel", lucroService: 0, createdAt: now - 5 * 3600000, updatedAt: now - 5 * 3600000, firstMessageSentAt: now - 2 * 3600000 },
    // ── Realizados (histórico do Serviceiro) ───────────────────────────────
    { ...base, id: "demo-svc-5", personagem: "Demo Client Done", ownerName: "Demo Igor", servidor: "Solarian", voc: "RP", level: 342, valorCombinado: 320, notes: "Entregue na semana passada.", whatsappNumber: "900000003", quest: "soulwar", paymentMethod: "rc", dataService: new Date(now - 8 * 86400000).toISOString().slice(0, 10), status: "realizado", lucroService: 320, createdAt: now - 8 * 86400000, updatedAt: now - 6 * 86400000, completedAt: now - 6 * 86400000, firstMessageSentAt: now - 8 * 86400000 },
    { ...base, id: "demo-svc-6", personagem: "Demo Client Past", ownerName: "Demo Helena", servidor: "Elysian", voc: "ED", level: 349, valorCombinado: 290, notes: "", whatsappNumber: "900000007", quest: "sanguine", paymentMethod: "pix", dataService: new Date(now - 15 * 86400000).toISOString().slice(0, 10), status: "realizado", lucroService: 290, createdAt: now - 15 * 86400000, updatedAt: now - 13 * 86400000, completedAt: now - 13 * 86400000, firstMessageSentAt: now - 15 * 86400000 },
    { ...base, id: "demo-svc-7", personagem: "Demo Client Old", ownerName: "Demo Vitor", servidor: "Mystian", voc: "EK", level: 371, valorCombinado: 405, notes: "Cliente recorrente.", whatsappNumber: "900000008", quest: "soulwar", paymentMethod: "5050", dataService: new Date(now - 22 * 86400000).toISOString().slice(0, 10), status: "realizado", lucroService: 405, createdAt: now - 22 * 86400000, updatedAt: now - 20 * 86400000, completedAt: now - 20 * 86400000, firstMessageSentAt: now - 22 * 86400000 },
  ];
}

export function buildDemoServiceRequests(now: number): ServiceRequest[] {
  return [
    { id: "demo-req-1", personagem: "Demo New Client", ownerName: "Demo Sofia", servidor: "Mystian", voc: "MS", level: 328, notes: "Posso jogar qualquer dia após as 20h.", whatsappCountry: "55", whatsappArea: "00", whatsappNumber: "900000004", quest: "sanguine", paymentMethod: "pix", serviceiroUid: "demo-uid-you", status: "pendente", createdAt: now - 3 * 3600000, source: "public_form" },
    { id: "demo-req-2", personagem: "Demo Fresh Client", ownerName: "Demo Caio", servidor: "Elysian", voc: "EK", level: 344, notes: "Primeira Soul War — preciso de orientação.", whatsappCountry: "55", whatsappArea: "00", whatsappNumber: "900000009", quest: "soulwar", paymentMethod: "rc", serviceiroUid: "demo-uid-you", status: "pendente", createdAt: now - 50 * 60000, source: "public_form" },
  ];
}
