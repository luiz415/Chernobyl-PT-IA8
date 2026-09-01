import { ExternalLink } from "lucide-react";
import { customAlert } from "../types";

// ============================================================================
// BOTÃO "LINK FORMULÁRIO"
//
// Copia o endereço do formulário PÚBLICO de Services, para o Serviceiro enviar
// ao cliente preencher.
//
// Extraído do WaitingListPanel (aba "Services") para ser reaproveitado também
// em "Meus Services", sem duplicar a lógica de cópia. O comportamento, o
// estilo, o ícone, o link e as mensagens são EXATAMENTE os que já existiam —
// nada foi redesenhado nesta extração.
//
// A cópia tenta a Clipboard API e, se ela falhar (navegador antigo ou contexto
// sem permissão), recorre ao `execCommand`. Falhando os dois, o link é
// mostrado para cópia manual em vez de o clique não fazer nada.
// ============================================================================

/** Endereço do formulário público. Fonte única para os dois painéis. */
export const PUBLIC_SERVICE_FORM_URL = "https://chernobyl-pt.web.app/#/servico";

export default function ServiceFormLinkButton() {
  return (
    <button
      onClick={async () => {
        const formUrl = PUBLIC_SERVICE_FORM_URL;
        let copied = false;
        // Tentativa 1: API moderna (Clipboard API)
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          try {
            await navigator.clipboard.writeText(formUrl);
            copied = true;
          } catch {
            copied = false;
          }
        }
        // Tentativa 2: Fallback via execCommand (navegadores antigos ou contextos sem permissão)
        if (!copied) {
          try {
            const textarea = document.createElement("textarea");
            textarea.value = formUrl;
            textarea.style.position = "fixed";
            textarea.style.left = "-9999px";
            textarea.style.top = "-9999px";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            copied = document.execCommand("copy");
            document.body.removeChild(textarea);
          } catch {
            copied = false;
          }
        }
        if (copied) {
          customAlert("Link do formulário copiado! Envie para o cliente preencher.", "Link Copiado");
        } else {
          customAlert(`Não foi possível copiar automaticamente. Copie manualmente:\n\n${formUrl}`, "Copiar Link");
        }
      }}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/50 text-amber-400 transition-colors whitespace-nowrap"
    >
      <ExternalLink size={14} /> Link Formulário
    </button>
  );
}
