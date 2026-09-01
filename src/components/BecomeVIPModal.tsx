import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  CheckCircle2,
  ChevronLeft,
  Copy,
  Crown,
  Sparkles,
  X,
} from "lucide-react";
import { collection, doc, serverTimestamp } from "firebase/firestore";
import type { UserProfile } from "../context/AuthContext";
import { addDoc, db, isSimulationMode } from "../firebase/config";
import VipBenefitsModal from "./VipBenefitsModal";

interface BecomeVIPModalProps {
  open: boolean;
  onClose: () => void;
  userProfile: UserProfile | null;
}

type VipPlan = "30_dias" | "90_dias";

/**
 * Fluxo exclusivo de contratação/ativação VIP. Todas as operações de planos e
 * solicitação de crédito permanecem aqui, sem misturá-las ao painel "Meu VIP".
 */
export default function BecomeVIPModal({ open, onClose, userProfile }: BecomeVIPModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedPlan, setSelectedPlan] = useState<VipPlan>("30_dias");
  const [vipPlansConfig, setVipPlansConfig] = useState({ plan30PriceRC: 100, plan90PriceRC: 250 });
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [requestSuccess, setRequestSuccess] = useState(false);
  const [fromCharacter, setFromCharacter] = useState("");
  const [donationCharacter, setDonationCharacter] = useState("A definir pelo administrador");
  const [copied, setCopied] = useState(false);
  const [benefitsOpen, setBenefitsOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setBenefitsOpen(false);
      return;
    }
    // Mantém o plano e o personagem já preenchidos, como no fluxo anterior,
    // mas sempre reabre diretamente na seleção de planos.
    setStep(1);
    setRequestError("");
    setRequestSuccess(false);
    setCopied(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    if (isSimulationMode || !db) {
      try {
        const raw = localStorage.getItem("tibia_vip_plans_config");
        if (raw) {
          const plans = JSON.parse(raw);
          if (plans && typeof plans.plan30PriceRC === "number" && typeof plans.plan90PriceRC === "number") {
            setVipPlansConfig(plans);
          }
        }
      } catch {}
      try {
        const rawDonation = localStorage.getItem("chernobyl_donation_char");
        if (rawDonation) setDonationCharacter(rawDonation);
      } catch {}
      return;
    }

    // Mantém a estratégia anterior: leitura pontual ao abrir, cache local como
    // fallback e nenhum listener permanente para configurações administrativas.
    const loadSettings = async () => {
      try {
        const { getDoc } = await import("firebase/firestore");
        const plansSnap = await getDoc(doc(db, "appSettings", "vip_plans"));
        if (plansSnap.exists()) {
          const data = plansSnap.data();
          const plan30PriceRC = typeof data.plan30PriceRC === "number" ? data.plan30PriceRC : 100;
          const plan90PriceRC = typeof data.plan90PriceRC === "number" ? data.plan90PriceRC : 250;
          setVipPlansConfig({ plan30PriceRC, plan90PriceRC });
          localStorage.setItem("chernobyl_vip_plans", JSON.stringify({ plan30PriceRC, plan90PriceRC }));
        }

        const donationSnap = await getDoc(doc(db, "settings", "donation_settings"));
        if (donationSnap.exists()) {
          const data = donationSnap.data();
          const character = data.donationCharacter || data.characterName || "A definir pelo administrador";
          setDonationCharacter(character);
          localStorage.setItem("chernobyl_donation_char", data.donationCharacter || data.characterName || "");
        }
      } catch {
        try {
          const cachedPlans = localStorage.getItem("chernobyl_vip_plans");
          if (cachedPlans) setVipPlansConfig(JSON.parse(cachedPlans));
          const cachedDonation = localStorage.getItem("chernobyl_donation_char");
          if (cachedDonation) setDonationCharacter(cachedDonation);
        } catch {}
      }
    };

    void loadSettings();
  }, [open]);

  const days = selectedPlan === "30_dias" ? 30 : 90;
  const months = selectedPlan === "30_dias" ? 1 : 3;
  const priceRC = selectedPlan === "30_dias" ? vipPlansConfig.plan30PriceRC : vipPlansConfig.plan90PriceRC;

  const closeModal = () => {
    setBenefitsOpen(false);
    onClose();
  };

  async function handleAddVipCredit() {
    if (step === 2 && !fromCharacter.trim()) {
      setRequestError("Preencha o nome do personagem do qual enviará o RC.");
      return;
    }
    if (!userProfile?.uid || !db) {
      setRequestError("Não foi possível identificar o usuário logado.");
      return;
    }

    setSubmitting(true);
    setRequestError("");
    setRequestSuccess(false);
    try {
      await addDoc(collection(db, "vipCreditRequests"), {
        userId: userProfile.uid,
        userName: userProfile.nome || "Anônimo",
        userEmail: userProfile.email || "",
        requestedDays: days,
        requestedMonths: months,
        requestedPriceRC: priceRC,
        selectedPlan,
        status: "pendente",
        fromCharacter: fromCharacter.trim(),
        roleAtRequest: userProfile.role || "Normal",
        source: "vip_modal",
        createdAt: serverTimestamp(),
        clientCreatedAt: Date.now(),
      });
      setRequestSuccess(true);
      window.setTimeout(closeModal, 2000);
    } catch (error: any) {
      console.error("Erro ao registrar solicitação de Crédito VIP:", {
        code: error?.code,
        message: error?.message,
        error,
      });
      setRequestError("Não foi possível registrar a solicitação. Tente novamente.");
    } finally {
      setSubmitting(false);
    }
  }

  const selectPlan = (plan: VipPlan) => {
    setSelectedPlan(plan);
    setRequestError("");
    setRequestSuccess(false);
  };

  return (
    <>
      {open && createPortal(
        <div
          className="app-modal-overlay fixed inset-0 z-[600] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
          onMouseDown={event => { if (event.target === event.currentTarget) closeModal(); }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Seja VIP"
            className="app-modal-frame app-modal-size-sm app-modal-frame--scroll w-full rounded-2xl border border-violet-500/45 bg-[var(--th-bg-base)] shadow-2xl shadow-violet-950/50 animate-in zoom-in-95 duration-200"
          >
            <header className="app-modal-header flex items-center justify-between gap-3 border-b border-violet-500/25 bg-gradient-to-r from-violet-950/50 via-violet-900/18 to-[var(--th-bg-base)] px-4 py-3.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-violet-400/40 bg-violet-500/15 shadow-inner shadow-violet-500/10">
                  <Crown size={16} className="text-violet-200" />
                </div>
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-black uppercase tracking-wide text-violet-200">Seja VIP</h2>
                  <p className="text-[10px] text-slate-400">Escolha um plano e envie sua solicitação.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Fechar contratação VIP"
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-violet-500/10 hover:text-white cursor-pointer"
              >
                <X size={16} />
              </button>
            </header>

            <div className="app-modal-body">
              {step === 1 ? (
                <div className="space-y-4 p-4 sm:p-5 animate-in slide-in-from-left-4 duration-200">
                  <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.06] px-3.5 py-3">
                    <p className="text-xs font-black text-violet-200">Selecione um Plano VIP</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-400">Você será direcionado para a confirmação do envio de RC logo após escolher o plano.</p>
                  </div>

                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <PlanOption
                      days={30}
                      priceRC={vipPlansConfig.plan30PriceRC}
                      selected={selectedPlan === "30_dias"}
                      onClick={() => selectPlan("30_dias")}
                    />
                    <PlanOption
                      days={90}
                      priceRC={vipPlansConfig.plan90PriceRC}
                      selected={selectedPlan === "90_dias"}
                      onClick={() => selectPlan("90_dias")}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 rounded-xl border border-violet-500/20 bg-black/30 px-3.5 py-3">
                    <div>
                      <span className="block text-[10px] uppercase tracking-wider text-slate-500">Plano selecionado</span>
                      <strong className="block text-xs text-white">{days} dias ({months} {months === 1 ? "mês" : "meses"})</strong>
                    </div>
                    <div className="text-right">
                      <span className="block text-[10px] uppercase tracking-wider text-slate-500">Valor em RC</span>
                      <strong className="block text-base font-black tabular-nums text-violet-300">{priceRC} RC</strong>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setRequestError("");
                      setRequestSuccess(false);
                      setStep(2);
                    }}
                    className="w-full rounded-xl border border-violet-400/40 bg-gradient-to-r from-violet-600 to-violet-700 py-2.5 text-xs font-black text-white shadow-lg shadow-violet-950/30 transition-colors hover:from-violet-500 hover:to-violet-600 cursor-pointer"
                  >
                    Avançar para envio
                  </button>
                </div>
              ) : (
                <div className="space-y-4 p-4 sm:p-5 animate-in slide-in-from-right-4 duration-200">
                  <div className="space-y-1 text-center">
                    <h3 className="text-base font-black text-violet-200">Solicitação de VIP</h3>
                    <p className="text-xs leading-relaxed text-slate-300">
                      Envie <strong className="font-extrabold text-violet-300">{priceRC} RC</strong> para o personagem abaixo.
                    </p>
                  </div>

                  <div className="flex justify-center">
                    <button
                      type="button"
                      onClick={() => {
                        try {
                          navigator.clipboard.writeText(donationCharacter);
                          setCopied(true);
                          window.setTimeout(() => setCopied(false), 2000);
                        } catch {}
                      }}
                      className={`inline-flex max-w-full items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm font-black transition-colors cursor-pointer ${
                        copied
                          ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300"
                          : "border-violet-500/30 bg-black/45 text-violet-200 hover:border-violet-400/55 hover:bg-violet-500/10"
                      }`}
                      title="Copiar nome do personagem"
                    >
                      {copied ? <CheckCircle2 size={16} className="flex-shrink-0" /> : <Copy size={16} className="flex-shrink-0" />}
                      <span className="truncate">{donationCharacter}</span>
                    </button>
                  </div>

                  {copied && (
                    <p className="text-center text-[10px] font-bold text-emerald-400 animate-in fade-in">
                      Nome copiado para a área de transferência!
                    </p>
                  )}

                  <div className="space-y-1.5 border-t border-white/5 pt-3">
                    <label className="block text-[10px] font-black uppercase tracking-wider text-violet-300">
                      Informe de qual personagem está enviando o RC
                    </label>
                    <input
                      type="text"
                      value={fromCharacter}
                      onChange={event => {
                        setFromCharacter(event.target.value);
                        setRequestError("");
                      }}
                      placeholder="Nome do seu personagem"
                      className="w-full rounded-xl border border-violet-500/30 bg-black/40 px-3 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-violet-400/60"
                    />
                  </div>

                  <p className="rounded-xl border border-white/5 bg-black/20 p-2.5 text-center text-[10px] leading-relaxed text-slate-400">
                    Após confirmar a solicitação, um administrador irá analisar sua doação e, após a aprovação, seu VIP será ativado.
                  </p>

                  {requestError && (
                    <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-center text-[11px] font-semibold text-rose-300">
                      {requestError}
                    </div>
                  )}

                  {requestSuccess && (
                    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-center text-[11px] font-semibold text-emerald-300">
                      Solicitação registrada com sucesso!
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      disabled={submitting || requestSuccess}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/10 py-2.5 text-xs font-bold text-slate-400 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                    >
                      <ChevronLeft size={14} /> Voltar
                    </button>
                    <button
                      type="button"
                      onClick={handleAddVipCredit}
                      disabled={submitting || requestSuccess || !fromCharacter.trim()}
                      className="flex-[1.6] rounded-xl border border-violet-400/40 bg-gradient-to-r from-violet-600 to-violet-700 py-2.5 text-xs font-black text-white shadow-lg shadow-violet-950/30 transition-colors hover:from-violet-500 hover:to-violet-600 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                    >
                      {submitting ? "Enviando..." : "Solicitar VIP"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <footer className="app-modal-footer flex flex-wrap items-center justify-between gap-2 border-t border-violet-500/20 bg-black/30 px-4 py-3">
              <button
                type="button"
                onClick={() => setBenefitsOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-violet-400/30 bg-violet-500/[0.08] px-3 py-2 text-xs font-black text-violet-200 transition-colors hover:bg-violet-500/[0.16] cursor-pointer"
              >
                <Sparkles size={13} /> Benefícios Inclusos
              </button>
              <button
                type="button"
                onClick={closeModal}
                className="rounded-xl border border-white/10 px-3.5 py-2 text-xs font-bold text-slate-300 transition-colors hover:bg-white/5 hover:text-white cursor-pointer"
              >
                Fechar
              </button>
            </footer>
          </section>
        </div>,
        document.body,
      )}

      <VipBenefitsModal open={open && benefitsOpen} onClose={() => setBenefitsOpen(false)} />
    </>
  );
}

function PlanOption({
  days,
  priceRC,
  selected,
  onClick,
}: {
  days: number;
  priceRC: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-[112px] flex-col justify-between rounded-xl border p-3 text-left transition-all cursor-pointer ${
        selected
          ? "border-violet-400 bg-violet-500/18 shadow-md shadow-violet-950/40 ring-1 ring-violet-400/45"
          : "border-white/10 bg-black/35 opacity-80 hover:bg-white/[0.05] hover:opacity-100"
      }`}
    >
      <span className="flex items-center justify-between gap-2">
        <strong className="text-xs font-black text-white">Plano {days} Dias</strong>
        {selected && <Check size={14} className="flex-shrink-0 text-violet-200" />}
      </span>
      <span>
        <span className="block text-[10px] text-slate-400">Duração: <strong className="text-slate-200">{days} dias</strong></span>
        <strong className="mt-0.5 block text-sm font-black tabular-nums text-violet-300">{priceRC} RC</strong>
      </span>
    </button>
  );
}