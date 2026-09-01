import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MessageCircle, Plus, RotateCcw, Trash2, X } from "lucide-react";
import {
  DEFAULT_WHATSAPP_TEMPLATES,
  WHATSAPP_TEMPLATE_VARIABLES,
  type WhatsappTemplate,
} from "../services/whatsappTemplatesService";

// ============================================================================
// MODAL DE CONFIGURAÇÃO — Mensagens Padrão do WhatsApp
// ============================================================================
// Permite visualizar, editar (título e conteúdo), adicionar, remover e
// restaurar as mensagens usadas no contato com clientes. As alterações são
// persistidas pelo painel que hospeda este modal (localStorage por UID).
//
// Mesma estrutura de modal do restante do app (portal + app-modal-frame).
// ============================================================================

interface Props {
  open: boolean;
  templates: WhatsappTemplate[];
  onClose: () => void;
  onSave: (templates: WhatsappTemplate[]) => void;
}

const INPUT_CLS =
  "w-full px-2 py-1.5 bg-[var(--th-n-elev)] border border-white/[0.07] rounded-md text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 transition-colors";

export default function WhatsappTemplateModal({ open, templates, onClose, onSave }: Props) {
  // Cópia de trabalho: inicializada no primeiro render (sem flash de lista
  // vazia) e refeita a cada abertura — Cancelar descarta as edições.
  const [draft, setDraft] = useState<WhatsappTemplate[]>(() => templates.map(t => ({ ...t })));

  useEffect(() => {
    if (open) setDraft(templates.map(t => ({ ...t })));
  }, [open, templates]);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  function update(id: string, patch: Partial<WhatsappTemplate>) {
    setDraft(prev => prev.map(t => (t.id === id ? { ...t, ...patch } : t)));
  }

  function addTemplate() {
    const id = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setDraft(prev => [...prev, { id, titulo: "Nova mensagem", conteudo: "Olá, {{cliente}}! " }]);
  }

  function removeTemplate(id: string) {
    setDraft(prev => (prev.length > 1 ? prev.filter(t => t.id !== id) : prev));
  }

  function restoreDefaults() {
    setDraft(DEFAULT_WHATSAPP_TEMPLATES.map(t => ({ ...t })));
  }

  const isValid = draft.length > 0 && draft.every(t => t.titulo.trim() && t.conteudo.trim());

  function handleSave() {
    if (!isValid) return;
    onSave(draft.map(t => ({
      id: t.id,
      titulo: t.titulo.trim(),
      conteudo: t.conteudo.replace(/\s+$/, ""),
    })));
    // Salvar = persistir, FECHAR a configuração e voltar ao seletor de
    // mensagem (o painel hospedeiro reabre o seletor com este mesmo cliente,
    // já carregando as mensagens recém-salvas — sem recarregar a página).
    onClose();
  }

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 backdrop-blur-sm p-3"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="app-modal-frame app-modal-frame--scroll app-modal-size-md relative w-full bg-[var(--th-bg-base)] border border-[var(--th-line)]/100 rounded-xl shadow-2xl shadow-black/50">
        {/* Header compacto */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60 flex-shrink-0">
          <div className="flex items-center gap-2">
            <MessageCircle size={14} className="text-emerald-400" />
            <h2 className="text-sm font-bold text-slate-100 tracking-tight">
              Mensagens Padrão do WhatsApp
            </h2>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-200 transition-colors p-1 rounded-md hover:bg-white/[0.04] cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="app-modal-body custom-scrollbar px-4 py-3 space-y-3">
          {/* Ajuda: variáveis disponíveis (dados reais do Service) */}
          <div className="rounded-lg border border-white/[0.07] bg-[var(--th-n-elev)] px-3 py-2">
            <div className="text-[9px] font-black uppercase tracking-wider text-slate-500 mb-1.5">
              Variáveis — substituídas pelos dados do Service ao enviar
            </div>
            <div className="flex flex-wrap gap-1">
              {WHATSAPP_TEMPLATE_VARIABLES.map(variable => (
                <span
                  key={variable.token}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-emerald-500/25 bg-emerald-500/10 text-[9px] text-emerald-300/90 font-mono"
                  title={variable.label}
                >
                  {variable.token}
                  <span className="font-sans text-slate-500 font-normal">{variable.label}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Mensagens cadastradas */}
          <div className="space-y-2.5">
            {draft.map((template, index) => (
              <div key={template.id} className="rounded-lg border border-white/[0.07] bg-[var(--th-n-elev)] px-3 py-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-black text-slate-600 tabular-nums flex-shrink-0">{String(index + 1).padStart(2, "0")}</span>
                  <input
                    type="text"
                    value={template.titulo}
                    onChange={e => update(template.id, { titulo: e.target.value })}
                    placeholder="Título da mensagem"
                    maxLength={40}
                    className={INPUT_CLS}
                  />
                  <button
                    type="button"
                    onClick={() => removeTemplate(template.id)}
                    disabled={draft.length <= 1}
                    title={draft.length <= 1 ? "É preciso manter ao menos uma mensagem" : "Remover esta mensagem"}
                    className="text-slate-500 hover:text-rose-400 transition-colors p-1.5 rounded-md hover:bg-rose-500/10 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <textarea
                  value={template.conteudo}
                  onChange={e => update(template.id, { conteudo: e.target.value })}
                  placeholder="Conteúdo da mensagem — use as variáveis acima (ex.: {{cliente}}, {{personagem}})"
                  rows={6}
                  maxLength={1200}
                  className={`${INPUT_CLS} custom-scrollbar resize-y min-h-[92px] leading-relaxed`}
                />
                <div className="flex items-center justify-between">
                  <span className={`text-[9px] ${template.titulo.trim() && template.conteudo.trim() ? "text-slate-600" : "text-amber-400"}`}>
                    {template.titulo.trim() && template.conteudo.trim() ? "Usada no seletor ao clicar no WhatsApp" : "Título e conteúdo são obrigatórios"}
                  </span>
                  <span className="text-[9px] text-slate-600 tabular-nums">{template.conteudo.length}/1200</span>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={addTemplate}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-white/15 hover:border-emerald-500/40 hover:bg-emerald-500/5 text-[10px] font-bold text-slate-400 hover:text-emerald-300 transition-colors cursor-pointer"
          >
            <Plus size={12} /> Nova mensagem
          </button>
        </div>

        {/* Footer */}
        <div className="app-modal-footer flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-t border-[var(--th-line)]/60 bg-[var(--th-bg-raised)]">
          <button
            type="button"
            onClick={restoreDefaults}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 text-[10px] font-bold transition-colors cursor-pointer whitespace-nowrap"
            title="Voltar às 4 mensagens originais do sistema"
          >
            <RotateCcw size={12} /> Restaurar padrões
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10 text-[11px] font-bold transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!isValid}
              title={isValid ? undefined : "Preencha o título e o conteúdo de todas as mensagens"}
              className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-emerald-600/90 to-emerald-500/90 hover:from-emerald-500 hover:to-emerald-400 border border-emerald-400/50 text-white text-[11px] font-black transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:from-emerald-600/90 disabled:hover:to-emerald-500/90"
            >
              Salvar mensagens
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}