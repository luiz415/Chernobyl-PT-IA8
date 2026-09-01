import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronDown, ExternalLink, History, Link2, Loader2, LogOut, Power, Sparkles, Unplug, X } from "lucide-react";
import type { BazaarInterestMap } from "../services/bazaarOfficialService";
import { parseBidAmount } from "../utils/bazaarBid";
import type { AutoBidConfig, AutoBidConnectionState, AutoBidItem, AutoBidMode, AutoBidRecord, AutoBidStatus } from "../autoBid/types";
import {
  AUTO_BID_MODES,
  addHistory,
  browserLabel,
  browsersForMode,
  loadBrowser,
  loadConfigs,
  loadHistory,
  loadMode,
  mergeWithOfficial,
  saveBrowser,
  saveConfigs,
  saveMode,
} from "../autoBid/store";
import { buildItems, isEnded } from "../autoBid/scheduler";
import { connectBrowser, disconnectBrowser, isElectronRuntime, onConnection, sessionState } from "../autoBid/ipc";
import { bumpConfigsRevision, bumpHistoryRevision, setAutoBidConnection, useAutoBidStore } from "../autoBid/engineStore";

// ============================================================================
// AUTO BID — modal (somente Electron + Boss)
// ----------------------------------------------------------------------------
// • Seleção de navegador (persistida).
// • Lista de personagens com Interesse (fonte: lista oficial + bazaarInterests).
// • Config por personagem: ativar/desativar, valor, segundos antes.
// • Quadro "Últimos Auto Bids" com o histórico recente.
//
// O agendamento roda no renderer e, no momento certo, chama o IPC que navega
// na URL oficial e confirma "Submit Bid" no navegador dedicado.
// ============================================================================

interface Props {
  open: boolean;
  onClose: () => void;
  characters: Array<{
    id: string;
    name: string;
    server: string;
    vocation: string;
    url: string;
    auctionEndTs: number | null;
  }>;
  interests: BazaarInterestMap;
  currentUserUid: string | null;
  bazaarVersion: string;
}

const CONNECTION_LABEL: Record<AutoBidConnectionState, string> = {
  desconectado: "Desconectado",
  conectando: "Conectando...",
  conectado: "Conectado",
  expirada: "Sessão expirada",
};

const STATUS_LABEL: Record<AutoBidStatus, string> = {
  configurado: "Configurado",
  aguardando: "Aguardando",
  executando: "Executando",
  concluido: "Concluído",
  falhou: "Falhou",
  cancelado: "Cancelado",
  desconectado: "Desconectado",
};

function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

function statusBadge(status: AutoBidStatus): string {
  switch (status) {
    case "concluido": return "bg-emerald-500/15 border-emerald-400/50 text-emerald-300";
    case "executando": return "bg-cyan-500/15 border-cyan-400/50 text-cyan-300";
    case "falhou": return "bg-rose-500/15 border-rose-400/50 text-rose-300";
    case "aguardando": return "bg-amber-500/15 border-amber-400/50 text-amber-300";
    case "desconectado": return "bg-orange-500/15 border-orange-400/50 text-orange-300";
    default: return "bg-white/5 border-white/15 text-slate-300";
  }
}

export default function AutoBidModal({ open, onClose, characters, interests, currentUserUid, bazaarVersion }: Props) {
  // Estado de conexão compartilhado com o engine (que roda em segundo plano).
  const store = useAutoBidStore();
  const connection = store.connection;
  const connectionDetail = store.detail;
  // Relê configs/histórico do localStorage sempre que o engine mudar algo.
  const [configs, setConfigs] = useState<AutoBidConfig[]>(() => loadConfigs());
  const [history, setHistory] = useState<AutoBidRecord[]>(() => loadHistory());
  const [connecting, setConnecting] = useState(false);
  const [mode, setMode] = useState<AutoBidMode>(() => loadMode() as AutoBidMode);
  // Navegadores aceitos pelo modo atual (CDP só aceita Chrome/Edge).
  const modeBrowsers = useMemo(() => browsersForMode(mode), [mode]);
  const [browser, setBrowser] = useState<string>(() => {
    const saved = loadBrowser();
    const valid = browsersForMode(loadMode() as AutoBidMode);
    return valid.some(b => b.key === saved) ? saved : (valid[0]?.key || "chrome");
  });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const persistTimerRef = useRef<number | null>(null);

  // Ao desmontar, faz FLUSH do debounce pendente (não descarta): persiste o
  // estado local mais recente para não perder edições/cancelamentos feitos
  // pouco antes de fechar o modal.
  const configsRef = useRef<AutoBidConfig[]>([]);
  useEffect(() => { configsRef.current = configs; }, [configs]);
  // Ao FECHAR o modal (open false), faz flush do debounce pendente — não
  // descarta edições feitas pouco antes de fechar.
  useEffect(() => {
    if (!open) return;
    return () => {
      if (persistTimerRef.current) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
        saveConfigs(configsRef.current);
        bumpConfigsRevision();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isElectron = isElectronRuntime();

  // ── Interesses do usuário atual (fonte oficial bazaarInterests) ─────────
  const interestedIds = useMemo(() => {
    const set = new Set<string>();
    Object.entries(interests || {}).forEach(([auctionKey, users]) => {
      if ((users || []).some(user => user.uid === currentUserUid)) set.add(String(auctionKey));
    });
    return set;
  }, [interests, currentUserUid]);

  // Personagens da lista oficial que o usuário marcou com Interesse.
  // Normaliza o id para String — a chave do `bazaarInterests` é sempre string.
  const official = useMemo(
    () => characters.filter(c => c.id && c.auctionEndTs && interestedIds.has(String(c.id))),
    [characters, interestedIds],
  );

  // Mescla configs salvas com a lista oficial (atualiza fim/nome/servidor).
  // `configs` é dependência — sem isso, digitar no campo de valor seria
  // sobrescrito pela versão antiga do memo (bug de digitação).
  const mergedConfigs = useMemo(
    () => mergeWithOfficial(configs, official, bazaarVersion),
    [configs, official, bazaarVersion],
  );

  // Relê configs/histórico quando o engine (ou este modal) os alterar.
  useEffect(() => {
    if (!open) return;
    setConfigs(loadConfigs());
    setHistory(loadHistory());
  }, [open, store.configsRevision, store.historyRevision]);

  // Itens de exibição, EXCLUINDO leilões já encerrados (não configuráveis).
  const items = useMemo(
    () => buildItems(mergedConfigs, nowMs, connection).filter(item => !isEnded(item.config, nowMs)),
    [mergedConfigs, nowMs, connection],
  );

  // ── Sincronização de estado e timer ──────────────────────────────────────
  useEffect(() => {
    if (!open || !isElectron) return;
    sessionState(mode, browser).then(state => {
      if (!state) return;
      if (state.status === "validada") setAutoBidConnection("conectado", "");
      else if (state.status === "expirada") setAutoBidConnection("expirada", "Sessão expirada.");
      else setAutoBidConnection("desconectado", "");
    }).catch(() => {});
  }, [open, isElectron, mode, browser]);

  useEffect(() => {
    if (!open || !isElectron) return;
    const unsubscribe = onConnection((event: any) => {
      if (event?.state) {
        setAutoBidConnection(event.state, event.detail || "");
      }
    });
    return unsubscribe;
  }, [open, isElectron]);

  useEffect(() => {
    if (!open) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [open]);

  // ── Ações ────────────────────────────────────────────────────────────────
  async function handleConnect() {
    if (!isElectron) return;
    setConnecting(true);
    try {
      const res = await connectBrowser(mode, browser);
      // Reflete imediatamente o estado retornado pela abertura.
      if (res && (res as any).status === "validada") setAutoBidConnection("conectado", "");
      else setAutoBidConnection("desconectado", "Navegador aberto. Faça o login na janela.");
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (!isElectron) return;
    await disconnectBrowser(mode, "usuario-solicitou");
    setAutoBidConnection("desconectado", "Desconectado pelo usuário.");
  }

  function handleModeChange(key: string) {
    saveMode(key);
    setMode(key as AutoBidMode);
    // Readequa o navegador ao modo (CDP só aceita Chrome/Edge).
    const valid = browsersForMode(key);
    setBrowser(prev => valid.some(b => b.key === prev) ? prev : (valid[0]?.key || "chrome"));
    // Trocar de modo exige reconexão.
    if (connection === "conectado" || connection === "expirada") {
      void disconnectBrowser(mode, "troca-de-modo").catch(() => {});
      setAutoBidConnection("desconectado", "");
    }
  }

  function handleBrowserChange(key: string) {
    saveBrowser(key);
    setBrowser(key);
    // Trocar de navegador exige reconexão: encerra a sessão atual se aberta.
    if (connection === "conectado" || connection === "expirada") {
      void disconnectBrowser(mode, "troca-de-navegador").catch(() => {});
      setAutoBidConnection("desconectado", "");
    }
  }

  function updateConfig(auctionId: string, patch: Partial<AutoBidConfig>) {
    // Atualiza o estado local IMEDIATAMENTE (digitação instantânea).
    setConfigs(prev => prev.map(c => c.auctionId === auctionId ? { ...c, ...patch } : c));

    // Desativar manualmente (cancelar) → PERSISTE IMEDIATAMENTE e registra no
    // histórico. Não pode ficar sujeito ao debounce: se o modal fechar antes,
    // o cancelamento seria perdido e o bid continuaria agendado.
    if (patch.active === false) {
      const current = configs.find(c => c.auctionId === auctionId);
      if (current?.active) {
        addHistory({
          auctionId,
          name: current.name,
          server: current.server,
          bidAmount: current.bidAmount,
          atMs: Date.now(),
          status: "cancelado",
          browser,
          detail: "Auto Bid desativado pelo usuário",
        });
        bumpHistoryRevision();
      }
      // Grava imediatamente (estado local já tem active:false acima).
      if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
      const next = configs.map(c => c.auctionId === auctionId ? { ...c, ...patch } : c);
      saveConfigs(next);
      bumpConfigsRevision();
      return;
    }

    // Persistência DEBOUNCED para os demais campos (valor, segundos): não grava
    // no localStorage nem avisa o engine a cada tecla — só após ~400ms de
    // inatividade. Persiste o estado local COMPLETO (para não perder edições
    // intermediárias). Isso mantém o input fluido.
    if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      setConfigs(prev => {
        saveConfigs(prev);
        bumpConfigsRevision();
        return prev;
      });
    }, 400);
  }

  /** Cancela o agendamento de um Bid já configurado (desativa). */
  function cancelSchedule(auctionId: string) {
    updateConfig(auctionId, { active: false });
  }

  function openCharacter(url: string) {
    if (!url) return;
    try {
      const electronRequire = (window as any).require;
      if (electronRequire) {
        const { shell } = electronRequire("electron");
        shell.openExternal(url);
        return;
      }
    } catch {}
    window.open(url, "_blank", "noopener,noreferrer");
  }

  if (!open) return null;
  if (!isElectron) {
    return createPortal(
      <div className="app-modal-overlay fixed inset-0 z-[1200] flex items-center justify-center bg-black/85">
        <div className="app-modal-frame app-modal-size-sm rounded-2xl border border-[var(--th-line)]/70 bg-[var(--th-bg-base)] p-4 sm:p-6 text-center">
          <p className="text-sm text-slate-300">Auto Bid está disponível somente no aplicativo de desktop (Electron).</p>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[1200] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Auto Bid no Bazaar"
        className="app-modal-frame app-modal-size-xl app-modal-frame--scroll relative w-full max-w-3xl rounded-2xl border border-[var(--th-line)]/100 bg-[var(--th-bg-base)] shadow-2xl shadow-black/70"
      >
        {/* ── Cabeçalho ─────────────────────────────────────────────────── */}
        <div className="flex flex-shrink-0 items-start justify-between gap-3 border-b border-[var(--th-line)]/70 bg-gradient-to-r from-[var(--th-bg-raised)] via-[var(--th-bg-base)] to-[var(--th-bg-raised)] px-4 py-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-black tracking-wide text-amber-200">
              <Sparkles size={16} className="flex-shrink-0 text-amber-300" />
              Auto Bid
            </h2>
            <p className="mt-0.5 text-[11px] leading-snug text-slate-400">
              Lance automático nos personagens em que você marcou interesse.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Fechar (Esc)"
            aria-label="Fechar Auto Bid"
            className="flex-shrink-0 cursor-pointer rounded-md p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
          >
            <X size={16} />
          </button>
        </div>

        {/* ── Barra de conexão + navegador ──────────────────────────────── */}
        <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--th-line)]/60 bg-[var(--th-n-base)] px-4 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-black ${
                connection === "conectado"
                  ? "border-emerald-400/50 bg-emerald-500/10 text-emerald-300"
                  : connection === "expirada"
                    ? "border-rose-400/50 bg-rose-500/10 text-rose-300"
                    : "border-orange-400/40 bg-orange-500/10 text-orange-300"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${connection === "conectado" ? "bg-emerald-400" : connection === "expirada" ? "bg-rose-400" : "bg-orange-400"}`} />
              {CONNECTION_LABEL[connection]}
            </span>
            {/* Seleção de modo (isolado para testes) */}
            <label className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--th-line)]/60 bg-black/25 px-2 py-1">
              <span className="text-[10px] font-bold text-slate-500">Modo</span>
              <span className="relative inline-flex items-center">
                <select
                  value={mode}
                  onChange={e => handleModeChange(e.target.value)}
                  className="appearance-none cursor-pointer rounded border border-white/10 bg-white/5 py-0.5 pl-2 pr-6 text-[11px] font-black text-amber-300 outline-none transition-colors hover:bg-white/10 focus:border-amber-500/60"
                  aria-label="Modo do Auto Bid"
                >
                  {AUTO_BID_MODES.map(m => (
                    <option key={m.key} value={m.key} className="bg-[var(--th-bg-base)] text-slate-200">{m.label}</option>
                  ))}
                </select>
                <ChevronDown size={12} className="pointer-events-none absolute right-1.5 text-slate-400" />
              </span>
            </label>
            {/* Seleção de navegador */}
            <label className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--th-line)]/60 bg-black/25 px-2 py-1">
              <span className="text-[10px] font-bold text-slate-500">Navegador</span>
              <span className="relative inline-flex items-center">
                <select
                  value={browser}
                  onChange={e => handleBrowserChange(e.target.value)}
                  className="appearance-none cursor-pointer rounded border border-white/10 bg-white/5 py-0.5 pl-2 pr-6 text-[11px] font-black text-slate-200 outline-none transition-colors hover:bg-white/10 focus:border-amber-500/60"
                  aria-label="Navegador do Auto Bid"
                >
                  {modeBrowsers.map(b => (
                    <option key={b.key} value={b.key} className="bg-[var(--th-bg-base)] text-slate-200">{b.label}</option>
                  ))}
                </select>
                <ChevronDown size={12} className="pointer-events-none absolute right-1.5 text-slate-400" />
              </span>
            </label>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            {connection === "conectado" ? (
              <button
                type="button"
                onClick={handleDisconnect}
                className="inline-flex items-center gap-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 py-1.5 text-[11px] font-black text-orange-300 transition-colors hover:bg-orange-500/20 cursor-pointer"
              >
                <LogOut size={13} /> Desconectar
              </button>
            ) : (
              <button
                type="button"
                onClick={handleConnect}
                disabled={connecting}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-[11px] font-black text-emerald-200 transition-colors hover:bg-emerald-500/25 cursor-pointer disabled:opacity-60"
              >
                {connecting ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
                {connecting ? "Abrindo..." : "Abrir navegador / Conectar"}
              </button>
            )}
          </div>
        </div>

        {connectionDetail && (
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--th-line)]/40 bg-orange-500/[0.06] px-4 py-1.5">
            <AlertTriangle size={11} className="flex-shrink-0 text-orange-300" />
            <span className="truncate text-[10px] text-orange-200/80">{connectionDetail}</span>
          </div>
        )}

        {/* ── Lista de personagens com interesse (leilões ativos) ───────── */}
        <div className="app-modal-body auto-bid-scroll px-4 py-3">
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-10 text-center">
              <Unplug size={22} className="text-slate-500" />
              <p className="text-[12px] text-slate-400">
                Nenhum personagem com interesse e leilão ativo para configurar.
                Marque "Tenho interesse" em personagens do Bazaar para habilitá-los aqui.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {items.map(item => (
                <AutoBidRow
                  key={item.config.auctionId}
                  item={item}
                  connection={connection}
                  nowMs={nowMs}
                  onUpdate={updateConfig}
                  onCancel={cancelSchedule}
                  onOpen={openCharacter}
                />
              ))}
            </div>
          )}

          {/* ── Últimos Auto Bids ──────────────────────────────────────── */}
          <div className="mt-4">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wide text-amber-200/90">
              <History size={13} className="text-amber-300" /> Últimos Auto Bids
            </div>
            {history.length === 0 ? (
              <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-3 text-center text-[10px] text-slate-500">
                Nenhuma tentativa registrada ainda.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-[var(--th-line)]/50">
                <table className="w-full text-left text-[10px]">
                  <thead className="bg-black/25 text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5 font-black">Personagem</th>
                      <th className="px-2 py-1.5 font-black">Servidor</th>
                      <th className="px-2 py-1.5 font-black text-right">Valor</th>
                      <th className="px-2 py-1.5 font-black">Horário</th>
                      <th className="px-2 py-1.5 font-black">Navegador</th>
                      <th className="px-2 py-1.5 font-black">Resultado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--th-line)]/30">
                    {history.map((rec, index) => (
                      <tr key={`${rec.auctionId}_${rec.atMs}_${index}`} className="bg-white/[0.02] hover:bg-white/[0.05]">
                        <td className="px-2 py-1.5 font-bold text-slate-200">{rec.name}</td>
                        <td className="px-2 py-1.5 text-slate-400">{rec.server}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-amber-300">{rec.bidAmount}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-400">{formatTime(rec.atMs)}</td>
                        <td className="px-2 py-1.5 text-slate-400">{browserLabel(rec.browser)}</td>
                        <td className="px-2 py-1.5">
                          <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-black ${statusBadge(rec.status)}`} title={rec.detail}>
                            {rec.status === "concluido" && <Check size={9} />}
                            {rec.status === "falhou" && <AlertTriangle size={9} />}
                            {STATUS_LABEL[rec.status] || rec.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* ── Rodapé ───────────────────────────────────────────────────── */}
        <div className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-[var(--th-line)]/70 bg-[var(--th-bg-raised)] px-4 py-2">
          <span className="text-[10px] font-semibold text-slate-500">
            {items.filter(i => i.config.active && i.status !== "concluido" && i.status !== "cancelado").length} Auto Bid(s) ativos
          </span>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-[var(--th-line)]/100 px-3 py-1 text-[11px] font-bold text-slate-300 transition-colors hover:bg-[var(--th-line)]/20 hover:text-white"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ============================================================================
// Linha de personagem
// ============================================================================
function AutoBidRow({ item, connection, nowMs, onUpdate, onCancel, onOpen }: {
  item: AutoBidItem;
  connection: AutoBidConnectionState;
  nowMs: number;
  onUpdate: (auctionId: string, patch: Partial<AutoBidConfig>) => void;
  onCancel: (auctionId: string) => void;
  onOpen: (url: string) => void;
}) {
  const { config, status } = item;
  const ended = isEnded(config, nowMs);
  const fireAt = item.msUntilFire;
  const firePassed = fireAt <= 0;
  const amountValid = parseBidAmount(String(config.bidAmount)) !== null;
  const connected = connection === "conectado";

  return (
    <div
      className={`rounded-xl border p-3 transition-colors ${
        config.active && connected && !ended
          ? "border-amber-500/40 bg-amber-500/[0.06]"
          : "border-[var(--th-line)]/50 bg-[var(--th-n-base)]/60"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-white/5 border border-white/10 text-[13px] font-black text-slate-300">
            {config.vocation}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onOpen(config.url)}
                className="truncate text-[13px] font-black text-slate-100 hover:text-amber-300 transition-colors cursor-pointer"
                title={config.url || config.name}
              >
                {config.name}
              </button>
              {config.url && <ExternalLink size={11} className="flex-shrink-0 text-slate-500" />}
            </div>
            <div className="truncate text-[10px] text-slate-400">
              {config.server} • encerra em <span className="font-mono text-slate-300">{formatCountdown(item.msUntilEnd)}</span>
            </div>
          </div>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-black ${statusBadge(status)}`}>
          {status === "executando" && <Loader2 size={10} className="animate-spin" />}
          {status === "concluido" && <Check size={10} />}
          {status === "falhou" && <AlertTriangle size={10} />}
          {STATUS_LABEL[status]}
        </span>
      </div>

      {/* Controles */}
      <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="col-span-1 flex flex-col gap-1">
          <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500">Valor (moedas)</span>
          <input
            type="text"
            inputMode="numeric"
            value={config.bidAmount ? String(config.bidAmount) : ""}
            onChange={e => onUpdate(config.auctionId, { bidAmount: Number(String(e.target.value).replace(/\D+/g, "")) || 0 })}
            placeholder="Ex: 477"
            className={`h-8 rounded-lg border bg-[var(--th-bg)]/60 px-2 text-center text-[12px] font-black text-[var(--th-text)] outline-none transition-colors placeholder:font-bold placeholder:text-slate-600 focus:border-amber-500/60 ${amountValid ? "border-emerald-500/40" : "border-[var(--th-line)]/60"}`}
          />
        </label>
        <label className="col-span-1 flex flex-col gap-1">
          <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500">Segs antes</span>
          <input
            type="number"
            min={1}
            max={3600}
            value={config.secondsBefore || ""}
            onChange={e => onUpdate(config.auctionId, { secondsBefore: Math.max(1, Number(e.target.value) || 15) })}
            placeholder="15"
            className="h-8 rounded-lg border border-[var(--th-line)]/60 bg-[var(--th-bg)]/60 px-2 text-center text-[12px] font-black text-[var(--th-text)] outline-none transition-colors placeholder:font-bold placeholder:text-slate-600 focus:border-amber-500/60"
          />
        </label>
        <div className="col-span-1 flex items-end">
          <button
            type="button"
            onClick={() => onUpdate(config.auctionId, { active: !config.active })}
            disabled={!amountValid || ended || status === "concluido"}
            className={`inline-flex h-8 w-full items-center justify-center gap-1 rounded-lg border text-[11px] font-black transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
              config.active
                ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                : "border-[var(--th-line)]/60 bg-white/[0.03] text-slate-300 hover:bg-white/[0.07]"
            }`}
          >
            <Power size={12} /> {config.active ? "Ativo" : "Ativar"}
          </button>
        </div>
        <div className="col-span-1 flex flex-col items-end gap-1">
          <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500">Disparo</span>
          <span className={`h-8 inline-flex items-center rounded-lg px-2 text-[11px] font-black tabular-nums ${firePassed ? "text-amber-300" : "text-slate-300"}`}>
            {ended ? "Encerrado" : formatCountdown(item.msUntilFire)}
          </span>
        </div>
      </div>

      {config.active && !ended && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => onCancel(config.auctionId)}
            className="inline-flex h-7 items-center justify-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 text-[10px] font-black text-rose-300 transition-colors hover:bg-rose-500/20 cursor-pointer"
            title="Cancela o agendamento deste Auto Bid"
          >
            <X size={11} /> Cancelar Agendamento
          </button>
        </div>
      )}

      {config.lastResult && (
        <div className="mt-2 text-[10px] text-slate-500" title={config.lastResult}>{config.lastResult}</div>
      )}
    </div>
  );
}