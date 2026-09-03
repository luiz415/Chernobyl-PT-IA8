import { useState, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import publicFormBgUrl from "../assets/public-form-bg.jpg";
import { Clock, Save, CheckCircle2, AlertTriangle, MessageCircle, Swords, ShieldCheck, Timer, Phone } from "lucide-react";
import type { WaitingService, Vocation } from "../types";
import { VOCATIONS, VOC_COLORS, VOC_LABEL, todayISO } from "../types";
import { db, auth, isSimulationMode } from "../firebase/config";
import { doc, collection, query, where, getDocs } from "firebase/firestore";
import { setDoc } from "../firebase/config";
import ExoriLogo from "./ExoriLogo";
import { FilterSelect } from "./FilterTypes";
import { getEffectiveUserRole } from "../utils/vipAccess";
import { SERVER_OPTIONS } from "../constants/servers";
import { createServiceRequest } from "../services/sharedServicesService";

// ============================================================================
// CONFIGURAÇÕES — PREENCHA ANTES DE PUBLICAR
// ============================================================================
// Chave do site reCAPTCHA v3 (https://www.google.com/recaptcha/admin)
// Deixe vazio ("") para desativar o reCAPTCHA (não recomendado em produção)
const RECAPTCHA_SITE_KEY = "6LdW02ItAAAAAELunQmYCRGrr2qD-c0Dn-5kIMNO";

// Rate limiting
const MAX_SUBMISSIONS = 2;            // máximo de envios...
const WINDOW_MS = 10 * 60 * 200;     // ...dentro desta janela (2 minutos)
const BLOCK_MS = 10 * 60 * 1000;      // duração do bloqueio (10 minutos)
const RATE_KEY = "public_form_submissions";

// ============================================================================
// Rate limiting helpers (client-side, por navegador)
// ============================================================================
function getSubmissionTimestamps(): number[] {
  try {
    const raw = localStorage.getItem(RATE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((t: number) => typeof t === "number") : [];
  } catch { return []; }
}

function registerSubmission(): void {
  try {
    const now = Date.now();
    const list = getSubmissionTimestamps().filter(t => now - t < WINDOW_MS);
    list.push(now);
    localStorage.setItem(RATE_KEY, JSON.stringify(list));
  } catch {}
}

// Retorna 0 se liberado, ou o timestamp (ms) até quando está bloqueado
function getBlockedUntil(): number {
  const now = Date.now();
  const recent = getSubmissionTimestamps().filter(t => now - t < WINDOW_MS);
  if (recent.length >= MAX_SUBMISSIONS) {
    const oldest = Math.min(...recent);
    return oldest + BLOCK_MS;
  }
  return 0;
}

// ============================================================================
// reCAPTCHA v3 helpers
// ============================================================================
declare global {
  interface Window {
    grecaptcha?: {
      ready: (cb: () => void) => void;
      execute: (siteKey: string, opts: { action: string }) => Promise<string>;
    };
  }
}

function loadRecaptchaScript(): Promise<void> {
  return new Promise((resolve) => {
    if (!RECAPTCHA_SITE_KEY) { resolve(); return; }
    if (window.grecaptcha) { resolve(); return; }
    const script = document.createElement("script");
    script.src = `https://www.google.com/recaptcha/api.js?render=${RECAPTCHA_SITE_KEY}`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => resolve(); // não bloquear o form se o script falhar
    document.head.appendChild(script);
  });
}

async function getRecaptchaToken(): Promise<string> {
  if (!RECAPTCHA_SITE_KEY || !window.grecaptcha) return "";
  try {
    return await new Promise<string>((resolve) => {
      window.grecaptcha!.ready(async () => {
        try {
          const token = await window.grecaptcha!.execute(RECAPTCHA_SITE_KEY, { action: "submit_service" });
          resolve(token);
        } catch { resolve(""); }
      });
    });
  } catch { return ""; }
}

// ============================================================================
// Lista oficial de servidores — centralizada em src/constants/servers.ts
// ============================================================================

// ============================================================================
// Componente principal
// ============================================================================
type FormState = "filling" | "submitting" | "success" | "blocked";

function newId() { return "ws_" + Math.random().toString(36).slice(2) + Date.now().toString(36); }

export default function PublicServiceForm() {
  const [formState, setFormState] = useState<FormState>("filling");
  const [blockedUntil, setBlockedUntil] = useState<number>(0);
  const [countdown, setCountdown] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Campos do formulário
  const [personagem, setPersonagem] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [servidor, setServidor] = useState("");
  const [level, setLevel] = useState("");
  const [voc, setVoc] = useState<Vocation>("EK");
  const [quest, setQuest] = useState<"soulwar" | "sanguine">("soulwar");
  const [whatsCountry, setWhatsCountry] = useState("55");
  const [whatsArea, setWhatsArea] = useState("");
  const [whatsNumber, setWhatsNumber] = useState("");
  const [payment, setPayment] = useState<"pix" | "rc" | "5050" | "">("");
  const [notes, setNotes] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serviceiro, setServiceiro] = useState("Qualquer um");
  const [eligibleServiceiros, setEligibleServiceiros] = useState<Array<{ uid: string; nome: string }>>([]);

  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Carregar lista de serviceiros elegíveis (VIP + Boss aprovados).
  // IMPORTANTE: O PublicServiceForm é acessado por usuários não autenticados
  // (link público). A lista não precisa de tempo real, então usamos getDocs()
  // com cache temporário para evitar listener contínuo em users.
  useEffect(() => {
    let cancelled = false;

    async function loadServiceiros() {
      if (isSimulationMode || !db) {
        try {
          const raw = localStorage.getItem("tibia_sim_users");
          const parsed: any[] = raw ? JSON.parse(raw) : [];
          if (cancelled) return;
          setEligibleServiceiros(
            parsed
              .filter((u: any) => {
                const role = getEffectiveUserRole(u);
                return u.status === "aprovado" && (role === "Boss" || (role === "VIP" && u.serviceiro === true));
              })
              .map((u: any) => ({ uid: u.uid, nome: u.nome || u.email || "Anônimo" }))
          );
        } catch { if (!cancelled) setEligibleServiceiros([]); }
        return;
      }

      // Garantir autenticação anônima antes de consultar Firestore
      // (regras: isAuth() é obrigatório para ler "users")
      if (auth && !auth.currentUser) {
        try {
          const { signInAnonymously } = await import("firebase/auth");
          await signInAnonymously(auth);
        } catch { /* falha silenciosa — consulta abaixo falhará e lista ficará vazia */ }
      }

      if (cancelled) return;

      try {
        const q = query(collection(db, "users"), where("status", "==", "aprovado"));
        const snap = await getDocs(q);
        if (cancelled) return;
        const list: Array<{ uid: string; nome: string }> = [];
        snap.forEach(d => {
          const data = d.data();
          const role = getEffectiveUserRole(data);
          if (role === "Boss" || (role === "VIP" && data.serviceiro === true)) {
            list.push({ uid: d.id, nome: data.nome || "Anônimo" });
          }
        });
        setEligibleServiceiros(list);
      } catch { if (!cancelled) setEligibleServiceiros([]); }
    }

    loadServiceiros();

    return () => {
      cancelled = true;
    };
  }, []);

  // Carregar reCAPTCHA ao montar
  useEffect(() => {
    loadRecaptchaScript();
  }, []);

  // Verificar bloqueio ao montar e a cada segundo enquanto bloqueado
  useEffect(() => {
    const until = getBlockedUntil();
    if (until > Date.now()) {
      setBlockedUntil(until);
      setFormState("blocked");
    }
  }, []);

  useEffect(() => {
    if (formState !== "blocked") return;
    const interval = setInterval(() => {
      const remaining = blockedUntil - Date.now();
      if (remaining <= 0) {
        setFormState("filling");
        setCountdown("");
        clearInterval(interval);
        return;
      }
      const min = Math.floor(remaining / 60000);
      const sec = Math.floor((remaining % 60000) / 1000);
      setCountdown(`${min}:${String(sec).padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [formState, blockedUntil]);

  function validate(): boolean {
    const errors: Record<string, string> = {};
    if (!personagem.trim()) errors.personagem = "Informe o nome do personagem";
    if (!ownerName.trim()) errors.ownerName = "Informe o seu nome";
    if (!servidor.trim()) errors.servidor = "Informe o servidor";
    if (!whatsArea.trim() || !whatsNumber.trim()) errors.whats = "Informe o WhatsApp completo para contato";
    if (!payment) errors.payment = "Selecione a forma de pagamento";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);

    // Re-checar bloqueio
    const until = getBlockedUntil();
    if (until > Date.now()) {
      setBlockedUntil(until);
      setFormState("blocked");
      return;
    }

    if (!validate()) return;

    setFormState("submitting");

    try {
      // 1. reCAPTCHA
      const recaptchaToken = await getRecaptchaToken();
      if (RECAPTCHA_SITE_KEY && !recaptchaToken) {
        setErrorMsg("Falha na verificação de segurança (reCAPTCHA). Recarregue a página e tente novamente.");
        setFormState("filling");
        return;
      }

      // 2. Login anônimo no Firebase (necessário para as regras do Firestore)
      let uid = "public_anonymous";
      if (!isSimulationMode && auth) {
        const { signInAnonymously } = await import("firebase/auth");
        const cred = await signInAnonymously(auth);
        uid = cred.user.uid;
      }

      // 3. Montar o documento WaitingService
      //
      // ANOTAÇÕES: a forma de pagamento NÃO é mais concatenada aqui. Ela já
      // viaja no campo dedicado `paymentMethod` e é exibida na coluna "PGTO"
      // da tabela "Meus Services". Portanto "Anotações" carrega exclusivamente
      // o que o usuário anônimo digitou em "Observações (opcional)" — ficando
      // vazio quando ele não preenche nada.
      const publicNotes = notes.trim();
      const id = newId();
      const service: WaitingService & { source: string; recaptchaToken?: string; paymentMethod?: string } = {
        id,
        personagem: personagem.trim(),
        ownerName: ownerName.trim(),
        servidor: servidor.trim(),
        voc,
        level: parseInt(level || "0", 10) || 0,
        valorCombinado: 0, // será negociado pela equipe
        dataAdicionado: todayISO(),
        notes: publicNotes,
        paymentMethod: payment,
        whatsappCountry: whatsCountry.replace(/\D/g, ""),
        whatsappArea: whatsArea.replace(/\D/g, ""),
        whatsappNumber: whatsNumber.replace(/\D/g, ""),
        addedBy: serviceiro || "Qualquer um",
        quest,
        createdAt: Date.now(),
        createdBy: uid,
        createdByName: ownerName.trim(),
        source: "public_form",
        ...(recaptchaToken ? { recaptchaToken } : {}),
      };

      // 4. DESTINO DO PEDIDO — decidido pelo campo "Serviceiro".
      //
      //   • Serviceiro específico -> sharedServices/{uid}/incoming, aparecendo
      //     direto em "Meus Services" daquele usuário. NÃO vai para a Lista
      //     de Espera.
      //   • "Qualquer um"         -> waitingList, para atendimento pelo Boss.
      //
      // Os dois caminhos são exclusivos, então o personagem nunca é criado
      // nas duas estruturas.
      const chosen = eligibleServiceiros.find(
        u => u.nome.trim().toLowerCase() === (serviceiro || "").trim().toLowerCase()
      );
      const targetUid = chosen?.uid || "";

      if (isSimulationMode || !db) {
        try {
          const raw = localStorage.getItem("tibia_waiting_list");
          const list = raw ? JSON.parse(raw) : [];
          list.push(service);
          localStorage.setItem("tibia_waiting_list", JSON.stringify(list));
        } catch {}
      } else if (targetUid) {
        // Serviceiro específico: nasce como SOLICITAÇÃO PENDENTE, aguardando
        // aprovação do destinatário. Nada entra em sharedServices ainda.
        const created = await createServiceRequest(targetUid, {
          personagem: service.personagem,
          ownerName: service.ownerName,
          servidor: service.servidor,
          voc: service.voc,
          level: service.level,
          notes: service.notes,
          whatsappCountry: service.whatsappCountry,
          whatsappArea: service.whatsappArea,
          whatsappNumber: service.whatsappNumber,
          quest: service.quest,
          paymentMethod: payment,
        });
        if (!created.ok) throw new Error(created.error || "Falha ao enviar a solicitação ao Serviceiro.");
      } else {
        await setDoc(doc(db, "waitingList", id), JSON.parse(JSON.stringify(service)));
      }

      // 5. Registrar envio no rate limiter
      registerSubmission();

      setFormState("success");
    } catch (err: any) {
      console.error("Erro ao enviar service:", err);
      setErrorMsg("Não foi possível enviar sua solicitação. Tente novamente em instantes.");
      setFormState("filling");
    }
  }

  function resetForm() {
    // Checar bloqueio antes de liberar novo envio
    const until = getBlockedUntil();
    if (until > Date.now()) {
      setBlockedUntil(until);
      setFormState("blocked");
      return;
    }
    setPersonagem("");
    setOwnerName("");
    setServidor("");
    setLevel("");
    setVoc("EK");
    setQuest("soulwar");
    setWhatsArea("");
    setWhatsNumber("");
    setPayment("");
    setNotes("");
    setFieldErrors({});
    setServiceiro("Qualquer um");
    setFormState("filling");
  }

  const inputCls = "w-full bg-[var(--th-n-panel)] border border-white/10 focus:border-cyan-500/60 rounded-xl px-4 py-3 text-white text-sm focus:outline-none placeholder-slate-600 transition-colors";
  const labelCls = "block text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-2";

  return (
    <div className="public-service-form min-h-screen w-full text-slate-200 font-sans relative overflow-x-hidden">
      {/* Imagem de fundo fixa */}
      <div
        className="fixed inset-0 pointer-events-none bg-[var(--th-n-raised)]"
        style={{
          backgroundImage: `url(${publicFormBgUrl})`,
          backgroundSize: '100%',
          backgroundPosition: '50% 50%',
          backgroundRepeat: 'no-repeat',
          zIndex: 0,
        }}
      />
      {/* Overlay escuro sobre a imagem */}
      <div className="fixed inset-0 bg-[var(--th-n-raised)]/90 pointer-events-none" style={{ zIndex: 1 }} />
      {/* Background glow effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none" style={{ zIndex: 2 }}>
        <div className="absolute -top-[20%] -left-[10%] w-[60%] h-[60%] rounded-full bg-red-600/8 blur-[140px]" />
        <div className="absolute -bottom-[20%] -right-[10%] w-[60%] h-[60%] rounded-full bg-cyan-500/8 blur-[140px]" />
        <div className="absolute top-[30%] left-[40%] w-[40%] h-[40%] rounded-full bg-amber-500/5 blur-[120px]" />
      </div>

      {/* ===== CABEÇALHO FIXO — Logo + Nome SEMPRE visíveis ao rolar ===== */}
      {/* Usa position:fixed (em vez de sticky) porque o container pai tem
          overflow-x-hidden, o que quebra o comportamento do sticky. */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-[var(--th-n-raised)]/50 backdrop-blur-md border-b border-white/5 shadow-lg shadow-black/100">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-0 flex items-center justify-center gap-3">
          <ExoriLogo size={35} className="drop-shadow-[0_0_12px_color-mix(in_oklab,var(--color-red-600)_60%,transparent)] flex-shrink-0" />
          <div className="text-center">
            <h1 className="text-xl sm:text-3xl font-black bg-gradient-to-r from-red-600 via-orange-500 to-yellow-400 bg-clip-text text-transparent tracking-tight leading-none" style={{ filter: "drop-shadow(0 0 8px color-mix(in oklab, var(--color-red-600) 40%, transparent))" }}>
              Chernobyl PT
            </h1>
            <p className="text-left text-emerald-400 text-[6px] tracking-widest uppercase font-semibold leading-tight mt-0">By Exori Coins</p>
          </div>
        </div>
      </header>

      {/* pt-24: compensa a altura do header fixo para o conteúdo não ficar escondido */}
      <div className="relative z-10 w-full max-w-3xl mx-auto px-3 sm:px-6 pt-28 pb-12">
        {/* ===== QUADRO: INFORMAÇÕES SOBRE O SERVICE ===== */}
        <div className="psf-quadro bg-[var(--th-n-elev)] border border-amber-500/50 rounded-3xl shadow-2xl mb-8" style={{ "--psf-quadro-accent": "#f59e0b" } as CSSProperties}>
          {/* Título do quadro */}
          <div className="psf-quadro-header bg-gradient-to-r from-amber-500/10 via-amber-500/15 to-amber-500/10 border-b border-amber-500/20 px-7 py-5 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center flex-shrink-0">
              <Swords size={20} className="text-black" />
            </div>
            <div>
              <h2 className="text-base font-black text-amber-300 tracking-wide uppercase">Informações sobre o Service</h2>
              <p className="text-[11px] text-slate-500">Leia com atenção antes de solicitar</p>
            </div>
          </div>

          <div className="psf-quadro-inner px-4 py-6 sm:p-7 space-y-6">
            {/* ===== LEVEL MÍNIMO EXIGIDO ===== */}
            <div>
              <h3 className="flex items-center gap-2 text-sm font-black text-white uppercase tracking-wider mb-4">
                <span className="w-7 h-7 rounded-lg bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-sm">📊</span>
                Level Mínimo Exigido
              </h3>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {/* Sorcerer */}
                <div className="psf-voc bg-[var(--th-n-panel)] border rounded-2xl p-3 text-center" style={{ "--voc-color": VOC_COLORS.MS } as CSSProperties}>
                  <div className="psf-voc-letter text-base font-black tracking-wider mb-0.5" style={{ color: VOC_COLORS.MS }}>MS</div>
                  <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1.5">Sorcerer</div>
                  <div className="psf-voc-badge inline-flex items-center px-2 py-0.5 rounded-full text-xs font-black tabular-nums border" style={{ color: VOC_COLORS.MS, borderColor: `${VOC_COLORS.MS}44`, backgroundColor: `${VOC_COLORS.MS}11` }}>400+</div>
                </div>
                {/* Druid */}
                <div className="psf-voc bg-[var(--th-n-panel)] border rounded-2xl p-3 text-center" style={{ "--voc-color": VOC_COLORS.ED } as CSSProperties}>
                  <div className="psf-voc-letter text-base font-black tracking-wider mb-0.5" style={{ color: VOC_COLORS.ED }}>ED</div>
                  <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1.5">Druid</div>
                  <div className="psf-voc-badge inline-flex items-center px-2 py-0.5 rounded-full text-xs font-black tabular-nums border" style={{ color: VOC_COLORS.ED, borderColor: `${VOC_COLORS.ED}44`, backgroundColor: `${VOC_COLORS.ED}11` }}>400+</div>
                </div>
                {/* Knight */}
                <div className="psf-voc bg-[var(--th-n-panel)] border rounded-2xl p-3 text-center" style={{ "--voc-color": VOC_COLORS.EK } as CSSProperties}>
                  <div className="psf-voc-letter text-base font-black tracking-wider mb-0.5" style={{ color: VOC_COLORS.EK }}>EK</div>
                  <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1.5">Knight</div>
                  <div className="psf-voc-badge inline-flex items-center px-2 py-0.5 rounded-full text-xs font-black tabular-nums border" style={{ color: VOC_COLORS.EK, borderColor: `${VOC_COLORS.EK}44`, backgroundColor: `${VOC_COLORS.EK}11` }}>550+</div>
                </div>
                {/* Paladin */}
                <div className="psf-voc bg-[var(--th-n-panel)] border rounded-2xl p-3 text-center" style={{ "--voc-color": VOC_COLORS.RP } as CSSProperties}>
                  <div className="psf-voc-letter text-base font-black tracking-wider mb-0.5" style={{ color: VOC_COLORS.RP }}>RP</div>
                  <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1.5">Paladin</div>
                  <div className="psf-voc-badge inline-flex items-center px-2 py-0.5 rounded-full text-xs font-black tabular-nums border" style={{ color: VOC_COLORS.RP, borderColor: `${VOC_COLORS.RP}44`, backgroundColor: `${VOC_COLORS.RP}11` }}>500+</div>
                </div>
                {/* Monk */}
                <div className="psf-voc bg-[var(--th-n-panel)] border rounded-2xl p-3 text-center col-span-2 sm:col-span-1" style={{ "--voc-color": VOC_COLORS.MK } as CSSProperties}>
                  <div className="psf-voc-letter text-base font-black tracking-wider mb-0.5" style={{ color: VOC_COLORS.MK }}>MK</div>
                  <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1.5">Monk</div>
                  <div className="psf-voc-badge inline-flex items-center px-2 py-0.5 rounded-full text-xs font-black tabular-nums border" style={{ color: VOC_COLORS.MK, borderColor: `${VOC_COLORS.MK}44`, backgroundColor: `${VOC_COLORS.MK}11` }}>550+</div>
                </div>
              </div>
            </div>

            {/* Divisor */}
            <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

            {/* ===== FORMAS DE PAGAMENTO ===== */}
            <div>
              <h3 className="flex items-center gap-2 text-sm font-black text-white uppercase tracking-wider mb-4">
                <span className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-sm">💰</span>
                Formas de Pagamento
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Service Padrão */}
                <div className="psf-card bg-[var(--th-n-panel)] border border-sky-500/20 rounded-2xl p-4 space-y-2" style={{ "--psf-accent": "#38bdf8" } as CSSProperties}>
                  <div className="flex items-center gap-2 text-sky-300 font-bold text-sm">
                    <span>💎</span> Service Padrão
                  </div>
                  <ul className="text-xs text-slate-300 space-y-1.5 leading-relaxed">
                    <li className="flex items-start gap-1.5">
                      <span className="text-sky-400 mt-0.5">•</span>
                      <span><strong className="text-white">1k Rubini Coins</strong> + 10kk de refil</span>
                    </li>
                    <li className="text-center text-slate-500 text-[10px] font-bold uppercase">ou</li>
                    <li className="flex items-start gap-1.5">
                      <span className="text-sky-400 mt-0.5">•</span>
                      <span><strong className="text-white">Pix R$ 91,00</strong> + 10kk de refil</span>
                    </li>
                  </ul>
                </div>

                {/* Service 50/50 */}
                <div className="psf-card bg-[var(--th-n-panel)] border border-violet-500/20 rounded-2xl p-4 space-y-2" style={{ "--psf-accent": "#a78bfa" } as CSSProperties}>
                  <div className="flex items-center gap-2 text-violet-300 font-bold text-sm">
                    <span>⚖️</span> Service 50/50
                  </div>
                  <ul className="text-xs text-slate-300 space-y-1.5 leading-relaxed">
                    <li className="flex items-start gap-1.5">
                      <span className="text-violet-400 mt-0.5">•</span>
                      <span>O cliente paga apenas <strong className="text-white">250 Rubini Coins</strong> + 10kk de refil.</span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="text-violet-400 mt-0.5">•</span>
                      <span>Após a venda do item principal, o valor arrecadado é <strong className="text-white">dividido igualmente</strong> entre o cliente e o serviceiro.</span>
                    </li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Divisor */}
            <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

            {/* ===== DROPS E RECOMPENSAS ===== */}
            <div>
              <h3 className="flex items-center gap-2 text-sm font-black text-white uppercase tracking-wider mb-4">
                <span className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-sm">🎁</span>
                Drops e Recompensas
              </h3>

              <div className="space-y-3">
                {/* No Service Padrão */}
                <div className="psf-card bg-[var(--th-n-panel)] border border-white/5 rounded-2xl p-4 space-y-2.5" style={{ "--psf-accent": "#38bdf8" } as CSSProperties}>
                  <div className="flex items-center gap-2 text-sky-300 font-bold text-xs uppercase tracking-wider">
                    <span>💎</span> No Service Padrão
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    • Deixamos seu personagem pronto para abrir a reward e receber sua recompensa.
                  </p>
                  <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl px-3.5 py-3 space-y-1.5">
                    <p className="text-xs text-slate-300 leading-relaxed">
                      🏆 <strong className="text-amber-300">Todos os baús de loot dos bosses pertencem ao cliente</strong> e permanecem na reward, com exceção dos <strong className="text-yellow-400">drops amarelos</strong>, como:
                    </p>
                    <ul className="text-[11px] text-slate-400 space-y-0.5 pl-4">
                      <li>• Bag You Desire</li>
                      <li>• The Skull of a Beast</li>
                      <li>• Spectral Horseshoes</li>
                      <li>• Entre outros itens de categoria amarela.</li>
                    </ul>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      🤝 Esses itens são compartilhados entre a equipe responsável pelo service.
                    </p>
                  </div>
                </div>

                {/* No Service 50/50 */}
                <div className="psf-card bg-[var(--th-n-panel)] border border-violet-500/15 rounded-2xl p-4 space-y-2" style={{ "--psf-accent": "#a78bfa" } as CSSProperties}>
                  <div className="flex items-center gap-2 text-violet-300 font-bold text-xs uppercase tracking-wider">
                    <span>⭐</span> No Service 50/50
                  </div>
                  <ul className="text-xs text-slate-300 space-y-1.5 leading-relaxed">
                    <li>📦 Nesta modalidade, <strong className="text-white">todos os baús de loot dos bosses ficam com a equipe</strong> de serviceiros.</li>
                    <li>🎥 A abertura da reward é <strong className="text-white">gravada</strong> e o vídeo é enviado diretamente para o seu WhatsApp.</li>
                    <li>💰 Após a venda do item principal, <strong className="text-emerald-300">50% do valor é transferida em Rubini Coins</strong> para você.</li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Divisor */}
            <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

            {/* ===== FUNCIONAMENTO DO SERVICE ===== */}
            <div>
              <h3 className="flex items-center gap-2 text-sm font-black text-white uppercase tracking-wider mb-4">
                <span className="w-7 h-7 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sm">⚙️</span>
                Como funciona o Service
              </h3>

              <div className="space-y-2.5 text-xs text-slate-300 leading-relaxed">
                <p className="flex items-start gap-2">
                  <span className="flex-shrink-0">⏳</span>
                  <span>O cliente é <strong className="text-white">incluído automaticamente na fila de espera</strong>. Assim que houver uma PT disponível, entraremos em contato via WhatsApp informando o horário agendado para a realização do service.</span>
                </p>
                <p className="flex items-start gap-2">
                  <span className="flex-shrink-0">⏱️</span>
                  <span>O service possui <strong className="text-white">duração média entre 2 e 4 horas</strong>, podendo variar de acordo com o level dos personagens, composição e desempenho da PT.</span>
                </p>
                <p className="flex items-start gap-2">
                  <span className="flex-shrink-0">👥</span>
                  <span>Nossa equipe é formada por <strong className="text-white">jogadores experientes</strong> e preparados para realizar o serviço com o máximo de segurança, eficiência e profissionalismo.</span>
                </p>
                <p className="flex items-start gap-2">
                  <span className="flex-shrink-0">🛡️</span>
                  <span>Como em qualquer atividade online, podem ocorrer situações imprevistas durante a execução do service, como instabilidades do jogo, desconexões, quedas de energia, problemas de internet ou outros fatores externos.</span>
                </p>
                <p className="flex items-start gap-2">
                  <span className="flex-shrink-0">💀</span>
                  <span>Embora esse tipo de ocorrência seja incomum, <strong className="text-rose-300">eventuais mortes não geram reembolso ou compensação</strong>, independentemente da causa. Nosso compromisso é sempre minimizar riscos e concluir o serviço da forma mais segura possível.</span>
                </p>
              </div>

              {/* Aviso de aceite */}
              <div className="mt-4 flex items-start gap-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3 text-xs text-emerald-200 leading-relaxed">
                <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5 text-emerald-400" />
                <span>
                  <strong>Ao contratar o service, o cliente declara estar ciente e de acordo com todas as condições descritas acima.</strong>
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* ===== ESTADO: BLOQUEADO (rate limit) ===== */}
        {formState === "blocked" && (
          <div className="bg-[var(--th-n-elev)] border border-amber-500/30 rounded-3xl shadow-2xl p-10 text-center space-y-5">
            <div className="w-20 h-20 rounded-2xl bg-amber-500/10 border border-amber-500/40 flex items-center justify-center mx-auto">
              <Timer size={36} className="text-amber-400" />
            </div>
            <h2 className="text-xl font-bold text-white">Limite de envios atingido</h2>
            <p className="text-sm text-slate-400 max-w-sm mx-auto leading-relaxed">
              Você adicionou vários personagens em pouco tempo. Para evitar abusos,
              novos envios estão temporariamente bloqueados.
            </p>
            <div className="inline-flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl px-6 py-4">
              <Clock size={20} className="text-amber-400" />
              <span className="text-2xl font-black font-mono text-amber-300 tabular-nums">{countdown || "..."}</span>
            </div>
            <p className="text-xs text-slate-500">Aguarde o tempo acima para enviar novamente.</p>
          </div>
        )}

        {/* ===== ESTADO: SUCESSO ===== */}
        {formState === "success" && (
          <div className="bg-[var(--th-n-elev)] border border-emerald-500/30 rounded-3xl shadow-2xl p-10 text-center space-y-5">
            <div className="w-20 h-20 rounded-full bg-emerald-500/15 border border-emerald-500/50 flex items-center justify-center mx-auto animate-in zoom-in duration-300">
              <CheckCircle2 size={40} className="text-emerald-400" />
            </div>
            <h2 className="text-2xl font-bold text-white">Solicitação enviada!</h2>
            <p className="text-sm text-slate-400 max-w-sm mx-auto leading-relaxed">
              Seu personagem foi adicionado à nossa lista de espera com sucesso.
              Em breve entraremos em contato pelo WhatsApp informado para combinar
              o valor e o horário do service.
            </p>
            <div className="pt-3">
              <button
                type="button"
                onClick={resetForm}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-300 hover:text-cyan-200 text-sm font-bold transition-colors cursor-pointer"
              >
                <Swords size={16} /> Adicionar outro personagem
              </button>
            </div>
          </div>
        )}

        {/* ===== TEXTO ENTRE OS DOIS QUADROS ===== */}
        {(formState === "filling" || formState === "submitting") && (
          <div className="text-center mb-8">
            <p className="text-slate-400 text-sm max-w-md mx-auto leading-relaxed">
              Preencha o formulário abaixo para solicitar o service do seu personagem.
              Nossa equipe entrará em contato pelo WhatsApp para combinar os detalhes.
            </p>
          </div>
        )}

        {/* ===== ESTADO: FORMULÁRIO ===== */}
        {(formState === "filling" || formState === "submitting") && (
          <form onSubmit={handleSubmit} className="psf-quadro bg-[var(--th-n-elev)] border border-cyan-500/50 rounded-3xl shadow-2xl" style={{ "--psf-quadro-accent": "#22d3ee" } as CSSProperties}>
            {/* Banner do tipo de quest */}
            <div className="psf-quadro-header bg-gradient-to-r from-cyan-500/10 via-cyan-500/15 to-cyan-500/10 border-b border-cyan-500/20 px-7 py-5 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-sky-600 flex items-center justify-center flex-shrink-0">
                <Clock size={20} className="text-black" />
              </div>
              <div>
                <h2 className="text-base font-black text-cyan-300 tracking-wide uppercase">Solicitar Service</h2>
                <p className="text-[11px] text-slate-500">Todos os campos com * são obrigatórios</p>
              </div>
            </div>

            <div className="psf-quadro-inner px-4 py-6 sm:p-7 space-y-6">
              {/* Erro geral */}
              {errorMsg && (
                <div className="flex items-start gap-3 bg-rose-500/10 border border-rose-500/30 rounded-xl px-4 py-3 text-sm text-rose-300">
                  <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {/* Nome do personagem + Seu nome */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div>
                  <label className={labelCls}>Nome do Personagem *</label>
                  <input
                    ref={firstFieldRef}
                    type="text"
                    value={personagem}
                    onChange={e => { setPersonagem(e.target.value.replace(/[^A-Za-zÀ-ÿ\s]/g, "")); if (fieldErrors.personagem) setFieldErrors(f => ({ ...f, personagem: "" })); }}
                    placeholder="Ex: Sir Knight"
                    maxLength={50}
                    className={`${inputCls} ${fieldErrors.personagem ? "border-rose-500/60" : ""}`}
                  />
                  {fieldErrors.personagem && <div className="text-[10px] text-rose-400 mt-1.5">{fieldErrors.personagem}</div>}
                </div>
                <div>
                  <label className={labelCls}>Seu Nome *</label>
                  <input
                    type="text"
                    value={ownerName}
                    onChange={e => { setOwnerName(e.target.value.replace(/[^A-Za-zÀ-ÿ\s]/g, "")); if (fieldErrors.ownerName) setFieldErrors(f => ({ ...f, ownerName: "" })); }}
                    placeholder="Como podemos te chamar"
                    maxLength={50}
                    className={`${inputCls} ${fieldErrors.ownerName ? "border-rose-500/60" : ""}`}
                  />
                  {fieldErrors.ownerName && <div className="text-[10px] text-rose-400 mt-1.5">{fieldErrors.ownerName}</div>}
                </div>
              </div>

              {/* Servidor + Level */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div>
                  <label className={labelCls}>Servidor *</label>
                  <FilterSelect
                    selected={servidor}
                    onSelect={(v: string) => { setServidor(v); if (fieldErrors.servidor) setFieldErrors(f => ({ ...f, servidor: "" })); }}
                    options={SERVER_OPTIONS}
                    placeholder="Selecione o servidor"
                    searchable
                    searchPlaceholder="Buscar servidor..."
                    allLabel=""
                    activeColor="cyan"
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-[var(--th-n-elev)] border border-white/[0.07] hover:border-white/15 focus:border-cyan-500/50 focus:outline-none transition-colors text-sm ${!servidor ? "text-slate-500" : "text-slate-200"}`}
                  />
                  {fieldErrors.servidor && <div className="text-[10px] text-rose-400 mt-1.5">{fieldErrors.servidor}</div>}
                </div>
                <div>
                  <label className={labelCls}>Level do Personagem</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={level}
                    onChange={e => setLevel(e.target.value.replace(/\D/g, "").slice(0, 5))}
                    placeholder="Ex: 250"
                    className={inputCls}
                  />
                </div>
              </div>

              {/* Vocação */}
              <div>
                <label className={labelCls}>Vocação *</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
                  {VOCATIONS.map(v => {
                    const color = VOC_COLORS[v];
                    const selected = voc === v;
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setVoc(v)}
                        data-selected={selected ? "true" : "false"}
                        className="psf-voc relative flex flex-col items-center justify-center px-1 py-3.5 rounded-xl border-2 bg-white/[0.02] cursor-pointer"
                        style={{ "--voc-color": color } as CSSProperties}
                        title={VOC_LABEL[v]}
                      >
                        <span className="text-base font-black tracking-wider" style={{ color }}>{v}</span>
                        <span className="text-[8px] text-slate-500 mt-1 leading-tight text-center hidden sm:block">{VOC_LABEL[v]}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Quest */}
              <div>
                <label className={labelCls}>service para qual quest? *</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setQuest("soulwar")}
                    style={{ "--psf-accent": "#cbd5e1" } as CSSProperties}
                    className={`psf-choice px-4 py-4 rounded-xl border-2 font-bold cursor-pointer text-sm tracking-wider ${
                      quest === "soulwar"
                        ? "border-slate-300 bg-slate-500/15 text-white shadow-lg shadow-slate-500/10 scale-[1.02]"
                        : "border-white/10 bg-white/[0.02] text-slate-500 hover:bg-white/5"
                    }`}
                  >
                    ⚔️ SOULWAR
                  </button>
                  <button
                    type="button"
                    disabled
                    title="Sanguine temporariamente indisponível"
                    className="px-4 py-4 rounded-xl border-2 border-white/5 bg-white/[0.01] text-slate-700 font-bold text-sm tracking-wider cursor-not-allowed opacity-50 relative"
                  >
                    🩸 SANGUINE
                    <span className="absolute -top-2 -right-2 px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-400 text-[8px] font-black uppercase tracking-wider">
                      Em breve
                    </span>
                  </button>
                </div>
              </div>

              {/* WhatsApp */}
              <div>
                <label className={labelCls}>
                  <span className="inline-flex items-center gap-1.5">
                    <Phone size={12} className="text-emerald-400" /> WhatsApp para contato *
                  </span>
                </label>
                <div className="grid grid-cols-[70px_70px_1fr] sm:grid-cols-[80px_80px_1fr] gap-2">
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none text-sm font-bold">+</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={whatsCountry}
                      onChange={e => setWhatsCountry(e.target.value.replace(/\D/g, "").slice(0, 3))}
                      placeholder="55"
                      className={`${inputCls} pl-7 text-center tabular-nums font-mono`}
                      maxLength={3}
                    />
                  </div>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={whatsArea}
                    onChange={e => { setWhatsArea(e.target.value.replace(/\D/g, "").slice(0, 3)); if (fieldErrors.whats) setFieldErrors(f => ({ ...f, whats: "" })); }}
                    placeholder="DDD"
                    className={`${inputCls} text-center tabular-nums font-mono ${fieldErrors.whats ? "border-rose-500/60" : ""}`}
                    maxLength={3}
                  />
                  <input
                    type="text"
                    inputMode="numeric"
                    value={whatsNumber}
                    onChange={e => { setWhatsNumber(e.target.value.replace(/\D/g, "").slice(0, 11)); if (fieldErrors.whats) setFieldErrors(f => ({ ...f, whats: "" })); }}
                    placeholder="999999999"
                    className={`${inputCls} tabular-nums font-mono ${fieldErrors.whats ? "border-rose-500/60" : ""}`}
                    maxLength={11}
                  />
                </div>
                {fieldErrors.whats
                  ? <div className="text-[10px] text-rose-400 mt-1.5">{fieldErrors.whats}</div>
                  : <div className="text-[10px] text-slate-600 mt-1.5">Usaremos este número para combinar valor e horário do service.</div>
                }
              </div>
              {/* Serviceiro */}
              <div>
                <label className={labelCls}>Serviceiro</label>
                <FilterSelect
                  selected={serviceiro}
                  onSelect={(v: string) => setServiceiro(v)}
                  options={eligibleServiceiros.map(u => u.nome).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }))}
                  placeholder="Selecione serviceiro"
                  searchable
                  searchPlaceholder="Buscar serviceiro..."
                  allLabel="Qualquer um"
                  allValue="Qualquer um"
                  activeColor="cyan"
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-[var(--th-n-elev)] border border-white/[0.07] hover:border-white/15 focus:border-cyan-500/50 focus:outline-none transition-colors text-sm ${!serviceiro ? "text-slate-500" : "text-slate-200"}`}
                />
                <div className="text-[10px] text-slate-600 mt-1.5">Deixe "Qualquer um" para qualquer serviceiro disponível, ou selecione um específico.</div>
              </div>

              {/* Pagamento */}
              <div>
                <label className={labelCls}>Forma de Pagamento *</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {/* PIX */}
                  <button
                    type="button"
                    onClick={() => { setPayment("pix"); if (fieldErrors.payment) setFieldErrors(f => ({ ...f, payment: "" })); }}
                    style={{ "--psf-accent": "#34d399" } as CSSProperties}
                    className={`psf-choice flex flex-col items-center justify-center px-3 py-4 rounded-xl border-2 cursor-pointer text-center ${
                      payment === "pix"
                        ? "border-emerald-500 bg-emerald-500/15 shadow-lg shadow-emerald-500/15 scale-[1.02]"
                        : `bg-white/[0.02] hover:bg-white/5 ${fieldErrors.payment ? "border-rose-500/40" : "border-white/10"}`
                    }`}
                  >
                    <span className={`psf-pay-title text-base font-black tracking-wider ${payment === "pix" ? "text-emerald-300" : "text-slate-300"}`}>💸 PIX</span>
                    <span className={`psf-pay-value text-lg font-black mt-1 ${payment === "pix" ? "text-emerald-400" : "text-slate-400"}`}>R$ 91</span>
                  </button>
                  {/* RC */}
                  <button
                    type="button"
                    onClick={() => { setPayment("rc"); if (fieldErrors.payment) setFieldErrors(f => ({ ...f, payment: "" })); }}
                    style={{ "--psf-accent": "#fbbf24" } as CSSProperties}
                    className={`psf-choice flex flex-col items-center justify-center px-3 py-4 rounded-xl border-2 cursor-pointer text-center ${
                      payment === "rc"
                        ? "border-amber-500 bg-amber-500/15 shadow-lg shadow-amber-500/15 scale-[1.02]"
                        : `bg-white/[0.02] hover:bg-white/5 ${fieldErrors.payment ? "border-rose-500/40" : "border-white/10"}`
                    }`}
                  >
                    <span className={`psf-pay-title text-base font-black tracking-wider ${payment === "rc" ? "text-amber-300" : "text-slate-300"}`}>🪙 RC</span>
                    <span className={`psf-pay-value text-lg font-black mt-1 ${payment === "rc" ? "text-amber-400" : "text-slate-400"}`}>1 K</span>
                  </button>
                  {/* 50/50 */}
                  <button
                    type="button"
                    onClick={() => { setPayment("5050"); if (fieldErrors.payment) setFieldErrors(f => ({ ...f, payment: "" })); }}
                    style={{ "--psf-accent": "#a78bfa" } as CSSProperties}
                    className={`psf-choice flex flex-col items-center justify-center px-3 py-4 rounded-xl border-2 cursor-pointer text-center ${
                      payment === "5050"
                        ? "border-violet-500 bg-violet-500/15 shadow-lg shadow-violet-500/15 scale-[1.02]"
                        : `bg-white/[0.02] hover:bg-white/5 ${fieldErrors.payment ? "border-rose-500/40" : "border-white/10"}`
                    }`}
                  >
                    <span className={`psf-pay-title text-base font-black tracking-wider ${payment === "5050" ? "text-violet-300" : "text-slate-300"}`}>⚖️ 50/50</span>
                    <span className={`psf-pay-subtitle text-xs font-bold mt-1 ${payment === "5050" ? "text-violet-400" : "text-slate-400"}`}>250 RC + metade do item</span>
                  </button>
                </div>
                {fieldErrors.payment && <div className="text-[10px] text-rose-400 mt-1.5">{fieldErrors.payment}</div>}
                {payment === "5050" && (
                  <div className="mt-3 flex items-start gap-2.5 bg-violet-500/10 border border-violet-500/30 rounded-xl px-4 py-3 text-[11px] text-violet-200 leading-relaxed animate-in fade-in slide-in-from-top-2 duration-200">
                    <ShieldCheck size={16} className="flex-shrink-0 mt-0.5 text-violet-400" />
                    <span>
                      <strong>Como funciona o 50/50:</strong> você paga 250 RC + e recebe metade do valor da venda do item dropado.
                      Gravamos a abertura do baú e enviamos o vídeo diretamente para o seu WhatsApp.
                    </span>
                  </div>
                )}
              </div>
              {/* Anotações */}
              <div>
                <label className={labelCls}>Observações (opcional)</label>
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value.slice(0, 300))}
                  rows={3}
                  placeholder="Alguma informação adicional que devemos saber..."
                  className={`${inputCls} resize-none`}
                  maxLength={300}
                />
                <div className="text-right text-[10px] text-slate-600 mt-1">{notes.length}/300</div>
              </div>

              {/* Botão enviar */}
              <button
                type="submit"
                disabled={formState === "submitting"}
                className="psf-submit w-full py-4 rounded-2xl text-base font-black tracking-wide text-black bg-gradient-to-r from-cyan-400 to-sky-500 hover:from-cyan-300 hover:to-sky-400 shadow-xl shadow-cyan-500/25 hover:shadow-cyan-500/40 transition-all duration-300 cursor-pointer flex items-center justify-center gap-2.5 hover:scale-[1.015] active:scale-[0.985] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
              >
                {formState === "submitting" ? (
                  <>
                    <div className="w-5 h-5 rounded-full border-2 border-black/40 border-t-black animate-spin" />
                    Enviando...
                  </>
                ) : (
                  <>
                    <Save size={19} /> Enviar Solicitação
                  </>
                )}
              </button>

              {/* Selo de segurança */}
              <div className="flex items-center justify-center gap-2 text-[10px] text-slate-600 pt-1">
                <ShieldCheck size={13} className="text-emerald-500/60" />
                {RECAPTCHA_SITE_KEY
                  ? <span>Protegido por reCAPTCHA · Google <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-400">Privacidade</a> · <a href="https://policies.google.com/terms" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-400">Termos</a></span>
                  : <span>Conexão segura · Seus dados são usados apenas para contato</span>
                }
              </div>
            </div>
          </form>
        )}

        {/* ===== RODAPÉ ===== */}
        <div className="text-center mt-10 space-y-2">
          <div className="flex items-center justify-center gap-2 text-[11px] text-slate-600">
            <MessageCircle size={12} className="text-emerald-500/60" />
            <span>Dúvidas? Fale conosco: <a href="https://wa.me/5535999349969" target="_blank" rel="noopener noreferrer" className="text-emerald-400/80 hover:text-emerald-300 font-semibold">WhatsApp do Suporte</a></span>
          </div>
          <p className="text-[10px] text-slate-700">Chernobyl PT · By Exori Coins</p>
        </div>
      </div>
    </div>
  );
}