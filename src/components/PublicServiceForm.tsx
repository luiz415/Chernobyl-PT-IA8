import { useState, useEffect, useRef, useMemo } from "react";
import type { CSSProperties } from "react";
import publicFormBgUrl from "../assets/public-form-bg.jpg";
import { Clock, Save, CheckCircle2, AlertTriangle, MessageCircle, Swords, ShieldCheck, Timer, Phone, ChevronLeft, ChevronRight, Check, XCircle } from "lucide-react";
import type { WaitingService, Vocation } from "../types";
import { VOCATIONS, VOC_COLORS, VOC_LABEL, todayISO } from "../types";
import { db, auth, isSimulationMode } from "../firebase/config";
import { collection, query, where, getDocs } from "firebase/firestore";
import ExoriLogo from "./ExoriLogo";
import { FilterSelect } from "./FilterTypes";
import { getEffectiveUserRole } from "../utils/vipAccess";
import { SERVER_OPTIONS } from "../constants/servers";
import { createServiceRequest } from "../services/sharedServicesService";
import { DUPLICATE_SERVICE_MESSAGE, createWithQueueGuard } from "../services/serviceQueueIndexService";
import { getServiceFormIdFromLocation, resolveServiceFormTarget } from "../utils/serviceFormSlug";
import type { PublicQuest } from "../utils/publicServiceLevels";
import { PUBLIC_QUEST_LABEL, publicMinLevelFor, publicLevelBlockReason } from "../utils/publicServiceLevels";
import {
  SERVICE_FORM_CONFIG_DEFAULTS,
  UNAVAILABLE_SERVER_SUFFIX,
  resolveServiceFormConfig,
  isServerAttended,
  formatConfigRcLong,
  formatConfigRcCard,
  formatConfigPixLong,
  formatConfigPixCard,
  type ResolvedServiceFormConfig,
} from "../utils/serviceFormConfig";

// ============================================================================
// CONFIGURAÇÕES — PREENCHA ANTES DE PUBLICAR
// ============================================================================
// Chave do site reCAPTCHA v3 (https://www.google.com/recaptcha/admin)
// Deixe vazio ("") para desativar o reCAPTCHA (não recomendado em produção)
const RECAPTCHA_SITE_KEY = "6LdW02ItAAAAAELunQmYCRGrr2qD-c0Dn-5kIMNO";

// ============================================================================
// PAUSA TEMPORÁRIA DA SOUL WAR
// ============================================================================
// A opção continua VISÍVEL na Etapa 1, mas não pode ser selecionada; um
// tooltip explica o motivo (hover no desktop, toque no mobile). O bloqueio
// também vale na lógica de envio (handleSubmit) — não é só visual.
// PARA REATIVAR O SERVICE DE SOUL WAR: basta mudar a flag para false.
const SOULWAR_PAUSED = true;
const SOULWAR_PAUSED_TITLE = "Service temporariamente indisponível:";
const SOULWAR_PAUSED_MESSAGE =
  "pausamos temporariamente o Service de Soul War até que a Quest e os valores dos itens " +
  "estejam estabilizados. As mudanças recentes tornaram o Service extremamente cansativo e arriscado.";

// Quest desabilitada PELO DONO do link exclusivo (users/{uid}.serviceFormConfig,
// modal "Configurar Meu Formulário"). O bloqueio GLOBAL acima (SOULWAR_PAUSED)
// sempre prevalece sobre a configuração individual.
const OWNER_DISABLED_TITLE = "Service indisponível neste formulário:";
function ownerDisabledMessage(questName: string): string {
  return `este serviceiro não está oferecendo o Service de ${questName} no momento.`;
}

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
// ETAPAS DO FORMULÁRIO
//
// O formulário público funciona em 6 etapas; TODO o estado vive no
// componente principal, então avançar/voltar NUNCA perde dados:
//   1 Quest      → boas-vindas + escolha Soul War / Sanguine;
//   2 Termos     → informações DA QUEST ESCOLHIDA + aceite obrigatório;
//   3 Seus Dados → nome do cliente + WhatsApp (mesma máscara/validação);
//   4 Pagamento  → as 3 formas existentes (pix / rc / 5050), com valores
//                  apresentados conforme a Quest;
//   5 Personagem → nome + servidor + vocação (componentes existentes);
//   6 Level      → level + "Cadastrar Personagem" (bloqueado abaixo do
//                  mínimo da combinação Quest+Vocação — ver
//                  utils/publicServiceLevels, fonte única também usada na
//                  lógica de envio).
// ============================================================================
type Step = 1 | 2 | 3 | 4 | 5 | 6;

const STEP_LABELS: Record<Step, string> = {
  1: "Quest",
  2: "Termos",
  3: "Seus Dados",
  4: "Pagamento",
  5: "Personagem",
  6: "Finalização",
};

// Rótulo curto das vocações nos cards de level mínimo (mesmo padrão visual
// do quadro original de informações).
const VOC_SHORT: Record<Vocation, string> = {
  MS: "Sorcerer",
  ED: "Druid",
  EK: "Knight",
  RP: "Paladin",
  MK: "Monk",
};

// Ordem de exibição dos cards de level mínimo (mesma do quadro original).
const LEVEL_CARD_ORDER: Vocation[] = ["MS", "ED", "EK", "RP", "MK"];

// ----------------------------------------------------------------------------
// Blocos de conteúdo da Etapa 2 — stateless, definidos FORA do componente
// principal para não serem remontados a cada render.
// ----------------------------------------------------------------------------

function SectionTitle({ emoji, accent, children }: { emoji: string; accent: string; children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-black text-white uppercase tracking-wider mb-4">
      <span className={`w-7 h-7 rounded-lg ${accent} flex items-center justify-center text-sm`}>{emoji}</span>
      {children}
    </h3>
  );
}

function Divider() {
  return <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />;
}

/** Level Mínimo Exigido — cards por vocação, valores da Quest escolhida. */
function LevelGrid({ quest }: { quest: PublicQuest }) {
  return (
    <div>
      <SectionTitle emoji="📊" accent="bg-rose-500/15 border border-rose-500/30">Level Mínimo Exigido</SectionTitle>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {LEVEL_CARD_ORDER.map((v, idx) => {
          const color = VOC_COLORS[v];
          const min = publicMinLevelFor(quest, v);
          return (
            <div
              key={v}
              className={`psf-voc bg-black/30 border rounded-2xl p-3 text-center ${idx === LEVEL_CARD_ORDER.length - 1 ? "col-span-2 sm:col-span-1" : ""}`}
              style={{ "--voc-color": color } as CSSProperties}
            >
              <div className="psf-voc-letter text-base font-black tracking-wider mb-0.5" style={{ color }}>{v}</div>
              <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1.5">{VOC_SHORT[v]}</div>
              <div className="psf-voc-badge inline-flex items-center px-2 py-0.5 rounded-full text-xs font-black tabular-nums border" style={{ color, borderColor: `${color}44`, backgroundColor: `${color}11` }}>{min}+</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Formas de Pagamento — cards 💎 Padrão / ⚖️ 50/50 com os valores da Quest.
 * Os valores do Service PADRÃO vêm de `cfg` (configuração do dono do link
 * exclusivo; no formulário geral são os padrões, que reproduzem os textos
 * originais). Os valores do 50/50, refil e acesso são institucionais e
 * permanecem FIXOS de propósito.
 */
function PaymentInfoCards({ quest, cfg }: { quest: PublicQuest; cfg: ResolvedServiceFormConfig }) {
  return (
    <div>
      <SectionTitle emoji="💰" accent="bg-emerald-500/15 border border-emerald-500/30">Formas de Pagamento</SectionTitle>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Service Padrão — RECOMENDADO: a opção mais vantajosa p/ o cliente */}
        <div className="psf-card relative bg-black/30 border border-sky-500/20 rounded-2xl p-4 pt-5 space-y-2" style={{ "--psf-accent": "#38bdf8" } as CSSProperties}>
          <span className="absolute -top-2.5 right-3 inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-gradient-to-r from-amber-400 to-yellow-500 text-black text-[9px] font-black uppercase tracking-wider shadow-lg shadow-amber-500/30">
            ⭐ Recomendado
          </span>
          <div className="flex items-center gap-2 text-sky-300 font-bold text-sm">
            <span>💎</span> Service Padrão
          </div>
          {quest === "soulwar" ? (
            <ul className="text-xs text-slate-300 space-y-1.5 leading-relaxed">
              <li className="flex items-start gap-1.5">
                <span className="text-sky-400 mt-0.5">•</span>
                <span><strong className="text-white">{formatConfigRcLong(cfg.swRc)} Rubini Coins</strong> + 12kk de refil</span>
              </li>
              <li className="text-center text-slate-500 text-[10px] font-bold uppercase">ou</li>
              <li className="flex items-start gap-1.5">
                <span className="text-sky-400 mt-0.5">•</span>
                <span><strong className="text-white">Pix {formatConfigPixLong(cfg.swPix)}</strong> + 12kk de refil</span>
              </li>
            </ul>
          ) : (
            <div className="space-y-2">
              <div>
                <div className="text-[10px] font-black uppercase tracking-wider text-sky-400/80 mb-1">Primeira Rotação:</div>
                <ul className="text-xs text-slate-300 space-y-1.5 leading-relaxed">
                  <li className="flex items-start gap-1.5">
                    <span className="text-sky-400 mt-0.5">•</span>
                    <span><strong className="text-white">{formatConfigRcLong(cfg.sgFirstRc)} Rubini Coins</strong> + 12kk de refil</span>
                  </li>
                  <li className="text-center text-slate-500 text-[10px] font-bold uppercase">ou</li>
                  <li className="flex items-start gap-1.5">
                    <span className="text-sky-400 mt-0.5">•</span>
                    <span><strong className="text-white">Pix {formatConfigPixLong(cfg.sgFirstPix)}</strong> + 12kk de refil</span>
                  </li>
                </ul>
              </div>
              <div>
                <div className="text-[10px] font-black uppercase tracking-wider text-rose-400/80 mb-1">Caso não drope — para cada próxima rotação:</div>
                <ul className="text-xs text-slate-300 space-y-1.5 leading-relaxed">
                  <li className="flex items-start gap-1.5">
                    <span className="text-sky-400 mt-0.5">•</span>
                    <span><strong className="text-white">{formatConfigRcLong(cfg.sgExtraRc)} Rubini Coins</strong></span>
                  </li>
                  <li className="text-center text-slate-500 text-[10px] font-bold uppercase">ou</li>
                  <li className="flex items-start gap-1.5">
                    <span className="text-sky-400 mt-0.5">•</span>
                    <span><strong className="text-white">Pix {formatConfigPixLong(cfg.sgExtraPix)}</strong></span>
                  </li>
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Service 50/50 */}
        <div className="psf-card bg-black/30 border border-violet-500/20 rounded-2xl p-4 space-y-2" style={{ "--psf-accent": "#a78bfa" } as CSSProperties}>
          <div className="flex items-center gap-2 text-violet-300 font-bold text-sm">
            <span>⚖️</span> Service 50/50
          </div>
          {quest === "soulwar" ? (
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
          ) : (
            <ul className="text-xs text-slate-300 space-y-1.5 leading-relaxed">
              <li className="flex items-start gap-1.5">
                <span className="text-violet-400 mt-0.5">•</span>
                <span>O cliente paga <strong className="text-white">200 Rubini Coins</strong> + 12kk de refil na primeira rotação.</span>
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-violet-400 mt-0.5">•</span>
                <span>Caso não haja Drop, é cobrado um adicional de <strong className="text-white">100 Rubini Coins</strong> para cada próxima rotação.</span>
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-violet-400 mt-0.5">•</span>
                <span>Na rotação em que ocorrer o Drop, após a venda do item principal, o valor arrecadado é <strong className="text-white">dividido igualmente</strong> entre o cliente e o serviceiro.</span>
              </li>
            </ul>
          )}
        </div>
      </div>

      {/* Nota do ACESSO (somente Sanguine) — fora dos cards de propósito:
          vale para OS DOIS formatos, Service Padrão e Service 50/50. */}
      {quest === "sanguine" && (
        <p className="mt-3 text-[11px] text-amber-300/90 leading-relaxed bg-amber-500/10 border border-amber-500/25 rounded-xl px-3.5 py-2.5">
          * O valor de refil não inclui o acesso à Quest, que custa <strong className="text-amber-200">5kk</strong>. Esse
          valor deve ser somado ao refil caso seja a <strong className="text-amber-200">primeira rotação</strong> do
          personagem — <strong className="text-amber-200">válido para o Service Padrão e para o Service 50/50</strong>.
        </p>
      )}
    </div>
  );
}

/**
 * Drops e Recompensas — Soul War mantém EXATAMENTE o conteúdo original;
 * Sanguine tem a apresentação específica da Quest.
 */
function DropsInfo({ quest }: { quest: PublicQuest }) {
  return (
    <div>
      <SectionTitle emoji="🎁" accent="bg-amber-500/15 border border-amber-500/30">Drops e Recompensas</SectionTitle>

      <div className="space-y-3">
        {quest === "soulwar" ? (
          <>
            {/* No Service Padrão — conteúdo original preservado */}
            <div className="psf-card bg-black/30 border border-white/5 rounded-2xl p-4 space-y-2.5" style={{ "--psf-accent": "#38bdf8" } as CSSProperties}>
              <div className="flex items-center gap-2 text-sky-300 font-bold text-xs uppercase tracking-wider">
                <span>💎</span> No Service Padrão
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                • Deixamos seu personagem pronto para abrir a reward e receber sua recompensa.
              </p>
              <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl px-3.5 py-3 space-y-1.5">
                <p className="text-xs text-slate-300 leading-relaxed">
                  🏆 <strong className="text-amber-300">Todos os baús de loot dos bosses pertencem ao cliente</strong> e permanecem na reward, com exceção de <strong className="text-yellow-400">três itens</strong>:
                </p>
                <ul className="text-[11px] text-slate-400 space-y-0.5 pl-4">
                  <li>• Bag You Desire</li>
                  <li>• The Skull of a Beast</li>
                  <li>• Spectral Horseshoes</li>
                </ul>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  🤝 Esses itens são compartilhados entre a equipe responsável pelo service.
                </p>
              </div>
            </div>

            {/* No Service 50/50 — conteúdo original preservado */}
            <div className="psf-card bg-black/30 border border-violet-500/15 rounded-2xl p-4 space-y-2" style={{ "--psf-accent": "#a78bfa" } as CSSProperties}>
              <div className="flex items-center gap-2 text-violet-300 font-bold text-xs uppercase tracking-wider">
                <span>⭐</span> No Service 50/50
              </div>
              <ul className="text-xs text-slate-300 space-y-1.5 leading-relaxed">
                <li>📦 Nesta modalidade, <strong className="text-white">todos os baús de loot dos bosses ficam com a equipe</strong> de serviceiros.</li>
                <li>🎥 A abertura da reward é <strong className="text-white">gravada</strong> e o vídeo é enviado diretamente para o seu WhatsApp.</li>
                <li>💰 Após a venda do item principal, <strong className="text-emerald-300">50% do valor é transferida em Rubini Coins</strong> para você.</li>
              </ul>
            </div>
          </>
        ) : (
          <>
            {/* No Service Padrão — Sanguine */}
            <div className="psf-card bg-black/30 border border-white/5 rounded-2xl p-4 space-y-2.5" style={{ "--psf-accent": "#38bdf8" } as CSSProperties}>
              <div className="flex items-center gap-2 text-sky-300 font-bold text-xs uppercase tracking-wider">
                <span>💎</span> No Service Padrão
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                • Deixamos seu personagem pronto para resgatar seu item Sanguine.
              </p>
              <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl px-3.5 py-3 space-y-1.5">
                <p className="text-xs text-slate-300 leading-relaxed">
                  🏆 <strong className="text-amber-300">Todos os baús de loot dos bosses pertencem ao cliente</strong> e permanecem na reward, com exceção de <strong className="text-yellow-400">dois itens</strong>:
                </p>
                <ul className="text-[11px] text-slate-400 space-y-0.5 pl-4">
                  <li>• Bag You Covet</li>
                  <li>• Spiritual Horseshoe</li>
                </ul>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  🤝 Devido à baixíssima chance de drop desses itens, eles serão compartilhados entre a equipe responsável pelo service.
                </p>
              </div>
            </div>

            {/* No Service 50/50 — Sanguine */}
            <div className="psf-card bg-black/30 border border-violet-500/15 rounded-2xl p-4 space-y-2" style={{ "--psf-accent": "#a78bfa" } as CSSProperties}>
              <div className="flex items-center gap-2 text-violet-300 font-bold text-xs uppercase tracking-wider">
                <span>⭐</span> No Service 50/50
              </div>
              <ul className="text-xs text-slate-300 space-y-1.5 leading-relaxed">
                <li>📦 Nesta modalidade, <strong className="text-white">todos os baús de loot dos bosses ficam com a equipe</strong> de serviceiros.</li>
                <li>🎥 A abertura da bag é <strong className="text-white">gravada</strong> e o vídeo é enviado diretamente para o seu WhatsApp.</li>
                <li>💰 Após a venda do item principal, <strong className="text-emerald-300">50% do valor é transferido em Rubini Coins</strong> para você.</li>
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * "Como funciona o Service" — seção preservada do formulário original.
 * Duração média por Quest: Soul War mantém 2 a 4 horas; Sanguine, 1 a 2
 * horas (uma rotação é mais curta que a Soul War completa).
 */
function HowItWorks({ quest }: { quest: PublicQuest }) {
  return (
    <div>
      <SectionTitle emoji="⚙️" accent="bg-sky-500/15 border border-sky-500/30">Como funciona o Service</SectionTitle>

      <div className="space-y-2.5 text-xs text-slate-300 leading-relaxed">
        <p className="flex items-start gap-2">
          <span className="flex-shrink-0">⏳</span>
          <span>O cliente é <strong className="text-white">incluído automaticamente na fila de espera</strong>. Assim que houver uma PT disponível, entraremos em contato via WhatsApp informando o horário agendado para a realização do service.</span>
        </p>
        <p className="flex items-start gap-2">
          <span className="flex-shrink-0">⏱️</span>
          <span>O service possui <strong className="text-white">duração média entre {quest === "sanguine" ? "1 e 2 horas" : "2 e 4 horas"}</strong>, podendo variar de acordo com o level dos personagens, composição e desempenho da PT.</span>
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
    </div>
  );
}

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
  // Aviso específico de PERSONAGEM JÁ NA FILA — separado do erro genérico
  // para ter visual próprio (âmbar, informativo) em vez de tom de falha.
  const [duplicateMsg, setDuplicateMsg] = useState<string | null>(null);

  // ── Etapas ────────────────────────────────────────────────────────────
  // `step`: etapa atual; `termsAccepted`: aceite da Etapa 2 (obrigatório
  // para prosseguir e re-checado no envio); `termsDeclined`: exibe o aviso
  // de recusa. Trocar a Quest na Etapa 1 zera o aceite — os termos valem
  // para a Quest escolhida, nunca "emprestados" de outra.
  const [step, setStep] = useState<Step>(1);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsDeclined, setTermsDeclined] = useState(false);
  // Tooltip da Soul War pausada: no desktop aparece no hover (CSS); no
  // mobile o toque alterna este estado (auto-oculta depois de alguns
  // segundos para não ficar preso na tela).
  const [swNotice, setSwNotice] = useState(false);
  // Tooltip análogo para a Sanguine desabilitada pelo dono do link exclusivo.
  const [sgNotice, setSgNotice] = useState(false);

  // Campos do formulário
  const [personagem, setPersonagem] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [servidor, setServidor] = useState("");
  const [level, setLevel] = useState("");
  // VOCAÇÃO: inicia SEM seleção ("") e é OBRIGATÓRIA — o avanço da etapa 5
  // e o envio final são bloqueados enquanto o cliente não escolher (as
  // validações de level mínimo continuam dependendo da vocação escolhida).
  const [voc, setVoc] = useState<Vocation | "">("");
  const [quest, setQuest] = useState<PublicQuest | null>(null);
  const [whatsCountry, setWhatsCountry] = useState("55");
  const [whatsArea, setWhatsArea] = useState("");
  const [whatsNumber, setWhatsNumber] = useState("");
  const [payment, setPayment] = useState<"pix" | "rc" | "5050" | "">("");
  const [notes, setNotes] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serviceiro, setServiceiro] = useState("Qualquer um");
  // `twitchChannel`: link de streaming que o serviceiro JÁ cadastra no app
  // (TwitchModal → users/{uid}.twitchChannel). Capturado na MESMA leitura da
  // lista de elegíveis — nenhuma consulta extra para a etapa Finalização.
  const [eligibleServiceiros, setEligibleServiceiros] = useState<Array<{ uid: string; nome: string; twitchChannel?: string; serviceFormConfig?: unknown }>>([]);

  // ── LINK EXCLUSIVO (#/servico/{id}) ────────────────────────────────────
  // Identificador capturado da URL uma única vez na montagem. A resolução
  // para um usuário real acontece DEPOIS que a lista de elegíveis carrega
  // (mesma consulta que o formulário já fazia — zero leituras extras).
  //   • lockedTarget      → usuário exclusivo resolvido; o seletor de
  //                         Serviceiro é OCULTADO e o vínculo é fixo.
  //   • lockedLinkInvalid → o link tinha identificador mas ele não resolveu
  //                         para UM único elegível; o formulário avisa e cai
  //                         no modo normal (nunca associa "no chute").
  const [exclusiveId] = useState(() => getServiceFormIdFromLocation(window.location.hash, window.location.search));
  const [lockedTarget, setLockedTarget] = useState<{ uid: string; nome: string } | null>(null);
  const [lockedLinkInvalid, setLockedLinkInvalid] = useState(false);
  const [eligiblesLoaded, setEligiblesLoaded] = useState(false);

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
              .map((u: any) => ({ uid: u.uid, nome: u.nome || u.email || "Anônimo", twitchChannel: typeof u.twitchChannel === "string" ? u.twitchChannel.trim() : "", serviceFormConfig: u.serviceFormConfig }))
          );
        } catch { if (!cancelled) setEligibleServiceiros([]); }
        if (!cancelled) setEligiblesLoaded(true);
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
        const list: Array<{ uid: string; nome: string; twitchChannel?: string; serviceFormConfig?: unknown }> = [];
        snap.forEach(d => {
          const data = d.data();
          const role = getEffectiveUserRole(data);
          if (role === "Boss" || (role === "VIP" && data.serviceiro === true)) {
            list.push({ uid: d.id, nome: data.nome || "Anônimo", twitchChannel: typeof data.twitchChannel === "string" ? data.twitchChannel.trim() : "", serviceFormConfig: data.serviceFormConfig });
          }
        });
        setEligibleServiceiros(list);
      } catch { if (!cancelled) setEligibleServiceiros([]); }
      if (!cancelled) setEligiblesLoaded(true);
    }

    loadServiceiros();

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Resolução do link exclusivo ──────────────────────────────────────────
  // Roda quando a lista de elegíveis termina de carregar. A resolução é
  // resiliente e NUNCA ambígua (ver resolveServiceFormTarget): UID completo,
  // slug único do nome ou slug+sufixo de UID. Sem correspondência única, o
  // formulário exibe um aviso e volta ao modo normal com seleção manual.
  useEffect(() => {
    if (!exclusiveId || !eligiblesLoaded) return;
    const target = resolveServiceFormTarget(exclusiveId, eligibleServiceiros);
    if (target) {
      setLockedTarget(target);
      setLockedLinkInvalid(false);
      // Espelha no estado do seletor por consistência interna (o campo fica
      // oculto; o envio usa lockedTarget.uid DIRETO, nunca este texto).
      setServiceiro(target.nome);
    } else {
      setLockedTarget(null);
      setLockedLinkInvalid(true);
    }
  }, [exclusiveId, eligiblesLoaded, eligibleServiceiros]);

  // ── CONFIGURAÇÃO INDIVIDUAL DO FORMULÁRIO (link exclusivo) ──────────────
  // Aplica `users/{uid}.serviceFormConfig` do DONO do link (quests
  // habilitadas, valores e servidores atendidos) — gravada pelo modal
  // "Configurar Meu Formulário" e lida AQUI do MESMO carregamento da lista
  // de elegíveis (zero leituras extras). O formulário GERAL (sem
  // lockedTarget) usa sempre os padrões, que reproduzem os textos originais.
  const ownerCfg = useMemo<ResolvedServiceFormConfig>(() => {
    if (!lockedTarget) return SERVICE_FORM_CONFIG_DEFAULTS;
    const owner = eligibleServiceiros.find(u => u.uid === lockedTarget.uid);
    return resolveServiceFormConfig(owner?.serviceFormConfig);
  }, [lockedTarget, eligibleServiceiros]);

  // Bloqueios por Quest: a pausa GLOBAL da Soul War prevalece sobre a
  // configuração individual; a Sanguine só bloqueia por decisão do dono.
  const swBlocked = SOULWAR_PAUSED || !ownerCfg.soulwarEnabled;
  const sgBlocked = !ownerCfg.sanguineEnabled;
  const swBlockTitle = SOULWAR_PAUSED ? SOULWAR_PAUSED_TITLE : OWNER_DISABLED_TITLE;
  const swBlockMessage = SOULWAR_PAUSED ? SOULWAR_PAUSED_MESSAGE : ownerDisabledMessage("Soul War");
  const sgBlockTitle = OWNER_DISABLED_TITLE;
  const sgBlockMessage = ownerDisabledMessage("Sanguine");
  /** A Quest está bloqueada neste formulário? (gate único de UI e envio) */
  function isQuestBlocked(q: PublicQuest | ""): boolean {
    if (q === "soulwar") return swBlocked;
    if (q === "sanguine") return sgBlocked;
    return false;
  }

  // Opções do seletor de servidor: TODOS os servidores continuam visíveis;
  // os não atendidos pelo dono do link ganham o sufixo "(Indisponível)" e
  // não podem ser selecionados.
  const serverSelectOptions = useMemo(
    () => SERVER_OPTIONS.map(s => (isServerAttended(ownerCfg, s) ? s : `${s}${UNAVAILABLE_SERVER_SUFFIX}`)),
    [ownerCfg]
  );

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

  // Ao trocar de etapa, rolar para o topo do conteúdo (mobile: evita o
  // cliente "cair" no meio da etapa seguinte).
  useEffect(() => {
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch {}
  }, [step]);

  // Tooltip da Soul War aberto por toque: some sozinho após 8s.
  useEffect(() => {
    if (!swNotice) return;
    const timer = window.setTimeout(() => setSwNotice(false), 8000);
    return () => window.clearTimeout(timer);
  }, [swNotice]);

  // Tooltip da Sanguine desabilitada (mesmo comportamento do da Soul War).
  useEffect(() => {
    if (!sgNotice) return;
    const timer = window.setTimeout(() => setSgNotice(false), 8000);
    return () => window.clearTimeout(timer);
  }, [sgNotice]);

  // ── Validações por etapa ─────────────────────────────────────────────────
  // Cada etapa valida SOMENTE os próprios campos ao avançar; `validate()`
  // (abaixo) revalida TUDO no envio final — nenhuma etapa pulada escapa.
  const parsedLevel = parseInt(level || "0", 10) || 0;
  const levelBlock = !quest
    ? "Escolha a Quest na primeira etapa"
    : !voc
      ? "Escolha a vocação na etapa anterior"
      : publicLevelBlockReason(quest, voc, parsedLevel);

  function stepErrors(s: Step): Record<string, string> {
    const errors: Record<string, string> = {};
    if (s === 1 && (!quest || isQuestBlocked(quest))) errors.quest = "Escolha a Quest para continuar";
    if (s === 2 && !termsAccepted) errors.terms = "É necessário aceitar os termos para prosseguir";
    if (s === 3) {
      if (!ownerName.trim()) errors.ownerName = "Informe o seu nome";
      if (!whatsArea.trim() || !whatsNumber.trim()) errors.whats = "Informe o WhatsApp completo para contato";
    }
    if (s === 4 && !payment) errors.payment = "Selecione a forma de pagamento";
    if (s === 5) {
      if (!personagem.trim()) errors.personagem = "Informe o nome do personagem";
      if (!servidor.trim()) errors.servidor = "Informe o servidor";
      // Defesa extra: mesmo que a seleção tenha acontecido antes de a
      // configuração do dono carregar, servidor não atendido não passa.
      else if (!isServerAttended(ownerCfg, servidor)) errors.servidor = "Este serviceiro não atende este servidor. Escolha um servidor disponível.";
      if (!voc) errors.voc = "Escolha a vocação do personagem";
    }
    if (s === 6 && levelBlock) errors.level = levelBlock;
    return errors;
  }

  // Validação COMPLETA (envio): união das validações de todas as etapas.
  // Retorna também a PRIMEIRA etapa com pendência, para levar o cliente
  // direto até ela — nada é enviado com etapa inválida.
  function validateAll(): { ok: boolean; firstInvalidStep: Step | null; errors: Record<string, string> } {
    const all: Record<string, string> = {};
    let firstInvalid: Step | null = null;
    for (const s of [1, 2, 3, 4, 5, 6] as Step[]) {
      const errs = stepErrors(s);
      if (Object.keys(errs).length > 0 && firstInvalid === null) firstInvalid = s;
      Object.assign(all, errs);
    }
    setFieldErrors(all);
    return { ok: firstInvalid === null, firstInvalidStep: firstInvalid, errors: all };
  }

  function goToStep(target: Step) {
    setFieldErrors({});
    setStep(target);
  }

  function goNext() {
    const errs = stepErrors(step);
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    if (step < 6) setStep((step + 1) as Step);
  }

  function goBack() {
    setFieldErrors({});
    if (step > 1) setStep((step - 1) as Step);
  }

  function chooseQuest(q: PublicQuest) {
    // Quest bloqueada (pausa global OU desabilitada pelo dono do link):
    // nunca seleciona (o botão bloqueado nem chama esta função; guarda
    // defensiva para qualquer outro caminho).
    if (q === "soulwar" && swBlocked) {
      setSwNotice(true);
      return;
    }
    if (q === "sanguine" && sgBlocked) {
      setSgNotice(true);
      return;
    }
    if (quest !== q) {
      // Termos valem PARA A QUEST escolhida: trocar de Quest exige novo aceite.
      setTermsAccepted(false);
      setTermsDeclined(false);
    }
    setQuest(q);
    setFieldErrors({});
    setStep(2);
  }

  function acceptTerms() {
    setTermsAccepted(true);
    setTermsDeclined(false);
    setFieldErrors({});
    setStep(3);
  }

  function declineTerms() {
    setTermsAccepted(false);
    setTermsDeclined(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setDuplicateMsg(null);

    // Re-checar bloqueio
    const until = getBlockedUntil();
    if (until > Date.now()) {
      setBlockedUntil(until);
      setFormState("blocked");
      return;
    }

    // Validação completa — qualquer pendência leva o cliente à etapa dela.
    const result = validateAll();
    if (!result.ok) {
      if (result.firstInvalidStep) setStep(result.firstInvalidStep);
      return;
    }

    // ── GATE FINAL (lógica de cadastro, não só interface) ────────────────
    // Mesmo que a interface seja contornada, NADA é gravado sem Quest
    // escolhida, termos aceitos e level dentro do mínimo da combinação
    // Quest + Vocação (fonte única: utils/publicServiceLevels).
    const levelNum = parseInt(level || "0", 10) || 0;
    if (!quest || isQuestBlocked(quest) || !termsAccepted || !voc || publicLevelBlockReason(quest, voc, levelNum)) {
      setStep(!quest || isQuestBlocked(quest) ? 1 : !termsAccepted ? 2 : !voc ? 5 : 6);
      return;
    }

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
        level: levelNum,
        valorCombinado: 0, // será negociado pela equipe
        dataAdicionado: todayISO(),
        notes: publicNotes,
        paymentMethod: payment,
        whatsappCountry: whatsCountry.replace(/\D/g, ""),
        whatsappArea: whatsArea.replace(/\D/g, ""),
        whatsappNumber: whatsNumber.replace(/\D/g, ""),
        addedBy: lockedTarget ? lockedTarget.nome : (serviceiro || "Qualquer um"),
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
      //
      // LINK EXCLUSIVO: quando a rota definiu o destinatário (lockedTarget),
      // o UID dele tem prioridade ABSOLUTA — o estado do seletor (oculto
      // neste modo) é ignorado por completo, então nada que o cliente faça
      // no formulário altera o vínculo. A validação final de elegibilidade
      // é do BACKEND: a regra de `serviceRequests` no Firestore só aceita a
      // criação se o `serviceiroUid` for de usuário aprovado E (Boss ou
      // serviceiro === true) — manipular a URL não contorna isso.
      const chosen = lockedTarget || eligibleServiceiros.find(
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
        //
        // ANTI-DUPLICADO: `createServiceRequest` grava a solicitação num
        // WriteBatch atômico junto com a chave do personagem em
        // `serviceQueueIndex`. Se o personagem já está na fila (de QUALQUER
        // usuário), NADA é criado — sem segundo registro, sem notificação e
        // sem alterar o pedido existente — e o cliente recebe o aviso.
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
        if (!created.ok) {
          if (created.duplicate) {
            setDuplicateMsg(DUPLICATE_SERVICE_MESSAGE);
            setFormState("filling");
            return;
          }
          throw new Error(created.error || "Falha ao enviar a solicitação ao Serviceiro.");
        }
      } else {
        // "Qualquer um": MESMA proteção anti-duplicado — chave + documento
        // da Lista de Espera num único batch atômico. Bloqueado = nenhuma
        // gravação acontece e a Cloud Function de notificação do Boss
        // (onDocumentCreated em waitingList) nem chega a disparar.
        const createdWaiting = await createWithQueueGuard({
          entry: {
            personagem: service.personagem,
            servidor: service.servidor,
            quest: service.quest,
            refId: id,
            refKind: "waiting",
          },
          targetCollection: "waitingList",
          targetId: id,
          targetData: JSON.parse(JSON.stringify(service)),
        });
        if (!createdWaiting.ok) {
          if (createdWaiting.duplicate) {
            setDuplicateMsg(DUPLICATE_SERVICE_MESSAGE);
            setFormState("filling");
            return;
          }
          throw new Error(createdWaiting.error || "Falha ao enviar sua solicitação.");
        }
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
    setVoc("");
    setQuest(null);
    setStep(1);
    setTermsAccepted(false);
    setTermsDeclined(false);
    setWhatsArea("");
    setWhatsNumber("");
    setPayment("");
    setNotes("");
    setFieldErrors({});
    setDuplicateMsg(null);
    // Link exclusivo: o vínculo do formulário permanece após "Adicionar
    // outro personagem" — o cliente continua cadastrando para o MESMO
    // Serviceiro do link. Só o modo normal volta para "Qualquer um".
    setServiceiro(lockedTarget ? lockedTarget.nome : "Qualquer um");
    setFormState("filling");
  }

  // CONTRASTE: os quadros das etapas usam um tom MAIS CLARO que o fundo da
// página (color-mix com o tema), e os campos preenchíveis são bem mais
// ESCUROS que o quadro, com borda nítida — fica evidente onde clicar e
// digitar, em desktop e mobile.
const inputCls = "w-full bg-black/60 border border-white/20 hover:border-white/30 focus:border-cyan-400/80 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/20 placeholder-slate-500 transition-colors";
  const labelCls = "block text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-2";
  const navBackCls = "inline-flex items-center gap-1.5 px-5 py-3 rounded-xl border border-white/20 bg-white/[0.06] text-slate-300 hover:bg-white/[0.07] hover:text-white text-sm font-bold transition-colors cursor-pointer";
  const navNextCls = "psf-submit inline-flex items-center justify-center gap-2 px-7 py-3 rounded-xl text-sm font-black tracking-wide text-black bg-gradient-to-r from-cyan-400 to-sky-500 hover:from-cyan-300 hover:to-sky-400 shadow-lg shadow-cyan-500/25 hover:shadow-cyan-500/40 transition-all duration-300 cursor-pointer hover:scale-[1.02] active:scale-[0.98]";

  const questLabel = quest ? PUBLIC_QUEST_LABEL[quest] : "";
  const questEmoji = quest === "sanguine" ? "🩸" : "⚔️";

  // ── STREAMING do serviceiro-alvo (etapa Finalização) ───────────────────
  // Usa o link que o serviceiro JÁ cadastrou no aplicativo (TwitchModal →
  // users/{uid}.twitchChannel), lido junto com a lista de elegíveis. Só é
  // exibido quando o formulário tem um serviceiro DEFINIDO (link exclusivo
  // ou seleção manual) E ele possui link cadastrado — sem área vazia e sem
  // informação fictícia para "Qualquer um".
  const streamTarget = lockedTarget
    ? eligibleServiceiros.find(u => u.uid === lockedTarget.uid)
    : (serviceiro && serviceiro !== "Qualquer um"
        ? eligibleServiceiros.find(u => u.nome.trim().toLowerCase() === serviceiro.trim().toLowerCase())
        : undefined);
  const streamRaw = (streamTarget?.twitchChannel || "").trim();
  const streamHref = streamRaw ? (/^https?:\/\//i.test(streamRaw) ? streamRaw : `https://${streamRaw}`) : "";
  const streamDisplay = streamHref.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "");

  // ── Stepper (indicador de etapas) ────────────────────────────────────────
  // Etapas anteriores são clicáveis (voltar sem perder dados); as seguintes
  // só pelos botões "Continuar" — que validam a etapa atual.
  function renderStepper() {
    return (
      <div className="mb-6">
        <div className="flex items-center justify-between gap-1">
          {( [1, 2, 3, 4, 5, 6] as Step[]).map((s, idx) => {
            const done = s < step;
            const current = s === step;
            return (
              <div key={s} className={`flex items-center ${idx < 5 ? "flex-1" : ""}`}>
                <button
                  type="button"
                  onClick={() => { if (done) goToStep(s); }}
                  disabled={!done}
                  title={`Etapa ${s}: ${STEP_LABELS[s]}`}
                  className={`flex flex-col items-center gap-1 flex-shrink-0 ${done ? "cursor-pointer" : "cursor-default"}`}
                >
                  <span
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-black border-2 transition-all ${
                      current
                        ? "border-cyan-400 bg-cyan-500/20 text-cyan-300 shadow-lg shadow-cyan-500/20 scale-110"
                        : done
                          ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
                          : "border-white/10 bg-white/[0.03] text-slate-600"
                    }`}
                  >
                    {done ? <Check size={14} /> : s}
                  </span>
                  <span className={`hidden sm:block text-[9px] font-bold uppercase tracking-wider ${current ? "text-cyan-300" : done ? "text-emerald-400/80" : "text-slate-600"}`}>
                    {STEP_LABELS[s]}
                  </span>
                </button>
                {idx < 5 && (
                  <div className={`flex-1 h-0.5 mx-1 sm:mx-2 rounded-full transition-colors duration-500 ${s < step ? "bg-gradient-to-r from-emerald-500/60 to-cyan-500/50" : "bg-white/10"}`} />
                )}
              </div>
            );
          })}
        </div>
        <div className="sm:hidden text-center mt-2 text-[11px] font-bold uppercase tracking-widest text-cyan-300">
          Etapa {step} de 6 — {STEP_LABELS[step]}
        </div>
      </div>
    );
  }

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

      {/* pt-28: compensa a altura do header fixo para o conteúdo não ficar escondido */}
      <div className="relative z-10 w-full max-w-3xl mx-auto px-3 sm:px-6 pt-28 pb-12">

        {/* ===== ESTADO: BLOQUEADO (rate limit) ===== */}
        {formState === "blocked" && (
          <div className="bg-[color-mix(in_oklab,var(--th-n-elev)_92%,white)] border border-amber-500/30 rounded-3xl shadow-2xl p-10 text-center space-y-5">
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
          <div className="bg-[color-mix(in_oklab,var(--th-n-elev)_92%,white)] border border-emerald-500/30 rounded-3xl shadow-2xl p-10 text-center space-y-5">
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

        {/* ===== FLUXO EM ETAPAS ===== */}
        {(formState === "filling" || formState === "submitting") && (
          <form onSubmit={handleSubmit}>
            {renderStepper()}

            {/* Erro geral — visível em qualquer etapa */}
            {errorMsg && (
              <div className="mb-5 flex items-start gap-3 bg-rose-500/10 border border-rose-500/30 rounded-xl px-4 py-3 text-sm text-rose-300">
                <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* Personagem já na fila — aviso informativo (não é um erro do
                cliente): nenhum novo registro foi criado. */}
            {duplicateMsg && (
              <div className="mb-5 flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 text-sm text-amber-300">
                <Clock size={18} className="flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold">{duplicateMsg}</div>
                  <div className="text-[11px] text-amber-200/70 mt-1">
                    Nossa equipe já recebeu a solicitação deste personagem e entrará em contato pelo WhatsApp.
                  </div>
                </div>
              </div>
            )}

            {/* Wrapper com key={step}: remonta a cada troca de etapa e
                aplica entrada suave (fade + deslize) — refinamento visual
                sem custo de desempenho. */}
            <div key={step} className="animate-in fade-in slide-in-from-bottom-3 duration-300">

            {/* ============================================================
                ETAPA 1 — BOAS-VINDAS + ESCOLHA DA QUEST
               ============================================================ */}
            {step === 1 && (
              <div className="psf-quadro bg-[color-mix(in_oklab,var(--th-n-elev)_92%,white)] border border-cyan-500/50 rounded-3xl shadow-2xl ring-1 ring-white/[0.06]" style={{ "--psf-quadro-accent": "#22d3ee" } as CSSProperties}>
                <div className="psf-quadro-header bg-gradient-to-r from-cyan-500/10 via-cyan-500/15 to-cyan-500/10 border-b border-cyan-500/20 px-7 py-5 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-sky-600 flex items-center justify-center flex-shrink-0">
                    <Swords size={20} className="text-black" />
                  </div>
                  <div>
                    <h2 className="text-base font-black text-cyan-300 tracking-wide uppercase">Bem-vindo ao nosso Service</h2>
                    <p className="text-[11px] text-slate-500">Quests concluídas com segurança e profissionalismo</p>
                  </div>
                </div>

                {/* Corpo da ETAPA 1 — primeira impressão: hero com hierarquia
                    tipográfica, selos de confiança e os DOIS seletores de
                    Quest como protagonistas (temas visuais distintos: aço
                    para Soul War, rubi para Sanguine). Glows decorativos
                    sutis, sem sobrecarregar. */}
                <div className="psf-quadro-inner relative overflow-hidden px-4 py-7 sm:p-8 space-y-7">
                  {/* Glows decorativos internos (não interativos) */}
                  <div aria-hidden className="pointer-events-none absolute -top-24 -right-16 w-64 h-64 rounded-full bg-cyan-500/10 blur-[90px]" />
                  <div aria-hidden className="pointer-events-none absolute -bottom-28 -left-20 w-72 h-72 rounded-full bg-red-600/10 blur-[100px]" />

                  {/* HERO */}
                  <div className="relative text-center space-y-3">
                    <div className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px] font-black uppercase tracking-[0.22em] shadow-lg shadow-amber-500/10">
                      ⚡ Service Profissional de Quests
                    </div>
                    <h3 className="text-2xl sm:text-[28px] font-black tracking-tight text-white leading-tight">
                      Sua Quest concluída por quem{" "}
                      <span className="bg-gradient-to-r from-red-500 via-orange-400 to-yellow-400 bg-clip-text text-transparent" style={{ filter: "drop-shadow(0 0 10px color-mix(in oklab, var(--color-red-600) 35%, transparent))" }}>
                        entende do assunto
                      </span>
                    </h3>
                    <p className="text-sm text-slate-400 max-w-md mx-auto leading-relaxed">
                      Equipe de <strong className="text-slate-200">jogadores experientes</strong>, horário agendado
                      e <strong className="text-slate-200">pagamento flexível</strong> — Pix, Rubini Coins ou 50/50.
                    </p>
                  </div>

                  {/* Selos de confiança */}
                  <div className="relative grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/30 px-3.5 py-3 transition-colors duration-300 hover:border-white/20 hover:bg-black/40">
                      <span className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-base flex-shrink-0">💬</span>
                      <span className="text-[11px] font-bold text-slate-200 leading-snug">Contato via WhatsApp</span>
                    </div>
                    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/30 px-3.5 py-3 transition-colors duration-300 hover:border-white/20 hover:bg-black/40">
                      <span className="w-9 h-9 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-base flex-shrink-0">🎥</span>
                      <span className="text-[11px] font-bold text-slate-200 leading-snug">Tudo feito em Live, para máxima segurança</span>
                    </div>
                    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/30 px-3.5 py-3 transition-colors duration-300 hover:border-white/20 hover:bg-black/40">
                      <span className="w-9 h-9 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-base flex-shrink-0">💰</span>
                      <span className="text-[11px] font-bold text-slate-200 leading-snug">Valor justo</span>
                    </div>
                  </div>

                  {/* Divisor com rótulo */}
                  <div className="relative flex items-center gap-3">
                    <div className="flex-1 h-px bg-gradient-to-r from-transparent via-white/15 to-white/20" />
                    <span className="text-[10px] font-black uppercase tracking-[0.28em] text-slate-300">Escolha a Quest</span>
                    <div className="flex-1 h-px bg-gradient-to-l from-transparent via-white/15 to-white/20" />
                  </div>

                  {/* Seletores de Quest — somente os nomes, temas distintos */}
                  <div className="relative grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {swBlocked ? (
                      /* SOUL WAR BLOQUEADA — visível, não selecionável, por
                         pausa GLOBAL (SOULWAR_PAUSED; para reativar: flag =
                         false) ou porque o DONO do link exclusivo desabilitou
                         a Quest no modal "Configurar Meu Formulário". Tooltip
                         no hover (desktop) e no toque (mobile, com auto-
                         ocultar) com a mensagem do motivo. */
                      <div className="relative group">
                        <button
                          type="button"
                          aria-disabled="true"
                          onClick={() => setSwNotice(v => !v)}
                          className="relative overflow-hidden flex flex-col items-center gap-2.5 px-6 py-8 rounded-2xl border-2 w-full cursor-not-allowed border-slate-500/25 bg-gradient-to-b from-slate-600/10 via-slate-600/[0.04] to-transparent saturate-50 opacity-80 transition-all duration-300"
                          title={`${swBlockTitle} ${swBlockMessage}`}
                        >
                          <span className="absolute top-2.5 right-2.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[8px] font-black uppercase tracking-widest">⏸ Em pausa</span>
                          <span className="text-4xl grayscale opacity-70">⚔️</span>
                          <span className="text-lg font-black tracking-[0.14em] text-slate-400">SOUL WAR</span>
                          <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">
                            Indisponível
                          </span>
                        </button>
                        {/* Tooltip elegante — hover (sm+) ou toque (estado) */}
                        <div className={`absolute left-1/2 -translate-x-1/2 bottom-[calc(100%+10px)] z-20 w-[320px] max-w-[88vw] transition-all duration-200 ease-out ${swNotice ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1 pointer-events-none sm:group-hover:opacity-100 sm:group-hover:translate-y-0"}`}>
                          <div className="relative rounded-xl border border-amber-500/40 bg-[color-mix(in_oklab,var(--th-n-elev)_85%,white)] shadow-2xl shadow-black/70 ring-1 ring-black/40 px-4 py-3 text-left">
                            <p className="text-[11px] leading-relaxed text-slate-300">
                              <strong className="text-amber-300">⏸ {swBlockTitle}</strong>{" "}
                              {swBlockMessage}
                            </p>
                            <span aria-hidden className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-x-8 border-x-transparent border-t-8 border-t-amber-500/40" />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => chooseQuest("soulwar")}
                        style={{ "--psf-accent": "#cbd5e1" } as CSSProperties}
                        className={`psf-choice group relative overflow-hidden flex flex-col items-center gap-2.5 px-6 py-8 rounded-2xl border-2 cursor-pointer transition-all duration-300 ${
                          quest === "soulwar"
                            ? "border-slate-200 bg-gradient-to-b from-slate-400/25 via-slate-500/10 to-transparent shadow-xl shadow-slate-400/15 scale-[1.02]"
                            : "border-slate-400/30 bg-gradient-to-b from-slate-500/15 via-slate-500/5 to-transparent hover:border-slate-200/70 hover:from-slate-400/25 hover:shadow-xl hover:shadow-slate-400/10 hover:scale-[1.015] active:scale-[0.99]"
                        }`}
                      >
                        <span aria-hidden className="pointer-events-none absolute -top-10 right-0 w-28 h-28 rounded-full bg-slate-200/10 blur-2xl transition-colors duration-300 group-hover:bg-slate-200/20" />
                        <span className="text-4xl drop-shadow-[0_0_16px_rgba(203,213,225,0.45)] transition-transform duration-300 group-hover:scale-110">⚔️</span>
                        <span className="text-lg font-black tracking-[0.14em] text-white" style={{ textShadow: "0 0 18px rgba(203,213,225,0.35)" }}>SOUL WAR</span>
                        <span className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.2em] transition-colors duration-300 ${quest === "soulwar" ? "text-cyan-300" : "text-slate-500 group-hover:text-cyan-300"}`}>
                          Começar <ChevronRight size={12} />
                        </span>
                      </button>
                    )}
                    {sgBlocked ? (
                      /* SANGUINE DESABILITADA PELO DONO do link exclusivo
                         (modal "Configurar Meu Formulário") — visível, não
                         selecionável, mesma apresentação do bloqueio da
                         Soul War. */
                      <div className="relative group">
                        <button
                          type="button"
                          aria-disabled="true"
                          onClick={() => setSgNotice(v => !v)}
                          className="relative overflow-hidden flex flex-col items-center gap-2.5 px-6 py-8 rounded-2xl border-2 w-full cursor-not-allowed border-slate-500/25 bg-gradient-to-b from-slate-600/10 via-slate-600/[0.04] to-transparent saturate-50 opacity-80 transition-all duration-300"
                          title={`${sgBlockTitle} ${sgBlockMessage}`}
                        >
                          <span className="absolute top-2.5 right-2.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[8px] font-black uppercase tracking-widest">⏸ Em pausa</span>
                          <span className="text-4xl grayscale opacity-70">🩸</span>
                          <span className="text-lg font-black tracking-[0.14em] text-slate-400">SANGUINE</span>
                          <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">
                            Indisponível
                          </span>
                        </button>
                        {/* Tooltip elegante — hover (sm+) ou toque (estado) */}
                        <div className={`absolute left-1/2 -translate-x-1/2 bottom-[calc(100%+10px)] z-20 w-[320px] max-w-[88vw] transition-all duration-200 ease-out ${sgNotice ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1 pointer-events-none sm:group-hover:opacity-100 sm:group-hover:translate-y-0"}`}>
                          <div className="relative rounded-xl border border-amber-500/40 bg-[color-mix(in_oklab,var(--th-n-elev)_85%,white)] shadow-2xl shadow-black/70 ring-1 ring-black/40 px-4 py-3 text-left">
                            <p className="text-[11px] leading-relaxed text-slate-300">
                              <strong className="text-amber-300">⏸ {sgBlockTitle}</strong>{" "}
                              {sgBlockMessage}
                            </p>
                            <span aria-hidden className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-x-8 border-x-transparent border-t-8 border-t-amber-500/40" />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => chooseQuest("sanguine")}
                        style={{ "--psf-accent": "#fb7185" } as CSSProperties}
                        className={`psf-choice group relative overflow-hidden flex flex-col items-center gap-2.5 px-6 py-8 rounded-2xl border-2 cursor-pointer transition-all duration-300 ${
                          quest === "sanguine"
                            ? "border-rose-400 bg-gradient-to-b from-rose-500/25 via-rose-600/10 to-transparent shadow-xl shadow-rose-500/15 scale-[1.02]"
                            : "border-rose-500/30 bg-gradient-to-b from-rose-600/15 via-rose-600/5 to-transparent hover:border-rose-400/80 hover:from-rose-500/25 hover:shadow-xl hover:shadow-rose-500/15 hover:scale-[1.015] active:scale-[0.99]"
                        }`}
                      >
                        <span aria-hidden className="pointer-events-none absolute -top-10 right-0 w-28 h-28 rounded-full bg-rose-500/15 blur-2xl transition-colors duration-300 group-hover:bg-rose-500/25" />
                        <span className="text-4xl drop-shadow-[0_0_16px_rgba(251,113,133,0.5)] transition-transform duration-300 group-hover:scale-110">🩸</span>
                        <span className="text-lg font-black tracking-[0.14em] text-white" style={{ textShadow: "0 0 18px rgba(251,113,133,0.4)" }}>SANGUINE</span>
                        <span className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.2em] transition-colors duration-300 ${quest === "sanguine" ? "text-rose-300" : "text-slate-500 group-hover:text-rose-300"}`}>
                          Começar <ChevronRight size={12} />
                        </span>
                      </button>
                    )}
                  </div>

                  <p className="relative text-[11px] text-slate-500 text-center">
                    As informações, valores e requisitos das próximas etapas seguem a Quest escolhida.
                  </p>
                  {fieldErrors.quest && <div className="relative text-[10px] text-rose-400 text-center">{fieldErrors.quest}</div>}
                </div>
              </div>
            )}

            {/* ============================================================
                ETAPA 2 — INFORMAÇÕES DA QUEST + TERMOS
               ============================================================ */}
            {step === 2 && quest && (
              <div className="psf-quadro bg-[color-mix(in_oklab,var(--th-n-elev)_92%,white)] border border-amber-500/50 rounded-3xl shadow-2xl ring-1 ring-white/[0.06]" style={{ "--psf-quadro-accent": "#f59e0b" } as CSSProperties}>
                <div className="psf-quadro-header bg-gradient-to-r from-amber-500/10 via-amber-500/15 to-amber-500/10 border-b border-amber-500/20 px-7 py-5 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center flex-shrink-0">
                    <Swords size={20} className="text-black" />
                  </div>
                  <div>
                    <h2 className="text-base font-black text-amber-300 tracking-wide uppercase">Service {questEmoji} {questLabel}</h2>
                    <p className="text-[11px] text-slate-500">Leia com atenção antes de prosseguir</p>
                  </div>
                </div>

                <div className="psf-quadro-inner px-4 py-6 sm:p-7 space-y-6">
                  <LevelGrid quest={quest} />
                  <Divider />
                  <PaymentInfoCards quest={quest} cfg={ownerCfg} />
                  <Divider />
                  <DropsInfo quest={quest} />
                  <Divider />
                  <HowItWorks quest={quest} />

                  {/* ===== ACEITE DOS TERMOS ===== */}
                  <div className="bg-emerald-500/5 border border-emerald-500/25 rounded-2xl px-4 py-4 sm:px-5 space-y-3">
                    <p className="text-xs text-emerald-200 leading-relaxed flex items-start gap-2.5">
                      <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5 text-emerald-400" />
                      <span><strong>Ao contratar o service, o cliente declara estar ciente e de acordo com todas as condições descritas acima.</strong></span>
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        onClick={acceptTerms}
                        className="inline-flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl border-2 border-emerald-500/60 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 text-sm font-black tracking-wide transition-all cursor-pointer hover:scale-[1.01] active:scale-[0.99]"
                      >
                        <Check size={17} /> Aceito os termos
                      </button>
                      <button
                        type="button"
                        onClick={declineTerms}
                        className="inline-flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl border-2 border-white/15 bg-white/[0.05] hover:bg-rose-500/10 hover:border-rose-500/40 text-slate-400 hover:text-rose-300 text-sm font-bold tracking-wide transition-all cursor-pointer"
                      >
                        <XCircle size={17} /> Não aceito os termos
                      </button>
                    </div>
                    {termsDeclined && (
                      <div className="flex items-start gap-2.5 bg-rose-500/10 border border-rose-500/30 rounded-xl px-4 py-3 text-xs text-rose-300 leading-relaxed animate-in fade-in slide-in-from-top-2 duration-200">
                        <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
                        <span>
                          Sem o aceite dos termos não é possível prosseguir com a solicitação do service.
                          Se preferir, revise as condições acima ou{" "}
                          <a href="https://wa.me/5535999349969" target="_blank" rel="noopener noreferrer" className="underline font-bold hover:text-rose-200">fale com o nosso suporte</a>.
                        </span>
                      </div>
                    )}
                    {fieldErrors.terms && !termsDeclined && (
                      <div className="text-[10px] text-rose-400">{fieldErrors.terms}</div>
                    )}
                  </div>

                  {/* Navegação */}
                  <div className="flex items-center justify-between pt-1">
                    <button type="button" onClick={goBack} className={navBackCls}>
                      <ChevronLeft size={16} /> Voltar
                    </button>
                    <div className="text-[10px] text-slate-600 text-right">
                      Aceite os termos para continuar
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ============================================================
                ETAPA 3 — CADASTRO DO CLIENTE (nome + WhatsApp)
               ============================================================ */}
            {step === 3 && (
              <div className="psf-quadro bg-[color-mix(in_oklab,var(--th-n-elev)_92%,white)] border border-cyan-500/50 rounded-3xl shadow-2xl ring-1 ring-white/[0.06]" style={{ "--psf-quadro-accent": "#22d3ee" } as CSSProperties}>
                <div className="psf-quadro-header bg-gradient-to-r from-cyan-500/10 via-cyan-500/15 to-cyan-500/10 border-b border-cyan-500/20 px-7 py-5 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-sky-600 flex items-center justify-center flex-shrink-0">
                    <Phone size={20} className="text-black" />
                  </div>
                  <div>
                    <h2 className="text-base font-black text-cyan-300 tracking-wide uppercase">Seus dados de contato</h2>
                    <p className="text-[11px] text-slate-500">Service {questEmoji} {questLabel} · usaremos o WhatsApp para combinar os detalhes</p>
                  </div>
                </div>

                <div className="psf-quadro-inner px-4 py-6 sm:p-7 space-y-6">
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

                  {/* WhatsApp — mesma máscara/formatação/validação do formulário original */}
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

                  {/* Navegação */}
                  <div className="flex items-center justify-between pt-1">
                    <button type="button" onClick={goBack} className={navBackCls}>
                      <ChevronLeft size={16} /> Voltar
                    </button>
                    <button type="button" onClick={goNext} className={navNextCls}>
                      Continuar <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ============================================================
                ETAPA 4 — FORMA DE PAGAMENTO
               ============================================================ */}
            {step === 4 && quest && (
              <div className="psf-quadro bg-[color-mix(in_oklab,var(--th-n-elev)_92%,white)] border border-cyan-500/50 rounded-3xl shadow-2xl ring-1 ring-white/[0.06]" style={{ "--psf-quadro-accent": "#22d3ee" } as CSSProperties}>
                <div className="psf-quadro-header bg-gradient-to-r from-cyan-500/10 via-cyan-500/15 to-cyan-500/10 border-b border-cyan-500/20 px-7 py-5 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-sky-600 flex items-center justify-center flex-shrink-0">
                    <span className="text-lg">💰</span>
                  </div>
                  <div>
                    <h2 className="text-base font-black text-cyan-300 tracking-wide uppercase">Forma de pagamento</h2>
                    <p className="text-[11px] text-slate-500">Service {questEmoji} {questLabel} · valores conforme os termos aceitos</p>
                  </div>
                </div>

                <div className="psf-quadro-inner px-4 py-6 sm:p-7 space-y-6">
                  <div>
                    <label className={labelCls}>Forma de Pagamento *</label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {/* PIX */}
                      <button
                        type="button"
                        onClick={() => { setPayment("pix"); if (fieldErrors.payment) setFieldErrors(f => ({ ...f, payment: "" })); }}
                        style={{ "--psf-accent": "#34d399" } as CSSProperties}
                        className={`psf-choice relative flex flex-col items-center justify-center px-3 pt-5 pb-4 rounded-xl border-2 cursor-pointer text-center ${
                          payment === "pix"
                            ? "border-emerald-500 bg-emerald-500/15 shadow-lg shadow-emerald-500/15 scale-[1.02]"
                            : `bg-white/[0.05] hover:bg-white/10 ${fieldErrors.payment ? "border-rose-500/40" : "border-white/15"}`
                        }`}
                      >
                        <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-gradient-to-r from-amber-400 to-yellow-500 text-black text-[9px] font-black uppercase tracking-wider shadow-lg shadow-amber-500/30 whitespace-nowrap">
                          ⭐ Recomendado
                        </span>
                        <span className={`psf-pay-title text-base font-black tracking-wider ${payment === "pix" ? "text-emerald-300" : "text-slate-300"}`}>💸 PIX</span>
                        <span className={`psf-pay-value text-lg font-black mt-1 ${payment === "pix" ? "text-emerald-400" : "text-slate-400"}`}>{formatConfigPixCard(quest === "sanguine" ? ownerCfg.sgFirstPix : ownerCfg.swPix)}</span>
                        <span className="psf-pay-subtitle text-[10px] font-bold mt-0.5 text-slate-500">
                          {quest === "sanguine" ? "1ª rotação + 12kk de refil" : "+ 12kk de refil"}
                        </span>
                      </button>
                      {/* RC */}
                      <button
                        type="button"
                        onClick={() => { setPayment("rc"); if (fieldErrors.payment) setFieldErrors(f => ({ ...f, payment: "" })); }}
                        style={{ "--psf-accent": "#fbbf24" } as CSSProperties}
                        className={`psf-choice relative flex flex-col items-center justify-center px-3 pt-5 pb-4 rounded-xl border-2 cursor-pointer text-center ${
                          payment === "rc"
                            ? "border-amber-500 bg-amber-500/15 shadow-lg shadow-amber-500/15 scale-[1.02]"
                            : `bg-white/[0.05] hover:bg-white/10 ${fieldErrors.payment ? "border-rose-500/40" : "border-white/15"}`
                        }`}
                      >
                        <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-gradient-to-r from-amber-400 to-yellow-500 text-black text-[9px] font-black uppercase tracking-wider shadow-lg shadow-amber-500/30 whitespace-nowrap">
                          ⭐ Recomendado
                        </span>
                        <span className={`psf-pay-title text-base font-black tracking-wider ${payment === "rc" ? "text-amber-300" : "text-slate-300"}`}>🪙 RC</span>
                        <span className={`psf-pay-value text-lg font-black mt-1 ${payment === "rc" ? "text-amber-400" : "text-slate-400"}`}>{formatConfigRcCard(quest === "sanguine" ? ownerCfg.sgFirstRc : ownerCfg.swRc)}</span>
                        <span className="psf-pay-subtitle text-[10px] font-bold mt-0.5 text-slate-500">
                          {quest === "sanguine" ? "1ª rotação + 12kk de refil" : "+ 12kk de refil"}
                        </span>
                      </button>
                      {/* 50/50 */}
                      <button
                        type="button"
                        onClick={() => { setPayment("5050"); if (fieldErrors.payment) setFieldErrors(f => ({ ...f, payment: "" })); }}
                        style={{ "--psf-accent": "#a78bfa" } as CSSProperties}
                        className={`psf-choice flex flex-col items-center justify-center px-3 py-4 rounded-xl border-2 cursor-pointer text-center ${
                          payment === "5050"
                            ? "border-violet-500 bg-violet-500/15 shadow-lg shadow-violet-500/15 scale-[1.02]"
                            : `bg-white/[0.05] hover:bg-white/10 ${fieldErrors.payment ? "border-rose-500/40" : "border-white/15"}`
                        }`}
                      >
                        <span className={`psf-pay-title text-base font-black tracking-wider ${payment === "5050" ? "text-violet-300" : "text-slate-300"}`}>⚖️ 50/50</span>
                        <span className={`psf-pay-subtitle text-xs font-bold mt-1 ${payment === "5050" ? "text-violet-400" : "text-slate-400"}`}>
                          {quest === "sanguine" ? "200 RC + metade do item" : "250 RC + metade do item"}
                        </span>
                      </button>
                    </div>
                    {fieldErrors.payment && <div className="text-[10px] text-rose-400 mt-1.5">{fieldErrors.payment}</div>}
                    {payment === "5050" && (
                      <div className="mt-3 flex items-start gap-2.5 bg-violet-500/10 border border-violet-500/30 rounded-xl px-4 py-3 text-[11px] text-violet-200 leading-relaxed animate-in fade-in slide-in-from-top-2 duration-200">
                        <ShieldCheck size={16} className="flex-shrink-0 mt-0.5 text-violet-400" />
                        {quest === "sanguine" ? (
                          <span>
                            <strong>Como funciona o 50/50 na Sanguine:</strong> você paga 200 RC + 12kk de refil na primeira rotação
                            (+100 RC para cada próxima rotação sem drop) e recebe metade do valor da venda do item dropado.
                            Gravamos a abertura da bag e enviamos o vídeo diretamente para o seu WhatsApp.
                          </span>
                        ) : (
                          <span>
                            <strong>Como funciona o 50/50:</strong> você paga 250 RC + e recebe metade do valor da venda do item dropado.
                            Gravamos a abertura do baú e enviamos o vídeo diretamente para o seu WhatsApp.
                          </span>
                        )}
                      </div>
                    )}
                    {quest === "sanguine" && (payment === "pix" || payment === "rc") && (
                      <div className="mt-3 flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/25 rounded-xl px-4 py-3 text-[11px] text-amber-200/90 leading-relaxed animate-in fade-in slide-in-from-top-2 duration-200">
                        <AlertTriangle size={15} className="flex-shrink-0 mt-0.5 text-amber-400" />
                        <span>
                          <strong>Sanguine:</strong> caso não drope, cada próxima rotação custa <strong>{formatConfigRcLong(ownerCfg.sgExtraRc)} Rubini Coins</strong> ou <strong>Pix {formatConfigPixLong(ownerCfg.sgExtraPix)}</strong>.
                          Na primeira rotação, o acesso à Quest (5kk) é somado ao refil.
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Navegação */}
                  <div className="flex items-center justify-between pt-1">
                    <button type="button" onClick={goBack} className={navBackCls}>
                      <ChevronLeft size={16} /> Voltar
                    </button>
                    <button type="button" onClick={goNext} className={navNextCls}>
                      Continuar <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ============================================================
                ETAPA 5 — CADASTRO DO PERSONAGEM
               ============================================================ */}
            {step === 5 && quest && (
              <div className="psf-quadro bg-[color-mix(in_oklab,var(--th-n-elev)_92%,white)] border border-cyan-500/50 rounded-3xl shadow-2xl ring-1 ring-white/[0.06]" style={{ "--psf-quadro-accent": "#22d3ee" } as CSSProperties}>
                <div className="psf-quadro-header bg-gradient-to-r from-cyan-500/10 via-cyan-500/15 to-cyan-500/10 border-b border-cyan-500/20 px-7 py-5 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-sky-600 flex items-center justify-center flex-shrink-0">
                    <Swords size={20} className="text-black" />
                  </div>
                  <div>
                    <h2 className="text-base font-black text-cyan-300 tracking-wide uppercase">Seu personagem</h2>
                    <p className="text-[11px] text-slate-500">Service {questEmoji} {questLabel}</p>
                  </div>
                </div>

                <div className="psf-quadro-inner px-4 py-6 sm:p-7 space-y-6">
                  {/* Nome do personagem */}
                  <div>
                    <label className={labelCls}>Nome do Personagem *</label>
                    <input
                      ref={firstFieldRef}
                      type="text"
                      value={personagem}
                      onChange={e => { setPersonagem(e.target.value.replace(/[^A-Za-zÀ-ÿ\s]/g, "")); if (fieldErrors.personagem) setFieldErrors(f => ({ ...f, personagem: "" })); if (duplicateMsg) setDuplicateMsg(null); }}
                      placeholder="Ex: Sir Knight"
                      maxLength={50}
                      className={`${inputCls} ${fieldErrors.personagem ? "border-rose-500/60" : ""}`}
                    />
                    {fieldErrors.personagem && <div className="text-[10px] text-rose-400 mt-1.5">{fieldErrors.personagem}</div>}
                  </div>

                  {/* Servidor */}
                  <div>
                    <label className={labelCls}>Servidor *</label>
                    <FilterSelect
                      selected={servidor}
                      onSelect={(v: string) => {
                        // Servidores não atendidos pelo dono do link ficam
                        // VISÍVEIS com o sufixo "(Indisponível)" mas nunca
                        // são selecionados — o clique só explica o motivo.
                        if (v.endsWith(UNAVAILABLE_SERVER_SUFFIX)) {
                          setFieldErrors(f => ({ ...f, servidor: "Este serviceiro não atende este servidor. Escolha um servidor disponível." }));
                          return;
                        }
                        setServidor(v); if (fieldErrors.servidor) setFieldErrors(f => ({ ...f, servidor: "" })); if (duplicateMsg) setDuplicateMsg(null);
                      }}
                      options={serverSelectOptions}
                      placeholder="Selecione o servidor"
                      searchable
                      searchPlaceholder="Buscar servidor..."
                      allLabel=""
                      activeColor="cyan"
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-black/60 border border-white/20 hover:border-white/35 focus:border-cyan-400/80 focus:outline-none transition-colors text-sm ${!servidor ? "text-slate-500" : "text-slate-200"}`}
                    />
                    {fieldErrors.servidor && <div className="text-[10px] text-rose-400 mt-1.5">{fieldErrors.servidor}</div>}
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
                            className="psf-voc relative flex flex-col items-center justify-center px-1 py-3.5 rounded-xl border-2 bg-white/[0.05] cursor-pointer"
                            style={{ "--voc-color": color } as CSSProperties}
                            title={VOC_LABEL[v]}
                          >
                            <span className="text-base font-black tracking-wider" style={{ color }}>{v}</span>
                            <span className="text-[8px] text-slate-500 mt-1 leading-tight text-center hidden sm:block">{VOC_LABEL[v]}</span>
                          </button>
                        );
                      })}
                    </div>
                    {voc ? (
                      <div className="text-[10px] text-slate-600 mt-1.5">
                        Level mínimo para {questLabel} com {voc}: <strong className="text-slate-400">{publicMinLevelFor(quest, voc)}</strong>
                      </div>
                    ) : (
                      <div className="text-[10px] text-slate-600 mt-1.5">
                        Escolha a vocação do personagem para ver o level mínimo exigido.
                      </div>
                    )}
                    {fieldErrors.voc && <div className="text-[10px] text-rose-400 mt-1.5">{fieldErrors.voc}</div>}
                  </div>

                  {/* Navegação */}
                  <div className="flex items-center justify-between pt-1">
                    <button type="button" onClick={goBack} className={navBackCls}>
                      <ChevronLeft size={16} /> Voltar
                    </button>
                    <button type="button" onClick={goNext} className={navNextCls}>
                      Continuar <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ============================================================
                ETAPA 6 — LEVEL + CADASTRO
               ============================================================ */}
            {step === 6 && quest && voc && (
              <div className="psf-quadro bg-[color-mix(in_oklab,var(--th-n-elev)_92%,white)] border border-cyan-500/50 rounded-3xl shadow-2xl ring-1 ring-white/[0.06]" style={{ "--psf-quadro-accent": "#22d3ee" } as CSSProperties}>
                <div className="psf-quadro-header bg-gradient-to-r from-cyan-500/10 via-cyan-500/15 to-cyan-500/10 border-b border-cyan-500/20 px-7 py-5 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-sky-600 flex items-center justify-center flex-shrink-0">
                    <Clock size={20} className="text-black" />
                  </div>
                  <div>
                    <h2 className="text-base font-black text-cyan-300 tracking-wide uppercase">Finalização</h2>
                    <p className="text-[11px] text-slate-500">Service {questEmoji} {questLabel} · {personagem || "personagem"} ({voc})</p>
                  </div>
                </div>

                <div className="psf-quadro-inner px-4 py-6 sm:p-7 space-y-6">
                  {/* Requisito da combinação Quest + Vocação */}
                  <div className="flex items-center gap-3 bg-white/[0.03] border border-white/10 rounded-2xl px-4 py-3">
                    <span className="text-xl flex-shrink-0">📊</span>
                    <div className="text-xs text-slate-300 leading-relaxed">
                      <strong className="text-white">{questLabel}</strong> com <strong style={{ color: VOC_COLORS[voc] }}>{voc}</strong> ({VOC_LABEL[voc]}) exige
                      level mínimo <strong className="text-amber-300 text-sm tabular-nums">{publicMinLevelFor(quest, voc)}</strong>.
                    </div>
                  </div>

                  {/* Level */}
                  <div>
                    <label className={labelCls}>Level do Personagem *</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={level}
                      onChange={e => { setLevel(e.target.value.replace(/\D/g, "").slice(0, 5)); if (fieldErrors.level) setFieldErrors(f => ({ ...f, level: "" })); }}
                      placeholder={`Ex: ${publicMinLevelFor(quest, voc)}`}
                      className={`${inputCls} ${fieldErrors.level || (parsedLevel > 0 && levelBlock) ? "border-rose-500/60" : parsedLevel > 0 && !levelBlock ? "border-emerald-500/50" : ""}`}
                    />
                    {/* Feedback imediato do requisito — a MESMA regra bloqueia o envio */}
                    {parsedLevel > 0 && levelBlock && (
                      <div className="mt-2 flex items-start gap-2 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3.5 py-2.5 text-[11px] text-rose-300 leading-relaxed">
                        <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                        <span>{levelBlock}</span>
                      </div>
                    )}
                    {parsedLevel > 0 && !levelBlock && (
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-emerald-400">
                        <CheckCircle2 size={14} /> Level atende ao requisito da Quest.
                      </div>
                    )}
                    {fieldErrors.level && parsedLevel <= 0 && <div className="text-[10px] text-rose-400 mt-1.5">{fieldErrors.level}</div>}
                  </div>

                  {/* Serviceiro — funcionalidade preservada do formulário original:
                        • LINK EXCLUSIVO resolvido → seletor OCULTO; cartão fixo;
                        • link exclusivo INVÁLIDO → aviso + seletor normal;
                        • acesso normal (#/servico) → seletor de sempre. */}
                  {lockedTarget ? (
                    <div>
                      <label className={labelCls}>Serviceiro</label>
                      <div className="flex items-center gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3">
                        <ShieldCheck size={18} className="flex-shrink-0 text-emerald-400" />
                        <div className="min-w-0">
                          <div className="text-sm font-black text-emerald-300 truncate">{lockedTarget.nome}</div>
                          <div className="text-[10px] text-slate-500">Atendente definido por este link exclusivo — seu pedido será enviado diretamente a ele.</div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <label className={labelCls}>Serviceiro</label>
                      {lockedLinkInvalid && (
                        <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
                          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                          <span>O link utilizado não corresponde a um atendente ativo. Selecione o serviceiro abaixo ou deixe "Qualquer um".</span>
                        </div>
                      )}
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
                        className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-black/60 border border-white/20 hover:border-white/35 focus:border-cyan-400/80 focus:outline-none transition-colors text-sm ${!serviceiro ? "text-slate-500" : "text-slate-200"}`}
                      />
                      <div className="text-[10px] text-slate-600 mt-1.5">Deixe "Qualquer um" para qualquer serviceiro disponível, ou selecione um específico.</div>
                    </div>
                  )}

                  {/* ACOMPANHE AO VIVO — exibido SOMENTE quando o serviceiro
                      definido (link exclusivo ou seleção manual) possui link
                      de streaming cadastrado no app (users.twitchChannel).
                      Sem link cadastrado, nada é renderizado. */}
                  {streamHref && streamTarget && (
                    <div className="relative overflow-hidden rounded-2xl border border-violet-500/40 bg-gradient-to-br from-violet-600/15 via-fuchsia-600/[0.07] to-transparent px-4 py-4 sm:px-5 animate-in fade-in slide-in-from-top-2 duration-300">
                      <span aria-hidden className="pointer-events-none absolute -top-12 -right-8 w-36 h-36 rounded-full bg-violet-500/15 blur-2xl" />
                      <div className="relative flex items-start gap-3.5">
                        <span className="w-10 h-10 rounded-xl bg-violet-500/20 border border-violet-500/40 flex items-center justify-center text-lg flex-shrink-0">🎥</span>
                        <div className="min-w-0 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-black text-violet-200">Acompanhe seu Service AO VIVO</span>
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-500/15 border border-red-500/40 text-red-300 text-[9px] font-black uppercase tracking-wider">
                              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> Live
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-300 leading-relaxed">
                            O service é realizado <strong className="text-white">em Live</strong> — você pode e deve assistir
                            à execução do service em tempo real. Entre no canal de{" "}
                            <strong className="text-violet-200">{streamTarget.nome}</strong>, acompanhe tudo de perto
                            e aproveite para <strong className="text-white">seguir o canal</strong>!
                          </p>
                          <a
                            href={streamHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-violet-500/50 bg-violet-500/15 hover:bg-violet-500/25 text-violet-200 hover:text-white text-[11px] font-black tracking-wide transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
                          >
                            🔴 Assistir e seguir o canal
                            <span className="hidden sm:inline text-[9px] font-bold text-violet-300/70 normal-case">{streamDisplay}</span>
                            <ChevronRight size={12} />
                          </a>
                        </div>
                      </div>
                    </div>
                  )}

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

                  {/* Botão cadastrar */}
                  <button
                    type="submit"
                    disabled={formState === "submitting" || !!levelBlock}
                    title={levelBlock || undefined}
                    className="psf-submit w-full py-4 rounded-2xl text-base font-black tracking-wide text-black bg-gradient-to-r from-cyan-400 to-sky-500 hover:from-cyan-300 hover:to-sky-400 shadow-xl shadow-cyan-500/25 hover:shadow-cyan-500/40 transition-all duration-300 cursor-pointer flex items-center justify-center gap-2.5 hover:scale-[1.015] active:scale-[0.985] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
                  >
                    {formState === "submitting" ? (
                      <>
                        <div className="w-5 h-5 rounded-full border-2 border-black/40 border-t-black animate-spin" />
                        Enviando...
                      </>
                    ) : (
                      <>
                        <Save size={19} /> Cadastrar Personagem
                      </>
                    )}
                  </button>

                  {/* Navegação (voltar) */}
                  <div className="flex items-center justify-start">
                    <button type="button" onClick={goBack} className={navBackCls}>
                      <ChevronLeft size={16} /> Voltar
                    </button>
                  </div>

                  {/* Selo de segurança */}
                  <div className="flex items-center justify-center gap-2 text-[10px] text-slate-600 pt-1">
                    <ShieldCheck size={13} className="text-emerald-500/60" />
                    {RECAPTCHA_SITE_KEY
                      ? <span>Protegido por reCAPTCHA · Google <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-400">Privacidade</a> · <a href="https://policies.google.com/terms" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-400">Termos</a></span>
                      : <span>Conexão segura · Seus dados são usados apenas para contato</span>
                    }
                  </div>
                </div>
              </div>
            )}

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
