import { useMemo, useState, useEffect } from "react";
import { Copy, CheckCircle2, Heart, Trophy, Coins, Send, X, Swords } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { db, isSimulationMode, setDoc, updateDoc } from "../firebase/config";
import { collection, doc, increment } from "firebase/firestore";
import { formatRC } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  minAverage?: number;
}

type Tab = "donation" | "rankings";

interface RankingEntry {
  uid: string;
  userName: string;
  total: number;
  ptCount: number;
  average: number;
}

// Lucro médio estimado de uma PT concluída, usado para expressar a Média
// Mínima como percentual do lucro do usuário.
const AVERAGE_PT_PROFIT_RC = 1000;

/**
 * Média Mínima expressa como % do lucro médio por PT.
 * Ex.: 5 RC -> "0.5%" | 10 RC -> "1%" | 15 RC -> "1.5%"
 * Casas decimais desnecessárias são removidas (1.0% vira 1%).
 */
function formatMinAveragePercent(minAverage: number): string {
  const pct = (minAverage / AVERAGE_PT_PROFIT_RC) * 100;
  return `${Number(pct.toFixed(2))}%`;
}

const DONATION_STATS_CACHE_KEY = "donation_modal_userStats_cache";
const DONATION_STATS_CACHE_TS_KEY = "donation_modal_userStats_cache_ts";
const DONATION_STATS_CACHE_TTL_MS = 10 * 60 * 1000;

export default function DonationModal({ open, onClose, minAverage = 10 }: Props) {
  const { userProfile, allUsers } = useAuth();
  const isBoss = userProfile?.role === "Boss";
  const [activeTab, setActiveTab] = useState<Tab>("donation");
  const [amount, setAmount] = useState("25");
  const [fromCharacter, setFromCharacter] = useState("");
  const [donationDate, setDonationDate] = useState(todayISO());
  const [copied, setCopied] = useState(false);
  const [success, setSuccess] = useState(false);
  const [errors, setErrors] = useState<{ amount?: string; fromCharacter?: string }>({});

  // Dados do Firestore
  const [donationChar, setDonationChar] = useState<string>("");
  // Mapa uid -> { totalPtsConcluidas, totalRcDoado, totalRcDoadoAprovado } vindo de userStats
  const [userStatsMap, setUserStatsMap] = useState<Record<string, { totalPtsConcluidas: number; totalRcDoado: number; totalRcDoadoAprovado: number }>>({});

  // A base global limita o viewport e preserva fonte/campos em vez de
  // diminuir o conteúdo via transform.

  // ============================================================================
  // OPTIMIZAÇÃO: Usar allUsers do AuthContext em vez de listener duplicado
  // ============================================================================
  const userNamesMap = useMemo(() => {
    const map: Record<string, string> = {};
    allUsers.filter(u => u.status === "aprovado").forEach(u => {
      map[u.uid] = u.nome || "Anônimo";
    });
    return map;
  }, [allUsers]);

  // ============================================================================
  // OPTIMIZAÇÃO: Cache para donation_settings em vez de listener permanente
  // ============================================================================
  useEffect(() => {
    if (!open) return;

    if (isSimulationMode || !db) {
      try {
        const char = localStorage.getItem("chernobyl_donation_char") || "";
        setDonationChar(char);
      } catch {
        setDonationChar("");
      }
      return;
    }

    // Carregar do Firestore apenas quando o modal abre (cache sob demanda)
    const loadDonationChar = async () => {
      try {
        const { getDoc } = await import("firebase/firestore");
        const docSnap = await getDoc(doc(db, "settings", "donation_settings"));
        if (docSnap.exists()) {
          const data = docSnap.data();
          setDonationChar(data.donationCharacter || data.characterName || "");
          // Salvar no cache local
          localStorage.setItem("chernobyl_donation_char", data.donationCharacter || data.characterName || "");
        } else {
          setDonationChar("");
        }
      } catch {
        // Fallback para cache local
        try {
          const cached = localStorage.getItem("chernobyl_donation_char") || "";
          setDonationChar(cached);
        } catch {
          setDonationChar("");
        }
      }
    };

    loadDonationChar();
  }, [open]);

  // ============================================================================
  // OPTIMIZAÇÃO: userStats sob demanda + cache temporário
  // ============================================================================
  // O ranking só é necessário na aba "Ranking" do modal. Evitamos ler toda a
  // coleção userStats quando o usuário abre o modal apenas para doar.
  useEffect(() => {
    if (!open || activeTab !== "rankings") return;
    if (isSimulationMode || !db) {
      setUserStatsMap({});
      return;
    }

    function readStatsCache(): Record<string, { totalPtsConcluidas: number; totalRcDoado: number; totalRcDoadoAprovado: number }> | null {
      try {
        const raw = localStorage.getItem(DONATION_STATS_CACHE_KEY);
        const ts = parseInt(localStorage.getItem(DONATION_STATS_CACHE_TS_KEY) || "0", 10) || 0;
        if (!raw || !ts || Date.now() - ts > DONATION_STATS_CACHE_TTL_MS) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }

    function saveStatsCache(map: Record<string, { totalPtsConcluidas: number; totalRcDoado: number; totalRcDoadoAprovado: number }>) {
      try {
        localStorage.setItem(DONATION_STATS_CACHE_KEY, JSON.stringify(map));
        localStorage.setItem(DONATION_STATS_CACHE_TS_KEY, String(Date.now()));
      } catch {}
    }

    const cached = readStatsCache();
    if (cached) {
      setUserStatsMap(cached);
      return;
    }

    const loadUserStats = async () => {
      try {
        const { getDocs } = await import("firebase/firestore");
        const snapshot = await getDocs(collection(db, "userStats"));
        const map: Record<string, { totalPtsConcluidas: number; totalRcDoado: number; totalRcDoadoAprovado: number }> = {};
        snapshot.docs.forEach(d => {
          const data = d.data();
          map[d.id] = {
            totalPtsConcluidas: typeof data.totalPtsConcluidas === "number" ? data.totalPtsConcluidas : 0,
            totalRcDoado: typeof data.totalRcDoado === "number" ? data.totalRcDoado : 0,
            totalRcDoadoAprovado: typeof data.totalRcDoadoAprovado === "number" ? data.totalRcDoadoAprovado : 0,
          };
        });
        saveStatsCache(map);
        setUserStatsMap(map);
      } catch {
        setUserStatsMap({});
      }
    };

    loadUserStats();
  }, [open, activeTab]);

  // Ranking oficial — usa o campo totalRcDoadoAprovado de userStats/{uid}
  // (Valor Aprovado). ptCount (totalPtsConcluidas) vem do mesmo documento.
  // Este ranking é exclusivo para exibição no DonationModal e NÃO deve ser
  // confundido com a média do AdviceDonationModal (que usa userStats/totalRcDoado).
  const approvedRanking = useMemo(() => {
    const list: RankingEntry[] = [];

    Object.entries(userStatsMap).forEach(([uid, stats]) => {
      const ptCount = stats?.totalPtsConcluidas || 0;
      const nome = userNamesMap[uid] || `Jogador ${uid.slice(0, 6)}`;
      const totalRcAprovado = stats?.totalRcDoadoAprovado || 0;

      // Só inclui usuários que têm PTs concluídas ou doações aprovadas
      if (ptCount <= 0 && totalRcAprovado <= 0) return;

      list.push({
        uid,
        userName: nome,
        total: totalRcAprovado,
        ptCount,
        average: ptCount > 0 ? totalRcAprovado / ptCount : 0,
      });
    });

    // Ordenar do maior para o menor valor da média (Média de RC por PT é a principal métrica)
    return list.sort((a, b) =>
      b.average - a.average ||
      b.total - a.total ||
      b.ptCount - a.ptCount ||
      a.userName.localeCompare(b.userName, "pt-BR")
    );
  }, [userStatsMap, userNamesMap]);

  // Visibilidade do ranking por cargo: Boss vê todos; demais veem apenas o top 3
  const visibleRanking = useMemo(() => {
    return isBoss ? approvedRanking : approvedRanking.slice(0, 3);
  }, [approvedRanking, isBoss]);

  if (!open) return null;

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function resetForm() {
    setAmount("25");
    setFromCharacter("");
    setDonationDate(todayISO());
    setErrors({});
    setSuccess(false);
    setCopied(false);
  }

  function handleClose() {
    resetForm();
    setActiveTab("donation");
    onClose();
  }

  function validate() {
    const next: { amount?: string; fromCharacter?: string } = {};
    const parsedAmount = parseInt(amount, 10);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) next.amount = "Informe uma quantidade válida maior que 0.";
    if (!fromCharacter.trim()) next.fromCharacter = "Informe o personagem que enviou as RC's.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function handleCopyDonationChar() {
    if (!donationChar) return;

    // Função auxiliar para exibir feedback de sucesso
    function onCopySuccess() {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }

    // Função auxiliar para fallback via execCommand (browsers antigos ou contextos inseguros)
    function fallbackCopyText(text: string): boolean {
      const textArea = document.createElement("textarea");
      textArea.value = text;

      // Evita scroll e mantém o elemento invisível
      textArea.style.position = "fixed";
      textArea.style.top = "0";
      textArea.style.left = "0";
      textArea.style.width = "2em";
      textArea.style.height = "2em";
      textArea.style.padding = "0";
      textArea.style.border = "none";
      textArea.style.outline = "none";
      textArea.style.boxShadow = "none";
      textArea.style.background = "transparent";
      textArea.style.opacity = "0";
      textArea.style.pointerEvents = "none";

      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();

      let success = false;
      try {
        success = document.execCommand("copy");
      } catch {
        success = false;
      }

      document.body.removeChild(textArea);
      return success;
    }

    // Verifica se a API Clipboard está disponível e se estamos em contexto seguro
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function" && window.isSecureContext) {
      navigator.clipboard.writeText(donationChar)
        .then(() => {
          onCopySuccess();
        })
        .catch(() => {
          // Clipboard API falhou (permissão negada, foco perdido, etc.) — tenta fallback
          if (fallbackCopyText(donationChar)) {
            onCopySuccess();
          }
          // Se fallback também falhar, não exibe feedback (cópia realmente não funcionou)
        });
    } else {
      // Clipboard API não disponível — usa fallback diretamente
      if (fallbackCopyText(donationChar)) {
        onCopySuccess();
      }
    }
  }

  async function handleSubmit() {
    if (!validate()) return;
    if (!userProfile) return;

    const parsedAmount = parseInt(amount, 10);
    const nextDonation = {
      id: `don_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
      userId: userProfile.uid || "",
      userName: userProfile.nome || "Anônimo",
      userEmail: userProfile.email || "",
      amount: parsedAmount,
      fromCharacter: fromCharacter.trim(),
      toCharacter: donationChar || "A definir",
      donationDate,
      createdAt: new Date().toISOString(),
      status: "pendente",
    };

    if (isSimulationMode || !db) {
      // Modo offline: salvar no localStorage
      try {
        const raw = localStorage.getItem("chernobyl_donations");
        const list = raw ? JSON.parse(raw) : [];
        list.unshift(nextDonation);
        localStorage.setItem("chernobyl_donations", JSON.stringify(list));
        window.dispatchEvent(new Event("storage"));
      } catch {}
      setSuccess(true);
      window.setTimeout(() => {
        handleClose();
      }, 1400);
      return;
    }

    try {
      await setDoc(doc(db, "donations", nextDonation.id), nextDonation);

      // Atualizar userStats/{uid} com o valor doado (incremento atômico).
      // Reutiliza a mesma coleção/arquitetura do sistema de Ranking:
      //   - totalRcDoado: acumulado total de RC já doado pelo usuário
      // O campo totalPtsConcluidas já é mantido por commitPartyStats (App.tsx).
      if (userProfile?.uid) {
        try {
          await updateDoc(doc(db, "userStats", userProfile.uid), {
            totalRcDoado: increment(parsedAmount),
          });
        } catch {
          // Se o documento userStats/{uid} ainda não existir (usuário nunca
          // concluiu uma PT), cria com setDoc + merge para não sobrescrever
          // campos futuros gravados por commitPartyStats.
          try {
            await setDoc(doc(db, "userStats", userProfile.uid), {
              totalRcDoado: parsedAmount,
            }, { merge: true });
          } catch {}
        }
      }

      setSuccess(true);
      window.setTimeout(() => {
        handleClose();
      }, 1400);
    } catch {
      // Silencioso
    }
  }

  function rankingRowClass(index: number) {
    if (index === 0) return "border-amber-500/35 bg-amber-500/[0.07]";
    if (index === 1) return "border-slate-400/25 bg-slate-400/[0.05]";
    if (index === 2) return "border-orange-500/30 bg-orange-500/[0.06]";
    return "border-[var(--th-line)]/30 bg-[var(--th-line)]/[0.04]";
  }

  function rankingIcon(index: number) {
    if (index === 0) return <Trophy size={14} className="text-amber-400" />;
    if (index === 1) return <Trophy size={14} className="text-slate-300" />;
    if (index === 2) return <Trophy size={14} className="text-orange-400" />;
    return <Heart size={14} className="text-slate-600" />;
  }

  return (
    <div className="app-modal-overlay fixed inset-0 z-[350] flex items-center justify-center bg-black/80 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div
        className="app-modal-frame app-modal-size-xl app-modal-frame--scroll relative w-full max-w-3xl bg-[var(--th-n-base)] border border-[var(--th-line)]/100 rounded-2xl shadow-[0_0_40px_color-mix(in_oklab,var(--th-brand)_30%,transparent)]"
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--th-line)]/60 bg-gradient-to-r from-[var(--th-bg-base)] to-[var(--th-n-base)] flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-600/35 flex items-center justify-center shadow-[0_0_8px_color-mix(in_oklab,var(--color-amber-500)_12%,transparent)]">
              <Heart size={16} className="text-amber-400" />
            </div>
            <h3 className="text-base font-bold text-white tracking-wide">🤝 Colaborar com o Projeto</h3>
          </div>
          <button onClick={handleClose} className="text-slate-500 hover:text-white p-1.5 rounded-lg hover:bg-[var(--th-line)]/25 transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 border-b border-[var(--th-line)]/60 bg-[var(--th-n-deep)] text-xs text-slate-300 leading-relaxed flex-shrink-0 flex flex-col items-center text-center gap-3">
          <div className="bg-[var(--th-bg-base)] border border-amber-500/30 rounded-xl px-6 py-2.5 shadow-[0_0_15px_color-mix(in_oklab,var(--color-amber-500)_8%,transparent)]">
            <span className="text-sm font-black text-amber-300 uppercase tracking-wider">Média Mínima: {formatRC(minAverage)} / PT</span>
          </div>
          <p className="max-w-xl text-slate-400">
            O Chernobyl PT possui custos para manter os servidores, sincronização na nuvem e receber atualizações constantes. Sua contribuição ajuda a manter o projeto online e evoluindo.
          </p>
          <div className="bg-violet-550/10 border border-violet-500/30 px-4 py-1.5 rounded-lg text-violet-300 font-medium text-[11px]">
            🚀 O <strong>Painel Bazaar</strong> já está disponível para usuários VIP, com lista oficial organizada, filtros de busca, horários de encerramento, interesses e alertas de leilões. Sua contribuição mantém a infraestrutura ativa e impulsiona novas melhorias.
          </div>
          <p className="text-slate-300 font-bold text-[11px] mt-1">
            Para continuar acessando o aplicativo, contribua mantendo uma média mínima de <span className="text-amber-300 font-black">{formatRC(minAverage)}</span> por PT concluída, esse valor é menos que <span className="text-amber-300 font-black">{formatMinAveragePercent(minAverage)}</span> da média do seu lucro por PT.
          </p>
        </div>

        <div className="flex bg-[var(--th-n-deep)] border-b border-[var(--th-line)]/60 p-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab("donation")}
            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer ${activeTab === "donation" ? "bg-gradient-to-r from-amber-900/30 to-amber-800/20 border border-amber-700/40 text-amber-200 shadow-[0_0_10px_color-mix(in_oklab,var(--color-amber-500)_12%,transparent)]" : "text-slate-500 hover:bg-[var(--th-line)]/15 hover:text-slate-300"}`}
          >
            <Coins size={14} /> Doação
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("rankings")}
            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer ${activeTab === "rankings" ? "bg-gradient-to-r from-[var(--th-line-subtle)]/60 to-[var(--th-line)]/40 border border-[var(--th-brand)]/50 text-red-200 shadow-[0_0_10px_color-mix(in_oklab,var(--th-brand)_15%,transparent)]" : "text-slate-500 hover:bg-[var(--th-line)]/15 hover:text-slate-300"}`}
          >
            <Trophy size={14} /> Rankings
          </button>
        </div>

        {success ? (
          <div className="flex flex-col items-center justify-center py-14 px-6 gap-3">
            <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center animate-in zoom-in duration-300 shadow-[0_0_20px_rgba(16,185,129,0.15)]">
              <CheckCircle2 size={28} className="text-emerald-400" />
            </div>
            <h4 className="text-lg font-bold text-white">Doação registrada com sucesso!</h4>
            <p className="text-sm text-slate-500 text-center max-w-xs">A sua colaboração foi enviada para validação do fundador.</p>
          </div>
        ) : activeTab === "donation" ? (
          <div className="app-modal-body p-4 sm:p-5 space-y-4">
            <div>
              <label className="block text-[10px] text-red-400/80 uppercase tracking-wider mb-1.5 font-bold">Nome do personagem para enviar as coins</label>
              {donationChar ? (
                <button
                  type="button"
                  onClick={handleCopyDonationChar}
                  className="w-full flex items-center justify-between gap-3 bg-gradient-to-r from-[var(--th-line-subtle)]/60 to-[var(--th-n-base)] border border-[var(--th-brand)]/60 rounded-lg px-4 py-3 text-left text-white hover:border-[var(--th-brand)]/80 hover:from-[var(--th-line)]/50 transition-all cursor-pointer group shadow-[inset_0_1px_12px_color-mix(in_oklab,var(--th-brand)_8%,transparent)]"
                >
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="truncate text-base font-bold text-amber-300 drop-shadow-sm">{donationChar}</span>
                    {!copied && <span className="text-[10px] font-medium text-red-400/50 group-hover:text-amber-400/80 transition-colors uppercase tracking-widest flex-shrink-0 mb-0.5">• Clique para copiar</span>}
                  </div>
                  <span className={`text-[10px] font-black uppercase tracking-wider flex-shrink-0 flex items-center gap-1.5 ${copied ? "text-emerald-400" : "text-amber-400 group-hover:scale-110 transition-transform"}`}>
                    {copied ? "Copiado!" : <Copy size={15} />}
                  </span>
                </button>
              ) : (
                <div className="w-full flex items-center justify-between gap-3 bg-black/40 border border-[var(--th-line)]/80 rounded-lg px-3 py-2 text-slate-600">
                  <span>A definir pelo administrador</span>
                  <span className="text-[10px] text-slate-700">—</span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] text-red-400/80 uppercase tracking-wider mb-1.5 font-bold">Quantidade enviada (RC's)</label>
                <div className="relative">
                  <input
                    type="number"
                    min={0}
                    step={25}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
                    className={`w-full bg-black/40 border rounded-lg pl-3 pr-8 py-2 text-white focus:outline-none text-sm transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${errors.amount ? "border-rose-500/60 focus:border-rose-500" : "border-[var(--th-line)]/50 focus:border-red-700/60"}`}
                  />
                  <div className="absolute right-1 top-1 bottom-1 flex flex-col justify-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => setAmount(String((parseInt(amount || "0", 10) + 25)))}
                      className="w-5 h-3 flex items-center justify-center bg-[var(--th-line)]/50 hover:bg-[var(--th-brand)]/50 text-amber-300 rounded-[2px] transition-colors"
                    >
                      <svg width="8" height="6" viewBox="0 0 8 6" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 1L7.4641 5.5H0.535898L4 1Z" fill="currentColor"/></svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => setAmount(String(Math.max(0, parseInt(amount || "0", 10) - 25)))}
                      className="w-5 h-3 flex items-center justify-center bg-[var(--th-line)]/50 hover:bg-[var(--th-brand)]/50 text-amber-300 rounded-[2px] transition-colors"
                    >
                      <svg width="8" height="6" viewBox="0 0 8 6" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 5L0.535898 0.5L7.4641 0.5L4 5Z" fill="currentColor"/></svg>
                    </button>
                  </div>
                </div>
                {errors.amount && <div className="text-[10px] text-rose-400 mt-1">{errors.amount}</div>}
              </div>
              <div>
                <label className="block text-[10px] text-red-400/80 uppercase tracking-wider mb-1.5 font-bold">Seu nome</label>
                <input
                  type="text"
                  value={userProfile?.nome || ""}
                  readOnly
                  disabled
                  className="w-full bg-black/40 border border-[var(--th-line)]/80 rounded-lg px-3 py-2 text-slate-500 text-sm cursor-not-allowed opacity-80"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] text-red-400/80 uppercase tracking-wider mb-1.5 font-bold">Enviado do personagem</label>
                <input
                  type="text"
                  value={fromCharacter}
                  onChange={(e) => setFromCharacter(e.target.value)}
                  placeholder="Nome do seu personagem que enviou as RC's"
                  className={`w-full bg-black/40 border rounded-lg px-3 py-2 text-white focus:outline-none text-sm placeholder-slate-600 transition-colors ${errors.fromCharacter ? "border-rose-500/60 focus:border-rose-500" : "border-[var(--th-line)]/50 focus:border-red-700/60"}`}
                />
                {errors.fromCharacter && <div className="text-[10px] text-rose-400 mt-1">{errors.fromCharacter}</div>}
              </div>
              <div>
                <label className="block text-[10px] text-red-400/80 uppercase tracking-wider mb-1.5 font-bold">Data do envio</label>
                <input
                  type="date"
                  value={donationDate}
                  onChange={(e) => setDonationDate(e.target.value)}
                  className="w-full bg-black/40 border border-[var(--th-line)]/50 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-red-700/60 text-sm [color-scheme:dark]"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2 border-t border-[var(--th-line)]/60">
              <button
                onClick={handleClose}
                className="px-4 py-2 rounded-lg border border-[var(--th-line)]/80 text-slate-500 hover:text-white hover:bg-[var(--th-line)]/20 text-xs font-semibold transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                onClick={handleSubmit}
                className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-brand)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-line-strong)] text-white text-xs font-bold shadow-lg shadow-red-900/30 transition-colors cursor-pointer border border-[var(--th-brand-mid)]/60"
              >
                <Send size={13} /> Registrar Doação
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {visibleRanking.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-slate-600 italic text-xs gap-3 flex-1">
                <Trophy size={36} className="text-amber-500/25" />
                <span>Nenhuma doação aprovada ainda.</span>
              </div>
            ) : (
              <>
                {/* Cabeçalho fixo das colunas */}
                <div className="overflow-x-auto flex-shrink-0">
                  <div className="grid grid-cols-[1fr_80px_100px_130px] gap-3 px-5 py-2.5 bg-[var(--th-n-deep)]/70 border-b border-[var(--th-line)]/30 text-[9px] uppercase tracking-wider font-bold text-slate-600 min-w-[480px]">
                    <div>Colaborador</div>
                    <div className="text-center inline-flex items-center justify-center gap-1"><Swords size={10} className="text-red-400/60" /> PT's</div>
                    <div className="text-center inline-flex items-center justify-center gap-1"><Heart size={10} className="text-rose-400/60" /> Total Aprovado</div>
                    <div className="text-right inline-flex items-center justify-end gap-1 text-emerald-400 font-bold"><Trophy size={10} className="text-emerald-400" /> Média por PT</div>
                  </div>
                </div>

                {/* Lista rolável */}
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto p-3 space-y-2">
                  {visibleRanking.map((entry, index) => {
                    const ptCount = entry.ptCount;
                    // Doação/PT = Valor Aprovado / totalPtsConcluidas (métrica principal)
                    const doacaoPorPt = ptCount > 0 ? Math.round(entry.average) : null;
                    return (
                    <div key={entry.userName} className={`rounded-xl border p-3 grid grid-cols-[1fr_80px_100px_130px] gap-3 items-center min-w-[480px] ${rankingRowClass(index)}`}>
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-lg bg-black/30 border border-[var(--th-line)]/80 flex items-center justify-center flex-shrink-0">
                          {rankingIcon(index)}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-bold text-white truncate">#{index + 1} • {entry.userName}</div>
                          <div className="text-[10px] text-slate-500 truncate">
                            {entry.total > 0
                              ? <span className="text-emerald-500 font-semibold">Aprovado</span>
                              : <span className="italic text-slate-600">Nunca doou</span>
                            }
                          </div>
                        </div>
                      </div>

                      {/* PT's concluídas */}
                      <div className="text-center">
                        <div className="inline-flex items-center justify-center gap-1 text-base font-black text-red-300 tabular-nums">
                          <Swords size={12} className="text-red-400/80" />
                          {entry.ptCount}
                        </div>
                        <div className="text-[9px] text-slate-600 uppercase tracking-wider">Concluídas</div>
                      </div>

                      {/* Total Doado (Aprovado) */}
                      <div className="text-center">
                        <div className="inline-flex items-center justify-center gap-1 text-base font-black text-amber-300 tabular-nums">
                          <Coins size={12} className="text-amber-400" />
                          {formatRC(entry.total)}
                        </div>
                        <div className="text-[9px] text-slate-600 uppercase tracking-wider">Aprovado</div>
                      </div>

                      {/* Doação / PT (Média como Destaque Principal) */}
                      <div className="text-right">
                        <div className="text-lg font-black text-emerald-400 tabular-nums truncate drop-shadow-[0_0_8px_rgba(52,211,153,0.3)]">
                          {doacaoPorPt !== null ? `${doacaoPorPt} RC/PT` : "—"}
                        </div>
                        <div className="text-[9px] text-emerald-500/80 font-bold uppercase tracking-wider">Média por PT</div>
                      </div>
                    </div>
                    );
                  })}
                </div>

                {/* Rodapé totais */}
                <div className="overflow-x-auto flex-shrink-0">
                  <div className="grid grid-cols-[1fr_80px_100px_130px] gap-3 px-5 py-2.5 bg-[var(--th-n-deep)]/70 border-t border-[var(--th-line)]/60 text-[10px] font-bold min-w-[480px]">
                    <div className="text-slate-500 uppercase tracking-wider">
                      {visibleRanking.length} colaborador(es)
                    </div>
                    <div className="text-center text-red-300/80 tabular-nums">
                      {visibleRanking.reduce((s, e) => s + e.ptCount, 0)}
                    </div>
                    <div className="text-center text-amber-300/80 tabular-nums">
                      {isBoss ? formatRC(approvedRanking.reduce((s, e) => s + e.total, 0)) : "—"}
                    </div>
                    <div className="right text-emerald-400 tabular-nums">
                      {isBoss && approvedRanking.reduce((s, e) => s + e.ptCount, 0) > 0 ? `${Math.round(approvedRanking.reduce((s, e) => s + e.total, 0) / approvedRanking.reduce((s, e) => s + e.ptCount, 0))} RC/PT` : "—"}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}