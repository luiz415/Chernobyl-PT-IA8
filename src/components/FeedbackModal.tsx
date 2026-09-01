import { useState, useEffect, useMemo } from "react";
import { Bug, Lightbulb, Send, X, CheckCircle2, PlusCircle, ListChecks, Search, Copy, User, Phone, Calendar, Hash, Inbox, Check, Trash2 } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { db, isSimulationMode } from "../firebase/config";
import { collection, doc, setDoc, updateDoc, deleteDoc, query, orderBy, getDocs } from "firebase/firestore";

export interface FeedbackReport {
  id: string;
  userName: string;
  userUid?: string;
  type: "bug" | "suggestion";
  subject: string;
  description: string;
  contact: string;
  createdAt: number;
  status: "pendente" | "concluido";
}

interface Props {
  open: boolean;
  onClose: () => void;
  userName: string;
}

type ModalTab = "new" | "history";
type HistoryFilter = "all" | "bug" | "suggestion";

const FEEDBACK_CACHE_KEY = "feedback_reports_cache";
const FEEDBACK_CACHE_TS_KEY = "feedback_reports_cache_ts";
const FEEDBACK_CACHE_TTL_MS = 5 * 60 * 1000;

function formatDateTimeBR(ts: number): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

function getRelativeTime(ts: number): string {
  try {
    const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diff < 60) return "Agora mesmo";
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `Há ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `Há ${hours} h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `Há ${days} d`;
    const months = Math.floor(days / 30);
    return `Há ${months} mês${months > 1 ? "es" : ""}`;
  } catch {
    return "—";
  }
}

export default function FeedbackModal({ open, onClose, userName }: Props) {
  const { userProfile, currentUser } = useAuth();
  const canDeleteFeedback = userProfile?.role === "Boss";
  const [activeTab, setActiveTab] = useState<ModalTab>("new");
  const [type, setType] = useState<"bug" | "suggestion">("bug");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [contact, setContact] = useState("");
  const [errors, setErrors] = useState<{ subject?: string; description?: string }>({});
  const [success, setSuccess] = useState(false);

  // History tab state
  const [reports, setReports] = useState<FeedbackReport[]>([]);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [historySearch, setHistorySearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // A moldura global limita viewport e rola o conteúdo sem reduzir fontes ou
  // campos em telas pequenas.

  // Feedback sob demanda: getDocs + cache temporário, sem listener em tempo real.
  useEffect(() => {
    if (!open) return;

    if (isSimulationMode || !db) {
      // Fallback: carregar do localStorage
      loadReportsFromLocal();
      return;
    }

    function readFeedbackCache(): FeedbackReport[] | null {
      try {
        const raw = localStorage.getItem(FEEDBACK_CACHE_KEY);
        const ts = parseInt(localStorage.getItem(FEEDBACK_CACHE_TS_KEY) || "0", 10) || 0;
        if (!raw || !ts || Date.now() - ts > FEEDBACK_CACHE_TTL_MS) return null;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }

    function saveFeedbackCache(list: FeedbackReport[]) {
      try {
        localStorage.setItem(FEEDBACK_CACHE_KEY, JSON.stringify(list));
        localStorage.setItem(FEEDBACK_CACHE_TS_KEY, String(Date.now()));
      } catch {}
    }

    const cached = readFeedbackCache();
    if (cached) {
      setReports(cached);
      return;
    }

    let cancelled = false;

    const loadReports = async () => {
      try {
        const q = query(collection(db, "feedback"), orderBy("createdAt", "desc"));
        const snapshot = await getDocs(q);
        if (cancelled) return;
        const list: FeedbackReport[] = snapshot.docs.map(docSnap => {
          const data = docSnap.data();
          return {
            id: docSnap.id,
            userName: data.userName || "Anônimo",
            userUid: data.userUid || "",
            type: data.type || "bug",
            subject: data.subject || "",
            description: data.description || "",
            contact: data.contact || "",
            createdAt: data.createdAt || Date.now(),
            status: data.status || "pendente",
          };
        });
        saveFeedbackCache(list);
        setReports(list);
      } catch {
        if (!cancelled) loadReportsFromLocal();
      }
    };

    loadReports();

    return () => {
      cancelled = true;
    };
  }, [open]);

  function loadReportsFromLocal() {
    try {
      const raw = localStorage.getItem("feedback_reports") || "[]";
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setReports(parsed.map((r: any) => ({
          ...r,
          createdAt: typeof r.createdAt === "string" ? new Date(r.createdAt).getTime() : (r.createdAt || Date.now()),
          status: r.status === "done" ? "concluido" : (r.status || "pendente"),
        })));
      }
    } catch {
      setReports([]);
    }
  }

  async function handleMarkDone(id: string) {
    if (isSimulationMode || !db) {
      setReports(prev => {
        const next = prev.map(r => r.id === id ? { ...r, status: "concluido" as const } : r);
        persistReportsToLocal(next);
        return next;
      });
      return;
    }
    try {
      await updateDoc(doc(db, "feedback", id), { status: "concluido" });
      setReports(prev => {
        const next = prev.map(r => r.id === id ? { ...r, status: "concluido" as const } : r);
        try {
          localStorage.setItem(FEEDBACK_CACHE_KEY, JSON.stringify(next));
          localStorage.setItem(FEEDBACK_CACHE_TS_KEY, String(Date.now()));
        } catch {}
        return next;
      });
    } catch {}
  }

  async function handleDelete(id: string) {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      window.setTimeout(() => {
        setConfirmDeleteId(cur => cur === id ? null : cur);
      }, 4000);
      return;
    }
    setConfirmDeleteId(null);

    if (isSimulationMode || !db) {
      setReports(prev => {
        const next = prev.filter(r => r.id !== id);
        persistReportsToLocal(next);
        return next;
      });
      if (expandedId === id) setExpandedId(null);
      return;
    }

    try {
      await deleteDoc(doc(db, "feedback", id));
      setReports(prev => {
        const next = prev.filter(r => r.id !== id);
        try {
          localStorage.setItem(FEEDBACK_CACHE_KEY, JSON.stringify(next));
          localStorage.setItem(FEEDBACK_CACHE_TS_KEY, String(Date.now()));
        } catch {}
        return next;
      });
    } catch {}
    if (expandedId === id) setExpandedId(null);
  }

  function persistReportsToLocal(list: FeedbackReport[]) {
    try {
      localStorage.setItem("feedback_reports", JSON.stringify(list.map(r => ({ ...r, createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now() }))));
    } catch {}
  }

  const filteredReports = useMemo(() => {
    let list = [...reports];
    if (historyFilter !== "all") list = list.filter(r => r.type === historyFilter);
    if (historySearch.trim()) {
      const q = historySearch.toLowerCase();
      list = list.filter(r =>
        r.subject.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.userName.toLowerCase().includes(q) ||
        (r.contact || "").toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    return list;
  }, [reports, historyFilter, historySearch]);

  const totals = useMemo(() => ({
    all: reports.length,
    bugs: reports.filter(r => r.type === "bug").length,
    suggestions: reports.filter(r => r.type === "suggestion").length,
  }), [reports]);

  if (!open) return null;

  function validate(): boolean {
    const newErrors: { subject?: string; description?: string } = {};
    if (!subject.trim()) newErrors.subject = "O assunto é obrigatório";
    if (!description.trim()) newErrors.description = "A descrição é obrigatória";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  async function handleSubmit() {
    if (!validate()) return;

    const report: FeedbackReport & { createdBy: string } = {
      id: "fb_" + Date.now().toString(36) + Math.random().toString(36).slice(2),
      userName: userName || "Anônimo",
      userUid: currentUser?.uid || "",
      createdBy: currentUser?.uid || "",
      type,
      subject: subject.trim(),
      description: description.trim(),
      contact: contact.trim(),
      createdAt: Date.now(),
      status: "pendente",
    };

    if (isSimulationMode || !db) {
      try {
        const existing = JSON.parse(localStorage.getItem("feedback_reports") || "[]");
        existing.unshift(report);
        localStorage.setItem("feedback_reports", JSON.stringify(existing));
      } catch {
        localStorage.setItem("feedback_reports", JSON.stringify([report]));
      }
      setReports(prev => [report, ...prev]);
    } else {
      try {
        await setDoc(doc(db, "feedback", report.id), report);
        setReports(prev => {
          const next = [report, ...prev];
          try {
            localStorage.setItem(FEEDBACK_CACHE_KEY, JSON.stringify(next));
            localStorage.setItem(FEEDBACK_CACHE_TS_KEY, String(Date.now()));
          } catch {}
          return next;
        });
      } catch {
        // Fallback silencioso
      }
    }

    setSuccess(true);
    setTimeout(() => {
      setSuccess(false);
      setType("bug");
      setSubject("");
      setDescription("");
      setContact("");
      setErrors({});
      setActiveTab("history");
    }, 1600);
  }

  function handleClose() {
    if (success) return;
    setType("bug");
    setSubject("");
    setDescription("");
    setContact("");
    setErrors({});
    setActiveTab("new");
    setHistoryFilter("all");
    setHistorySearch("");
    setExpandedId(null);
    setConfirmDeleteId(null);
    onClose();
  }

  function handleCopyId(id: string) {
    try {
      navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {}
  }

  const isDoneStatus = (r: FeedbackReport) => r.status === "concluido";

  return (
    <div
      className="app-modal-overlay fixed inset-0 z-[300] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !success) handleClose(); }}
    >
      <div
        className="app-modal-frame app-modal-size-xl app-modal-frame--scroll relative bg-[var(--th-n-base)] border border-[var(--th-line)]/100 rounded-2xl shadow-[0_0_40px_color-mix(in_oklab,var(--th-brand)_30%,transparent)] w-full max-w-3xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--th-line)]/60 bg-gradient-to-r from-[var(--th-bg-deep)] to-[var(--th-bg-abyss)] flex-shrink-0">
          <div className="flex items-center gap-2">
            {type === "bug" ? (
              <div className="w-8 h-8 rounded-lg bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shadow-[0_0_8px_color-mix(in_oklab,var(--color-red-600)_15%,transparent)]">
                <Bug size={16} className="text-rose-400" />
              </div>
            ) : (
              <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-600/30 flex items-center justify-center shadow-[0_0_8px_color-mix(in_oklab,var(--color-amber-500)_15%,transparent)]">
                <Lightbulb size={16} className="text-amber-400" />
              </div>
            )}
            <h3 className="text-base font-bold text-white tracking-wide">Relatar Bug ou Enviar Sugestão</h3>
          </div>
          <button
            onClick={handleClose}
            className="text-slate-500 hover:text-white p-1.5 rounded-lg hover:bg-[var(--th-line)]/25 transition-colors cursor-pointer"
            disabled={success}
          >
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        {!success && (
          <div className="flex bg-[var(--th-n-deep)] border-b border-[var(--th-line)]/60 p-1 flex-shrink-0">
            <button
              type="button"
              onClick={() => setActiveTab("new")}
              className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer ${
                activeTab === "new"
                  ? "bg-gradient-to-r from-[var(--th-line-subtle)]/60 to-[var(--th-line)]/40 border border-[var(--th-brand)]/60 text-red-200 shadow-[0_0_10px_color-mix(in_oklab,var(--th-brand)_15%,transparent)]"
                  : "text-slate-500 hover:bg-[var(--th-line)]/15 hover:text-slate-300"
              }`}
            >
              <PlusCircle size={14} />
              <span>Novo Relato</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("history")}
              className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer ${
                activeTab === "history"
                  ? "bg-gradient-to-r from-[#2a1a00]/60 to-[#3a2500]/40 border border-amber-700/40 text-amber-200 shadow-[0_0_10px_color-mix(in_oklab,var(--color-amber-500)_12%,transparent)]"
                  : "text-slate-500 hover:bg-[var(--th-line)]/15 hover:text-slate-300"
              }`}
            >
              <ListChecks size={14} />
              <span>Histórico de Relatos</span>
              {totals.all > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold bg-amber-600/80 text-black">
                  {totals.all}
                </span>
              )}
            </button>
          </div>
        )}

        {success ? (
          <div className="flex flex-col items-center justify-center py-14 px-6 gap-3 flex-1">
            <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center animate-in zoom-in duration-300 shadow-[0_0_20px_rgba(16,185,129,0.15)]">
              <CheckCircle2 size={28} className="text-emerald-400" />
            </div>
            <h4 className="text-lg font-bold text-white">Relato enviado com sucesso!</h4>
            <p className="text-sm text-slate-500 text-center max-w-xs">
              Obrigado pelo seu feedback. Sua mensagem foi registrada e será analisada pela equipe.
            </p>
          </div>
        ) : activeTab === "new" ? (
          <div className="app-modal-body p-4 sm:p-5 space-y-4">
            {/* Tipo */}
            <div>
              <label className="block text-[10px] text-red-400/80 uppercase tracking-wider mb-1.5 font-bold">Tipo</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setType("bug")}
                  className={`flex items-center justify-center gap-2 py-2.5 rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                    type === "bug"
                      ? "bg-rose-500/15 border-rose-500/50 text-rose-300 shadow-[0_0_10px_color-mix(in_oklab,var(--color-red-600)_12%,transparent)]"
                      : "bg-black/20 border-[var(--th-line)]/60 text-slate-500 hover:bg-[var(--th-line)]/15 hover:text-slate-300"
                  }`}
                >
                  <Bug size={14} />
                  <span>Bug</span>
                </button>
                <button
                  type="button"
                  onClick={() => setType("suggestion")}
                  className={`flex items-center justify-center gap-2 py-2.5 rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                    type === "suggestion"
                      ? "bg-amber-500/15 border-amber-600/50 text-amber-300 shadow-[0_0_10px_color-mix(in_oklab,var(--color-amber-500)_12%,transparent)]"
                      : "bg-black/20 border-[var(--th-line)]/60 text-slate-500 hover:bg-[var(--th-line)]/15 hover:text-slate-300"
                  }`}
                >
                  <Lightbulb size={14} />
                  <span>Sugestão</span>
                </button>
              </div>
            </div>

            {/* Assunto */}
            <div>
              <label className="block text-[10px] text-red-400/80 uppercase tracking-wider mb-1.5 font-bold">Assunto *</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => { setSubject(e.target.value.slice(0, 120)); if (errors.subject) setErrors(err => ({ ...err, subject: undefined })); }}
                maxLength={120}
                placeholder="Ex: Erro ao adicionar personagem..."
                className={`w-full bg-black/40 border rounded-lg px-3 py-2 text-white focus:outline-none text-sm placeholder-slate-600 transition-colors ${errors.subject ? "border-rose-500/60 focus:border-rose-500" : "border-[var(--th-line)]/80 focus:border-red-700/80"}`}
              />
              <div className="flex justify-between mt-1">
                {errors.subject ? <span className="text-[10px] text-rose-400">{errors.subject}</span> : <span />}
                <span className="text-[10px] text-slate-600">{subject.length}/120</span>
              </div>
            </div>

            {/* Descrição */}
            <div>
              <label className="block text-[10px] text-red-400/80 uppercase tracking-wider mb-1.5 font-bold">Descrição *</label>
              <textarea
                value={description}
                onChange={(e) => { setDescription(e.target.value.slice(0, 2000)); if (errors.description) setErrors(err => ({ ...err, description: undefined })); }}
                maxLength={2000}
                rows={5}
                placeholder="Descreva detalhadamente o bug ou sua sugestão..."
                className={`w-full bg-black/40 border rounded-lg px-3 py-2 text-white focus:outline-none text-sm placeholder-slate-600 resize-none transition-colors ${errors.description ? "border-rose-500/60 focus:border-rose-500" : "border-[var(--th-line)]/80 focus:border-red-700/80"}`}
              />
              <div className="flex justify-between mt-1">
                {errors.description ? <span className="text-[10px] text-rose-400">{errors.description}</span> : <span />}
                <span className="text-[10px] text-slate-600">{description.length}/2000</span>
              </div>
            </div>

            {/* Contato */}
            <div>
              <label className="block text-[10px] text-red-400/80 uppercase tracking-wider mb-1.5 font-bold">Contato / WhatsApp (opcional)</label>
              <input
                type="text"
                value={contact}
                onChange={(e) => setContact(e.target.value.slice(0, 50))}
                maxLength={50}
                placeholder="Ex: +55 11 99999-9999"
                className="w-full bg-black/40 border border-[var(--th-line)]/80 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-red-700/60 text-sm placeholder-slate-600 transition-colors"
              />
              <div className="text-[10px] text-slate-600 mt-1">Deixe um contato caso deseje ser respondido.</div>
            </div>

            {/* Ações */}
            <div className="flex justify-end gap-3 pt-2 border-t border-[var(--th-line)]/60">
              <button
                onClick={handleClose}
                className="px-4 py-2 rounded-lg border border-[var(--th-line)]/80 text-slate-500 hover:text-white hover:bg-[var(--th-line)]/20 text-xs font-semibold transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                onClick={handleSubmit}
                className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-brand)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-line-strong)] text-white text-xs font-bold shadow-lg shadow-red-900/30 transition-colors cursor-pointer border border-[var(--th-brand-mid)]/80"
              >
                <Send size={13} /> Enviar
              </button>
            </div>
          </div>
        ) : (
          /* HISTORY TAB */
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            {/* Filter bar */}
            <div className="px-5 py-3 bg-[var(--th-bg-abyss)]/60 border-b border-[var(--th-line)]/60 flex flex-wrap items-center gap-2 flex-shrink-0">
              <div className="flex items-center gap-1 bg-[var(--th-bg-deep)] p-1 rounded-lg border border-[var(--th-line)]/80">
                <button
                  type="button"
                  onClick={() => setHistoryFilter("all")}
                  className={`px-3 py-1 rounded-md text-[11px] font-bold transition-colors cursor-pointer flex items-center gap-1.5 ${
                    historyFilter === "all"
                      ? "bg-[var(--th-line)]/30 text-white shadow-sm"
                      : "text-slate-500 hover:text-white hover:bg-[var(--th-line)]/15"
                  }`}
                >
                  Todos
                  <span className={`text-[9px] font-mono px-1 rounded ${historyFilter === "all" ? "bg-[var(--th-line)]/40 text-white" : "bg-[var(--th-line)]/15 text-slate-500"}`}>
                    {totals.all}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setHistoryFilter("bug")}
                  className={`px-3 py-1 rounded-md text-[11px] font-bold transition-colors cursor-pointer flex items-center gap-1.5 ${
                    historyFilter === "bug"
                      ? "bg-rose-500/15 text-rose-300 border border-rose-500/30 shadow-sm"
                      : "text-rose-400/60 hover:text-rose-300 hover:bg-rose-500/10"
                  }`}
                >
                  <Bug size={11} /> Bugs
                  <span className={`text-[9px] font-mono px-1 rounded ${historyFilter === "bug" ? "bg-rose-500/25 text-rose-200" : "bg-rose-500/10 text-rose-400/60"}`}>
                    {totals.bugs}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setHistoryFilter("suggestion")}
                  className={`px-3 py-1 rounded-md text-[11px] font-bold transition-colors cursor-pointer flex items-center gap-1.5 ${
                    historyFilter === "suggestion"
                      ? "bg-amber-500/15 text-amber-300 border border-amber-600/30 shadow-sm"
                      : "text-amber-400/60 hover:text-amber-300 hover:bg-amber-500/10"
                  }`}
                >
                  <Lightbulb size={11} /> Sugestões
                  <span className={`text-[9px] font-mono px-1 rounded ${historyFilter === "suggestion" ? "bg-amber-500/25 text-amber-200" : "bg-amber-500/10 text-amber-400/60"}`}>
                    {totals.suggestions}
                  </span>
                </button>
              </div>

              <div className="flex-1 min-w-[180px] relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600 pointer-events-none" />
                <input
                  type="text"
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Buscar por assunto, descrição, usuário..."
                  className="w-full bg-black/40 border border-[var(--th-line)]/80 rounded-lg pl-7 pr-7 py-1.5 text-xs text-white focus:outline-none focus:border-red-700/50 placeholder-slate-600 transition-colors"
                />
                {historySearch && (
                  <button
                    type="button"
                    onClick={() => setHistorySearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-600 hover:text-white"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>

            {/* List */}
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2.5">
              {filteredReports.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full py-16 gap-3 text-slate-600">
                  <Inbox size={42} className="opacity-30" />
                  <div className="text-sm font-medium text-slate-500">
                    {reports.length === 0 ? "Nenhum relato enviado ainda" : "Nenhum relato encontrado"}
                  </div>
                  <div className="text-[11px] text-slate-600 text-center max-w-xs">
                    {reports.length === 0
                      ? "Vá para a aba \"Novo Relato\" e envie sua primeira sugestão ou bug."
                      : "Tente ajustar os filtros ou o termo de busca."}
                  </div>
                </div>
              ) : (
                filteredReports.map((r) => {
                  const isExpanded = expandedId === r.id;
                  const isBug = r.type === "bug";
                  const done = isDoneStatus(r);
                  const accentBg = done
                    ? "bg-emerald-500/[0.04]"
                    : isBug ? "bg-rose-500/[0.03]" : "bg-amber-500/[0.03]";
                  const accentBorder = done
                    ? "border-emerald-500/20 hover:border-emerald-500/40"
                    : isBug ? "border-rose-500/20 hover:border-rose-500/40" : "border-amber-600/20 hover:border-amber-600/40";
                  const iconColor = isBug ? "text-rose-400" : "text-amber-400";
                  const iconBg = isBug ? "bg-rose-500/12 border-rose-500/30" : "bg-amber-500/12 border-amber-600/30";
                  const isConfirmingDelete = confirmDeleteId === r.id;

                  return (
                    <div
                      key={r.id}
                      className={`border rounded-xl ${accentBorder} ${accentBg} transition-colors overflow-hidden ${done ? "opacity-80" : ""}`}
                    >
                      {/* Card header (always visible) */}
                      <button
                        type="button"
                        onClick={() => setExpandedId(prev => prev === r.id ? null : r.id)}
                        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-[var(--th-line)]/[0.06] transition-colors cursor-pointer"
                      >
                        <div className={`w-8 h-8 rounded-lg border ${iconBg} flex items-center justify-center flex-shrink-0`}>
                          {isBug ? <Bug size={14} className={iconColor} /> : <Lightbulb size={14} className={iconColor} />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-0.5">
                            <span className={`text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider ${isBug ? "bg-rose-500/15 text-rose-300 border border-rose-500/25" : "bg-amber-500/15 text-amber-300 border border-amber-600/25"}`}>
                              {isBug ? "Bug" : "Sugestão"}
                            </span>
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider border inline-flex items-center gap-1 ${
                              done
                                ? "bg-emerald-500/12 text-emerald-300 border-emerald-500/30"
                                : "bg-amber-500/12 text-amber-400 border-amber-500/25"
                            }`}>
                              {done && <Check size={9} />}
                              {done ? "Concluído" : "Pendente"}
                            </span>
                            <span className="text-[10px] text-slate-600 font-mono ml-auto whitespace-nowrap">{getRelativeTime(r.createdAt)}</span>
                          </div>
                          <h4 className={`text-sm font-bold truncate ${done ? "text-slate-400 line-through decoration-slate-600 decoration-1" : "text-white"}`}>{r.subject}</h4>
                          <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-600 flex-wrap">
                            <span className="inline-flex items-center gap-1">
                              <User size={10} className="text-slate-600" /> {r.userName || "Anônimo"}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Calendar size={10} className="text-slate-600" /> {formatDateTimeBR(r.createdAt)}
                            </span>
                            {r.contact && (
                              <span className="inline-flex items-center gap-1">
                                <Phone size={10} className="text-amber-500/70" /> {r.contact}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className={`text-slate-600 transition-transform flex-shrink-0 mt-1 ${isExpanded ? "rotate-180" : ""}`}>▾</div>
                      </button>

                      {/* Expanded details */}
                      {isExpanded && (
                        <div className="px-4 pb-4 pt-1 border-t border-[var(--th-line)]/60 space-y-3 bg-black/30">
                          <div>
                            <div className="text-[10px] text-red-400/60 uppercase font-bold mb-1 tracking-wider">Descrição</div>
                            <p className="text-xs text-slate-300 whitespace-pre-line leading-relaxed bg-[var(--th-bg-deep)] border border-[var(--th-line)]/80 rounded-lg p-3">
                              {r.description}
                            </p>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[10px]">
                            <div className="bg-[var(--th-bg-deep)] border border-[var(--th-line)]/80 rounded-lg p-2.5 space-y-1.5">
                              <div className="text-red-400/50 uppercase font-bold tracking-wider">Usuário</div>
                              <div className="inline-flex items-center gap-1.5 text-slate-200 text-xs">
                                <User size={11} className="text-amber-500/80" />
                                <span className="font-semibold">{r.userName || "Anônimo"}</span>
                              </div>
                            </div>

                            <div className="bg-[var(--th-bg-deep)] border border-[var(--th-line)]/80 rounded-lg p-2.5 space-y-1.5">
                              <div className="text-red-400/50 uppercase font-bold tracking-wider">Contato</div>
                              <div className="inline-flex items-center gap-1.5 text-slate-200 text-xs">
                                <Phone size={11} className={r.contact ? "text-amber-500/80" : "text-slate-700"} />
                                <span className={r.contact ? "font-semibold" : "text-slate-700 italic"}>{r.contact || "Não informado"}</span>
                              </div>
                            </div>

                            <div className="bg-[var(--th-bg-deep)] border border-[var(--th-line)]/80 rounded-lg p-2.5 space-y-1.5">
                              <div className="text-red-400/50 uppercase font-bold tracking-wider">Data / Hora</div>
                              <div className="inline-flex items-center gap-1.5 text-slate-200 text-xs">
                                <Calendar size={11} className="text-amber-500/80" />
                                <span className="font-mono">{formatDateTimeBR(r.createdAt)}</span>
                              </div>
                            </div>

                            <div className="bg-[var(--th-bg-deep)] border border-[var(--th-line)]/80 rounded-lg p-2.5 space-y-1.5">
                              <div className="text-red-400/50 uppercase font-bold tracking-wider flex items-center justify-between">
                                <span>ID do Relato</span>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); handleCopyId(r.id); }}
                                  className="text-slate-600 hover:text-amber-400 transition-colors p-0.5 cursor-pointer"
                                  title="Copiar ID"
                                >
                                  <Copy size={10} />
                                </button>
                              </div>
                              <div className="inline-flex items-center gap-1.5 text-slate-200 text-xs">
                                <Hash size={11} className="text-amber-500/70" />
                                <span className="font-mono truncate" title={r.id}>{r.id}</span>
                                {copiedId === r.id && <span className="text-[9px] text-amber-400 font-bold">copiado!</span>}
                              </div>
                            </div>
                          </div>

                          {/* Action buttons */}
                          <div className="flex justify-end gap-2 pt-1 border-t border-[var(--th-line)]/60">
                            {!done && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); canDeleteFeedback && handleMarkDone(r.id); }}
                                disabled={!canDeleteFeedback}
                                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/30 text-[11px] font-bold transition-colors ${
                                  canDeleteFeedback
                                    ? "bg-emerald-500/12 hover:bg-emerald-500/20 text-emerald-300 cursor-pointer"
                                    : "bg-emerald-500/5 text-emerald-400/40 opacity-40 cursor-not-allowed pointer-events-none"
                                }`}
                                title={canDeleteFeedback ? "Marcar este relato como concluído" : "Ação restrita (Boss)"}
                              >
                                <Check size={12} /> Concluir
                              </button>
                            )}
                            {done && (
                              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/8 border border-emerald-500/25 text-emerald-400 text-[11px] font-bold">
                                <CheckCircle2 size={12} /> Concluído
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); canDeleteFeedback && handleDelete(r.id); }}
                              disabled={!canDeleteFeedback}
                              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-bold transition-colors ${
                                isConfirmingDelete && canDeleteFeedback
                                  ? "bg-rose-500 hover:bg-rose-400 border-rose-400 text-white shadow-md shadow-rose-500/30 animate-pulse cursor-pointer"
                                  : canDeleteFeedback
                                    ? "bg-rose-500/12 hover:bg-rose-500/20 border-rose-500/30 text-rose-300 cursor-pointer"
                                    : "bg-rose-500/5 text-rose-400/40 border-rose-500/20 opacity-40 cursor-not-allowed pointer-events-none"
                              }`}
                              title={canDeleteFeedback ? (isConfirmingDelete ? "Clique novamente para confirmar a exclusão" : "Excluir este relato permanentemente") : "Ação restrita (Boss)"}
                            >
                              <Trash2 size={12} /> {isConfirmingDelete && canDeleteFeedback ? "Confirmar?" : "Excluir"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className="app-modal-footer px-4 sm:px-5 py-2.5 bg-[var(--th-bg-abyss)]/60 border-t border-[var(--th-line)]/60 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[10px] text-slate-600">
                Exibindo <span className="font-bold text-slate-400">{filteredReports.length}</span> de <span className="font-bold text-slate-400">{totals.all}</span> relato(s)
              </div>
              <button
                type="button"
                onClick={() => setActiveTab("new")}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-[var(--th-brand-mid)]/20 to-[var(--th-line)]/15 hover:from-[var(--th-brand-mid)]/30 hover:to-[var(--th-line)]/25 border border-[var(--th-brand)]/80 text-red-300 text-[11px] font-bold transition-colors cursor-pointer"
              >
                <PlusCircle size={12} /> Novo Relato
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}