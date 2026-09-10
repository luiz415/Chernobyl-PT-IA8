import { ExternalLink, Link2 } from "lucide-react";
import { useMemo } from "react";
import { customAlert } from "../types";
import { useAuth } from "../context/AuthContext";
import { getEffectiveUserRole } from "../utils/vipAccess";
import { buildExclusiveServiceFormUrl, PUBLIC_SERVICE_FORM_BASE_URL, type ServiceFormTarget } from "../utils/serviceFormSlug";

// ============================================================================
// BOTÕES DE LINK DO FORMULÁRIO DE SERVICES
//
// Dois botões, mesma lógica de cópia (extraída em `copyLinkToClipboard`):
//
//   • ServiceFormLinkButton — link do formulário PÚBLICO geral (#/servico),
//     comportamento original preservado (usado em "Meus Services"; a aba
//     "Services" tem uma cópia inline própria).
//
//   • ExclusiveServiceFormLinkButton — NOVO: gera e copia o link EXCLUSIVO
//     do usuário logado (#/servico/{slug}). Qualquer cadastro feito por esse
//     link é direcionado automaticamente a ele, sem o cliente escolher (nem
//     ver) o campo Serviceiro. Renderizado apenas para elegíveis (Boss ou
//     VIP ativo + serviceiro) — a MESMA regra de elegibilidade que o
//     formulário público e as regras do Firestore usam para aceitar o
//     destinatário; a validação real de segurança é do backend.
//
// A cópia tenta a Clipboard API e, se ela falhar (navegador antigo ou
// contexto sem permissão), recorre ao `execCommand`. Falhando os dois, o
// link é mostrado para cópia manual em vez de o clique não fazer nada.
// ============================================================================

/** Endereço do formulário público. Fonte única para os dois painéis. */
export const PUBLIC_SERVICE_FORM_URL = PUBLIC_SERVICE_FORM_BASE_URL;

/** Copia `url` com os mesmos fallbacks do botão original. */
async function copyLinkToClipboard(url: string): Promise<boolean> {
  let copied = false;
  // Tentativa 1: API moderna (Clipboard API)
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      copied = false;
    }
  }
  // Tentativa 2: Fallback via execCommand (navegadores antigos ou contextos sem permissão)
  if (!copied) {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = url;
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
  return copied;
}

export default function ServiceFormLinkButton() {
  return (
    <button
      onClick={async () => {
        const formUrl = PUBLIC_SERVICE_FORM_URL;
        const copied = await copyLinkToClipboard(formUrl);
        if (copied) {
          customAlert("Link do formulário copiado! Envie para o cliente preencher.", "Link Copiado");
        } else {
          customAlert(`Não foi possível copiar automaticamente. Copie manualmente:\n\n${formUrl}`, "Copiar Link");
        }
      }}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/50 text-amber-400 transition-colors whitespace-nowrap"
    >
      <ExternalLink size={14} /> Copiar Link Formulário Geral
    </button>
  );
}

/**
 * Botão "Copiar Link do Meu Formulário Pessoal" — link EXCLUSIVO do usuário
 * logado, com pulso esmeralda na borda (classe exclusive-form-link-pulse em
 * src/index.css) para chamar a atenção.
 *
 * O slug é derivado do nome ("Luis" → "luis"); se OUTRO usuário elegível
 * tiver o mesmo slug, um sufixo do UID é anexado automaticamente — o link
 * permanece amigável e único. A lista de elegíveis vem de `allUsers`, que o
 * AuthContext já mantém (zero leituras extras no Firestore).
 *
 * Renderiza null quando o usuário não é elegível — o chamador não precisa
 * duplicar a regra de acesso.
 */
export function ExclusiveServiceFormLinkButton() {
  const { currentUser, userProfile, allUsers } = useAuth();

  // Elegibilidade: MESMA regra do formulário público e das regras do
  // Firestore para o destinatário de `serviceRequests` — Boss aprovado ou
  // VIP ativo com a flag serviceiro.
  const isEligible = useMemo(() => {
    if (!userProfile || userProfile.status !== "aprovado") return false;
    const role = getEffectiveUserRole(userProfile);
    return role === "Boss" || (role === "VIP" && userProfile.serviceiro === true);
  }, [userProfile]);

  // Todos os elegíveis — usados apenas para detectar conflito de slug na
  // geração (homônimos ganham sufixo de UID).
  const eligibleTargets = useMemo<ServiceFormTarget[]>(() => {
    return (allUsers || [])
      .filter(user => {
        if (user.status !== "aprovado") return false;
        const role = getEffectiveUserRole(user);
        return role === "Boss" || (role === "VIP" && user.serviceiro === true);
      })
      .map(user => ({ uid: user.uid, nome: user.nome || "" }));
  }, [allUsers]);

  if (!isEligible || !currentUser?.uid) return null;

  const url = buildExclusiveServiceFormUrl(currentUser.uid, userProfile?.nome || "", eligibleTargets);
  if (!url) return null;

  return (
    <button
      onClick={async () => {
        const copied = await copyLinkToClipboard(url);
        if (copied) {
          customAlert(
            `Seu link exclusivo foi copiado!\n\n${url}\n\nQualquer personagem cadastrado por ele será direcionado automaticamente a você — o cliente não escolhe o Serviceiro.`,
            "Link Exclusivo Copiado",
          );
        } else {
          customAlert(`Não foi possível copiar automaticamente. Copie manualmente:\n\n${url}`, "Copiar Link Exclusivo");
        }
      }}
      className="exclusive-form-link-pulse inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/50 text-emerald-400 transition-colors whitespace-nowrap"
      title="Copiar o seu link exclusivo: cadastros feitos por ele chegam direto para você, sem o cliente escolher o Serviceiro"
    >
      <Link2 size={14} /> Copiar Link do Meu Formulário Pessoal
    </button>
  );
}
