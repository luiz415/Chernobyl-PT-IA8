import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { MessageCircle, Send, Settings2, X } from "lucide-react";
import {
  buildWhatsappLink,
  resolveWhatsappTemplate,
  type WhatsappMessageContext,
  type WhatsappTemplate,
} from "../services/whatsappTemplatesService";

// ============================================================================
// SELETOR DE MENSAGEM DO WHATSAPP
// ============================================================================
// Fluxo: botão WhatsApp (linha do Service) → este seletor → "Abrir conversa"
// abre o WhatsApp do cliente com a mensagem escolhida já pré-preenchida
// (`?text=`). O envio em si continua sendo feito pelo usuário, dentro do
// WhatsApp — nada é enviado automaticamente.
//
// A opção "Apenas abrir conversa" ignora as mensagens e abre a conversa
// com o campo de mensagem vazio (comportamento antigo, quando desejado).
//
// Um clique seleciona e pré-visualiza (dados reais daquele Service); um
// duplo clique abre a conversa direto. Compacto: cabe no mobile.
// ============================================================================

/** Id da opção especial "Apenas abrir conversa" (sem mensagem). */
const PLAIN_OPTION_ID = "__plain__";

interface Props {
  open: boolean;
  /** WhatsApp do cliente já em dígitos (país+ddd+número). */
  phoneDigits: string;
  /** Exibição do número (+55 31 999…). */
  phoneDisplay: string;
  templates: WhatsappTemplate[];
  context: WhatsappMessageContext;
  onClose: () => void;
  /** Abre o modal de configuração das mensagens. */
  onOpenSettings: () => void;
  /** Recebe o link do WhatsApp já com o texto escolhido. */
  onOpenLink: (link: string) => void;
}

export default function WhatsappMessagePicker({
  open,
  phoneDigits,
  phoneDisplay,
  templates,
  context,
  onClose,
  onOpenSettings,
  onOpenLink,
}: Props) {
  // Primeira mensagem já selecionada no primeiro paint (sem flash de vazio);
  // o efeito reseta a seleção a cada abertura.
  const [selectedId, setSelectedId] = useState<string>(() => templates[0]?.id || "");

  // Reseta a seleção a cada abertura — sempre a primeira mensagem, pronta.
  useEffect(() => {
    if (open) setSelectedId(templates[0]?.id || "");
  }, [open, templates]);

  const selected = useMemo(
    () => templates.find(t => t.id === selectedId) || null,
    [templates, selectedId],
  );

  const preview = useMemo(
    () => (selected ? resolveWhatsappTemplate(selected.conteudo, context) : ""),
    [selected, context],
  );

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  /** WhatsApp do cliente com o texto escolhido já preenchido. */
  function openConversation(template: WhatsappTemplate) {
    const message = resolveWhatsappTemplate(template.conteudo, context);
    const link = buildWhatsappLink(phoneDigits, message);
    if (link) {
      onOpenLink(link);
      onClose();
    }
  }

  /** Opção "Apenas abrir conversa": link SEM mensagem pré-preenchida. */
  function openPlain() {
    const link = buildWhatsappLink(phoneDigits);
    if (link) {
      onOpenLink(link);
      onClose();
    }
  }

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 backdrop-blur-sm p-3"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="app-modal-frame app-modal-frame--scroll app-modal-size-sm relative w-full bg-[var(--th-bg-base)] border border-[var(--th-line)]/100 rounded-xl shadow-2xl shadow-black/50">
        {/* Header compacto */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <MessageCircle size={14} className="text-emerald-400 flex-shrink-0" />
            <h2 className="text-sm font-bold text-slate-100 tracking-tight truncate">
              Enviar WhatsApp
            </h2>
            <span className="text-[10px] font-mono text-emerald-300/80 truncate" title={phoneDisplay}>
              {phoneDisplay}
            </span>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-200 transition-colors p-1 rounded-md hover:bg-white/[0.04] cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="app-modal-body custom-scrollbar px-3 py-3 space-y-2.5">
          {/* Seleção — um clique escolhe, duplo clique abre direto.
              "Apenas abrir conversa" é uma opção à parte: abre a conversa
              SEM nenhuma mensagem pré-preenchida (comportamento antigo). */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => setSelectedId(PLAIN_OPTION_ID)}
              onDoubleClick={openPlain}
              className={`sm:col-span-2 text-left px-2.5 py-2 rounded-lg border transition-colors cursor-pointer flex items-center gap-2 ${
                selectedId === PLAIN_OPTION_ID
                  ? "border-sky-500/60 bg-sky-500/10 hover:bg-sky-500/15"
                  : "border-white/[0.07] bg-[var(--th-n-elev)] hover:bg-white/[0.04] hover:border-white/15"
              }`}
              title="Abrir a conversa sem mensagem pré-preenchida"
            >
              <MessageCircle size={14} className={selectedId === PLAIN_OPTION_ID ? "text-sky-300" : "text-slate-500"} />
              <span className="min-w-0">
                <span className={`block text-[11px] font-bold truncate ${selectedId === PLAIN_OPTION_ID ? "text-sky-200" : "text-slate-200"}`}>
                  Apenas abrir conversa
                </span>
                <span className="block text-[9px] text-slate-500 truncate">sem mensagem pré-definida</span>
              </span>
            </button>
            {templates.map(template => {
              const isSelected = template.id === selectedId;
              const oneLine = resolveWhatsappTemplate(template.conteudo, context).split("\n").find(l => l.trim()) || "";
              return (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => setSelectedId(template.id)}
                  onDoubleClick={() => openConversation(template)}
                  className={`text-left px-2.5 py-2 rounded-lg border transition-colors cursor-pointer ${
                    isSelected
                      ? "border-emerald-500/60 bg-emerald-500/10 hover:bg-emerald-500/15"
                      : "border-white/[0.07] bg-[var(--th-n-elev)] hover:bg-white/[0.04] hover:border-white/15"
                  }`}
                  title={`Selecionar "${template.titulo}"`}
                >
                  <span className={`block text-[11px] font-bold truncate ${isSelected ? "text-emerald-200" : "text-slate-200"}`}>
                    {template.titulo}
                  </span>
                  <span className="block text-[9px] text-slate-500 truncate mt-0.5">{oneLine}</span>
                </button>
              );
            })}
          </div>

          {/* Pré-visualização: mensagem resolvida com os dados reais do
              Service — ou o aviso da conversa vazia, na opção "apenas abrir". */}
          {selectedId === PLAIN_OPTION_ID ? (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] font-black uppercase tracking-wider text-slate-500">Pré-visualização</span>
                <span className="text-[9px] text-slate-600 truncate max-w-[60%]">Apenas abrir conversa</span>
              </div>
              <div className="rounded-lg bg-sky-950/30 border border-sky-500/20 px-3 py-2.5">
                <p className="text-[11px] leading-relaxed text-sky-200/80">
                  A conversa será aberta com o campo de mensagem vazio — sem texto pré-preenchido.
                </p>
              </div>
            </div>
          ) : selected ? (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] font-black uppercase tracking-wider text-slate-500">Pré-visualização</span>
                <span className="text-[9px] text-slate-600 truncate max-w-[60%]" title={selected.titulo}>{selected.titulo}</span>
              </div>
              <div className="max-h-44 overflow-y-auto custom-scrollbar rounded-lg bg-emerald-950/30 border border-emerald-500/20 px-3 py-2.5">
                <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-emerald-50/90 break-words">
                  {preview}
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer: configurar + abrir a conversa */}
        <div className="app-modal-footer flex items-center justify-between gap-2 px-4 py-2.5 border-t border-[var(--th-line)]/60 bg-[var(--th-bg-raised)]">
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 text-[10px] font-bold transition-colors cursor-pointer whitespace-nowrap"
            title="Configurar as mensagens padrão"
          >
            <Settings2 size={12} /> Mensagens
          </button>
          <button
            type="button"
            disabled={!selected && selectedId !== PLAIN_OPTION_ID}
            onClick={() => {
              if (selectedId === PLAIN_OPTION_ID) openPlain();
              else if (selected) openConversation(selected);
            }}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-gradient-to-r from-emerald-600/90 to-emerald-500/90 hover:from-emerald-500 hover:to-emerald-400 border border-emerald-400/50 text-white text-[11px] font-black transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title="Abrir a conversa com a mensagem pronta para revisão e envio"
          >
            <Send size={12} /> Abrir conversa
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}