import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BellRing, X, Lock, Search, RotateCcw, AlertTriangle } from "lucide-react";
import {
  NOTIFICATION_CHANNELS,
  getVisibleCategories,
  getVisiblePreferences,
  readBooleanPref,
  writeBooleanPref,
} from "../utils/notificationPreferences";
import type { NotificationPreferenceItem } from "../utils/notificationPreferences";
import { useAuth } from "../context/AuthContext";
import { syncNotificationPrefsToCloud } from "../services/notificationPrefsSyncService";
import { ensurePushRegistration } from "../services/pushNotificationService";

// ============================================================================
// CONFIGURAR NOTIFICAÇÕES
//
// Modal único com TODAS as notificações do aplicativo, agrupadas por
// categoria. Substitui os controles soltos que existiam na aba "Ajustes"
// (som e as três janelas de lembrete de PT) — nenhuma preferência foi
// duplicada: o modal lê e grava exatamente as mesmas chaves de antes.
//
// Regras de visibilidade:
//   • itens `bossOnly` só existem para o Boss — para os demais eles nem são
//     montados, e a categoria inteira some quando fica sem itens (nada de
//     cabeçalho vazio);
//   • itens `electronOnly` somem na Web pelo mesmo motivo;
//   • itens `mandatory` aparecem com cadeado, sem interruptor, e o motivo é
//     exibido — o usuário sabe que existem e por que não pode desligá-las.
//
// Todas as cores vêm de tokens `--th-*` ou de classes utilitárias já usadas
// no restante do app, para funcionar nos 7 temas.
// ============================================================================

interface Props {
  open: boolean;
  onClose: () => void;
  isBoss: boolean;
  isElectron: boolean;
  /** Canal desktop: vive no estado do App (hook), não só no localStorage. */
  desktopEnabled: boolean;
  onToggleDesktop: (value: boolean) => void;
}

/** Interruptor compacto. Sem cor fixa — usa tokens do tema. */
function Switch({
  id,
  checked,
  onChange,
  disabled,
  title,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative h-[18px] w-[32px] flex-shrink-0 rounded-full border transition-colors duration-200 ${
        disabled
          ? "cursor-not-allowed border-[var(--th-line)]/40 bg-white/[0.03] opacity-40"
          : checked
            ? "cursor-pointer border-emerald-500/50 bg-emerald-500/25 hover:bg-emerald-500/35"
            : "cursor-pointer border-[var(--th-line)]/50 bg-white/[0.05] hover:bg-white/[0.09]"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[12px] w-[12px] rounded-full transition-all duration-200 ${
          checked ? "left-[17px] bg-emerald-300" : "left-[2px] bg-slate-500"
        }`}
      />
    </button>
  );
}

export default function NotificationSettingsModal({
  open,
  onClose,
  isBoss,
  isElectron,
  desktopEnabled,
  onToggleDesktop,
}: Props) {
  // Espelho local das preferências. A fonte da verdade continua sendo o
  // localStorage; este estado existe só para a UI reagir na hora.
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const { currentUser } = useAuth();
  const cloudSyncTimer = useRef<number | null>(null);
  // Estado da permissão de notificação do navegador/OS — feedback para o
  // usuário quando o navegador está bloqueando (antes era perda SILENCIOSA:
  // nada chegava, nem com o app aberto, sem nenhum aviso do porquê).
  const [desktopPermission, setDesktopPermission] = useState<"granted" | "denied" | "default">("granted");
  useEffect(() => {
    if (!open) return;
    if (typeof window !== "undefined" && "Notification" in window) {
      setDesktopPermission(window.Notification.permission === "granted" ? "granted"
        : window.Notification.permission === "denied" ? "denied"
        : "default");
    }
  }, [open]);
  // Espelha as preferências no Firestore (debounced) — o backend precisa
  // delas para os watchers de Bazaar/PT e para o gate de push. Silencioso.
  function scheduleCloudSync() {
    const uid = currentUser?.uid;
    if (!uid) return;
    if (cloudSyncTimer.current !== null) window.clearTimeout(cloudSyncTimer.current);
    cloudSyncTimer.current = window.setTimeout(() => {
      cloudSyncTimer.current = null;
      void syncNotificationPrefsToCloud(uid);
    }, 600);
  }
  useEffect(() => {
    return () => {
      if (cloudSyncTimer.current !== null) window.clearTimeout(cloudSyncTimer.current);
    };
  }, []);
  const [search, setSearch] = useState("");

  const groups = useMemo(() => getVisibleCategories(isBoss, isElectron), [isBoss, isElectron]);
  const visibleItems = useMemo(() => getVisiblePreferences(isBoss, isElectron), [isBoss, isElectron]);

  // (Re)carrega tudo do armazenamento sempre que o modal abre: o valor pode
  // ter mudado em outra aba ou por outro controle do app.
  useEffect(() => {
    if (!open) return;
    const next: Record<string, boolean> = {};
    for (const item of visibleItems) {
      next[item.storageKey] = readBooleanPref(item.storageKey);
      for (const child of item.children || []) {
        next[child.storageKey] = readBooleanPref(child.storageKey);
      }
    }
    for (const channel of NOTIFICATION_CHANNELS) {
      next[channel.storageKey] = readBooleanPref(channel.storageKey);
    }
    setPrefs(next);
    setSearch("");
  }, [open, visibleItems]);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  /** Grava a preferência e atualiza o espelho local. */
  function setPref(storageKey: string, value: boolean) {
    writeBooleanPref(storageKey, value);
    setPrefs(prev => ({ ...prev, [storageKey]: value }));
    scheduleCloudSync();
  }

  /** O canal desktop também precisa avisar o hook, que guarda o estado. */
  function setDesktop(value: boolean) {
    onToggleDesktop(value);
    setPrefs(prev => ({ ...prev, [NOTIFICATION_CHANNELS[0].storageKey]: value }));
    if (value) {
      // Liga desktop → pedir a permissão AQUI (clique = gesto do usuário, o
      // único contexto em que o navegador mostra o prompt de confiabilidade)
      // e registrar o token FCM assim que concedida. Sem isso, quem concedia
      // a permissão depois do login ficava SEM push até a sessão seguinte.
      void ensurePushRegistration(currentUser?.uid || "").then(permission => {
        setDesktopPermission(permission);
      });
    }
  }

  /** Filtro por texto: casa no nome, na descrição e nas sub-opções. */
  function matchesSearch(item: NotificationPreferenceItem): boolean {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    if (item.label.toLowerCase().includes(term)) return true;
    if (item.description.toLowerCase().includes(term)) return true;
    return (item.children || []).some(child => child.label.toLowerCase().includes(term));
  }

  /** Liga/desliga tudo que é opcional e está visível. */
  function setAll(value: boolean) {
    for (const item of visibleItems) {
      if (item.mandatory) continue;
      setPref(item.storageKey, value);
      for (const child of item.children || []) setPref(child.storageKey, value);
    }
  }

  const optionalItems = visibleItems.filter(item => !item.mandatory);
  const activeCount = optionalItems.filter(item => prefs[item.storageKey] !== false).length;

  return createPortal(
    <div className="app-modal-overlay fixed inset-0 z-[1300] flex items-center justify-center bg-black/75 backdrop-blur-sm">
      {/* `max-h-[88vh]` + `flex-col` deixam cabeçalho e rodapé fixos, com só o
          miolo rolando — mesmo padrão do BazaarBrowserModal. */}
      <div className="app-modal-frame app-modal-size-md app-modal-frame--scroll w-full max-w-lg rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-bg-raised)] shadow-2xl shadow-black/60">

        <div className="flex-shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--th-line)]/40">
          <div className="flex items-center gap-2 min-w-0">
            <BellRing size={16} className="text-red-400 flex-shrink-0" />
            <div className="min-w-0">
              <span className="block text-sm font-bold text-red-200 uppercase tracking-wider truncate">
                Configurar Notificações
              </span>
              <span className="block text-[10px] text-slate-500">
                {activeCount} de {optionalItems.length} ativas
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex-shrink-0"
            title="Fechar (Esc)"
          >
            <X size={15} />
          </button>
        </div>

        {/* Busca + atalhos de massa */}
        <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[var(--th-line)]/30">
          <div className="relative flex-1 min-w-0">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Buscar notificação..."
              className="w-full rounded-lg border border-[var(--th-line)]/40 bg-white/[0.03] pl-7 pr-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-red-500/40"
            />
          </div>
          <button
            type="button"
            onClick={() => setAll(true)}
            className="flex-shrink-0 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/20 transition-colors cursor-pointer"
            title="Ativar todas as notificações opcionais"
          >
            Ativar todas
          </button>
          <button
            type="button"
            onClick={() => setAll(false)}
            className="flex-shrink-0 rounded border border-[var(--th-line)]/50 bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-slate-400 hover:bg-white/[0.08] transition-colors cursor-pointer"
            title="Desativar todas as notificações opcionais"
          >
            <RotateCcw size={9} className="inline -mt-px mr-0.5" />
            Nenhuma
          </button>
        </div>

        {/* Miolo rolável */}
        <div className="app-modal-body custom-scrollbar px-4 py-3 space-y-3">

          {/* ── CANAIS DE ENTREGA ───────────────────────────────────────────
              Não são tipos de notificação: controlam COMO qualquer aviso
              chega. Vêm primeiro porque desligar o canal afeta todo o resto. */}
          <div className="rounded-lg border border-[var(--th-line)]/40 bg-white/[0.02] overflow-hidden">
            <div className="px-3 py-1.5 border-b border-[var(--th-line)]/30 bg-white/[0.02]">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-300">Como você recebe</span>
            </div>
            <div className="divide-y divide-white/[0.03]">
              {NOTIFICATION_CHANNELS.map(channel => {
                const isDesktop = channel.id === "desktop";
                const checked = isDesktop ? desktopEnabled : prefs[channel.storageKey] !== false;
                return (
                  <div key={channel.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <span className="block text-[11px] font-bold text-slate-200">{channel.label}</span>
                      <p className="text-[10px] leading-snug text-slate-500">{channel.description}</p>
                    </div>
                    <Switch
                      id={`channel-${channel.id}`}
                      checked={checked}
                      onChange={value => (isDesktop ? setDesktop(value) : setPref(channel.storageKey, value))}
                    />
                  </div>
                );
              })}
              {/* Permissão do navegador/OS bloqueando as notificações desktop?
                  Aviso DIRETO na linha do canal — sem isso a permissão negada
                  era uma perda silenciosa (nenhum aviso, nem com app aberto). */}
              {desktopEnabled && desktopPermission !== "granted" && (
                <div className="flex items-start gap-2 px-3 py-2 bg-amber-500/[0.06] border-t border-amber-500/20">
                  <AlertTriangle size={13} className="flex-shrink-0 mt-px text-amber-400" />
                  <p className="text-[10px] leading-snug text-amber-200/90">
                    {desktopPermission === "denied" ? (
                      <>O navegador está <strong>bloqueando</strong> as notificações deste site. Libere nas permissões do navegador (ícone 🔒 na barra de endereço) para recebê-las no desktop.</>
                    ) : (
                      <>A permissão de notificação ainda não foi concedida. Desligue e religue o canal <strong>Desktop</strong> acima para o navegador pedir a permissão.</>
                    )}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* ── CATEGORIAS ──────────────────────────────────────────────────
              `getVisibleCategories` já removeu as categorias sem item visível,
              então um usuário comum nunca vê o cabeçalho "Administrativas". */}
          {groups.map(({ category, items }) => {
            const filtered = items.filter(matchesSearch);
            // Busca sem resultado nesta categoria: não renderiza o bloco.
            if (filtered.length === 0) return null;
            return (
              <div key={category.id} className="rounded-lg border border-[var(--th-line)]/40 bg-white/[0.02] overflow-hidden">
                <div className="px-3 py-1.5 border-b border-[var(--th-line)]/30 bg-white/[0.02]">
                  <span className="text-[10px] font-black uppercase tracking-wider text-red-200">{category.label}</span>
                  <p className="text-[9px] leading-snug text-slate-600">{category.description}</p>
                </div>

                <div className="divide-y divide-white/[0.03]">
                  {filtered.map(item => {
                    const checked = prefs[item.storageKey] !== false;
                    return (
                      <div key={item.id} className="px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <span className="flex items-center gap-1.5">
                              <span className="text-[11px] font-bold text-slate-200">{item.label}</span>
                              {item.bossOnly && (
                                <span className="flex-shrink-0 text-[8px] font-black uppercase tracking-wider px-1 py-px rounded border border-amber-500/40 bg-amber-500/10 text-amber-300">
                                  boss
                                </span>
                              )}
                              {item.mandatory && (
                                <span className="flex-shrink-0 inline-flex items-center gap-0.5 text-[8px] font-black uppercase tracking-wider px-1 py-px rounded border border-slate-500/40 bg-slate-500/10 text-slate-400">
                                  <Lock size={7} /> obrigatória
                                </span>
                              )}
                            </span>
                            <p className="text-[10px] leading-snug text-slate-500">{item.description}</p>
                            {item.mandatory && item.mandatoryReason && (
                              <p className="mt-0.5 text-[9px] leading-snug text-slate-600 italic">{item.mandatoryReason}</p>
                            )}
                          </div>

                          {/* Obrigatória: cadeado no lugar do interruptor. */}
                          {item.mandatory ? (
                            <Lock size={13} className="flex-shrink-0 text-slate-600" />
                          ) : (
                            <Switch
                              id={`notif-${item.id}`}
                              checked={checked}
                              onChange={value => setPref(item.storageKey, value)}
                            />
                          )}
                        </div>

                        {/* Sub-opções (janelas do lembrete de PT). Somem quando
                            o pai está desligado — sem controle órfão. */}
                        {!item.mandatory && item.children && item.children.length > 0 && checked && (
                          <div className="mt-1.5 ml-2 pl-2 border-l border-[var(--th-line)]/30 space-y-1">
                            {item.children.map(child => (
                              <div key={child.id} className="flex items-center justify-between gap-3">
                                <span className="text-[10px] text-slate-400">{child.label}</span>
                                <Switch
                                  id={`notif-${item.id}-${child.id}`}
                                  checked={prefs[child.storageKey] !== false}
                                  onChange={value => setPref(child.storageKey, value)}
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Busca sem nenhum resultado em categoria alguma. */}
          {groups.every(({ items }) => items.filter(matchesSearch).length === 0) && (
            <p className="py-6 text-center text-[11px] text-slate-500">
              Nenhuma notificação encontrada para "{search}".
            </p>
          )}
        </div>

        <div className="app-modal-footer flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-t border-[var(--th-line)]/40">
          <p className="text-[9px] leading-snug text-slate-600">
            As preferências ficam salvas neste dispositivo e valem imediatamente.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1 text-[11px] font-bold text-red-200 hover:bg-red-500/20 transition-colors cursor-pointer"
          >
            Concluído
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}