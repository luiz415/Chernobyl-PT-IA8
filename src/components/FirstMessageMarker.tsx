import { MessageCircleCheck, MessageCircleDashed } from "lucide-react";

// ============================================================================
// MARCADOR DE PRIMEIRA MENSAGEM AO CLIENTE
// ============================================================================
// Indicador compacto exibido ao lado do personagem de Service nas guias
// "Services" (Lista de Espera) e "Meus Services". Informa se a PRIMEIRA
// mensagem ao cliente já foi enviada.
//
// A marcação é registrada exclusivamente pela confirmação de "Abrir conversa"
// no modal "Enviar WhatsApp" (WhatsappMessagePicker → onOpenLink): abrir o
// modal, selecionar mensagem ou clicar no botão de WhatsApp NÃO marcam.
//
// `sentAt` = timestamp (ms) persistido no Service (`firstMessageSentAt`);
// ausente/0 = primeira mensagem ainda não enviada.
// ============================================================================

export default function FirstMessageMarker({ sentAt }: { sentAt?: number }) {
  if (sentAt && sentAt > 0) {
    return (
      <span
        className="inline-flex items-center flex-shrink-0"
        title={`Primeira mensagem enviada ao cliente em ${new Date(sentAt).toLocaleString("pt-BR")}`}
      >
        <MessageCircleCheck size={11} className="text-emerald-400" />
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center flex-shrink-0"
      title="Primeira mensagem ainda não enviada ao cliente"
    >
      <MessageCircleDashed size={11} className="text-amber-400/70" />
    </span>
  );
}
