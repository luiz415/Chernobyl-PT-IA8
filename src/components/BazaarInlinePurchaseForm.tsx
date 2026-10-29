// ============================================================================
// CONFIRMAÇÃO INLINE DO "COMPRADO" — COMPONENTE ÚNICO DAS DUAS GUIAS (71ª)
// ----------------------------------------------------------------------------
// Extração 1:1 do formulário inline da guia "Personagens para SW/SG/GB"
// (BazarPanel) para reutilização pela guia "Personagens com Itens"
// (BazaarItemsPanel): MESMO visual, MESMAS validações, MESMOS estados de
// apresentação (conta obrigatória/última usada/escolhida, valor obrigatório,
// lista de contas com busca, foco automático, Esc para fechar) — uma única
// implementação, zero duplicação entre as guias.
//
// NOVIDADE (71ª tarefa): caixa "Descontar valor dos itens" — quando MARCADA,
// o custo final persistido do personagem passa a ser
//   Valor pago − Valor dos itens convertido para RC
// (conversão calculada pelo CHAMADOR com a taxa oficial do servidor e os
// valores efetivos — personalizações do modal "Ver"/"Detalhes" preservadas).
// O desconto é aplicado UMA única vez, pelo App (addCharacterFromBazaar) —
// este formulário apenas informa a escolha; desmarcada ⇒ comportamento
// anterior inalterado. A preferência (marcada/desmarcada) é persistida POR
// USUÁRIO no mesmo mecanismo de preferências do app (loadUIState/saveUIState,
// chave por uid — nunca compartilhada entre contas) e sobrevive a fechar/
// reabrir o fluxo e recarregar a página.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { loadUIState, saveUIState } from "../storage";

/** Chave POR USUÁRIO da preferência "Descontar valor dos itens" (71ª). */
const PURCHASE_DISCOUNT_PREF_KEY_PREFIX = "rubinot_bazaar_purchase_discount_items";

function discountPrefKey(uid: string | undefined): string {
  return `${PURCHASE_DISCOUNT_PREF_KEY_PREFIX}_${String(uid || "").trim() || "local"}`;
}

/** Lê a última escolha persistida do usuário para a caixa de desconto. */
export function readPurchaseDiscountPreference(uid: string | undefined): boolean {
  return loadUIState<unknown>(discountPrefKey(uid), false) === true;
}

export function savePurchaseDiscountPreference(uid: string | undefined, enabled: boolean): void {
  saveUIState(discountPrefKey(uid), enabled === true);
}

/**
 * Validação ÚNICA do fluxo inline (movida do BazarPanel — regra idêntica).
 * `valorPago` é mantido como texto até a confirmação para distinguir campo
 * vazio de um valor informado explicitamente como zero.
 */
export function getBazaarInlinePurchaseValidationError(account: string, valorPago: string): string | null {
  if (!account.trim()) return "Informe a conta do personagem.";
  if (!valorPago.trim()) return "Informe o valor pago em RC.";
  if (!/^\d+$/.test(valorPago)) return "O valor pago deve conter somente números.";
  const parsedValue = Number(valorPago);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) return "Informe um valor pago válido.";
  return null;
}

/**
 * Situação do DESCONTO DOS ITENS para o personagem do formulário, calculada
 * pelo chamador (cada guia conhece a própria fonte de itens/personalizações):
 * `rc` = valor dos itens já convertido para RC pela taxa oficial do servidor
 * (regras canônicas do app); `null` = desconto indisponível (sem itens com
 * valor ou servidor sem cotação) — a caixa aparece desabilitada com o motivo.
 */
export interface BazaarPurchaseDiscountInfo {
  rc: number | null;
  /** Descrição exibida no título da caixa (como o RC foi obtido). */
  detail?: string;
  /** Motivo de indisponibilidade (quando `rc` é null). */
  reason?: string;
}

interface BazaarInlinePurchaseFormProps {
  /** Identificador do leilão/linha — usado apenas para ids de acessibilidade. */
  formId: string;
  characterName: string;
  /** Resumo "Servidor · VOC · Lv X" exibido ao lado do nome. */
  characterSummary: string;
  /** Contas já cadastradas no app (projeção visual — nenhuma fonte nova). */
  accounts: string[];
  /** Conta pré-preenchida (última utilizada pelo usuário; "" = nenhuma). */
  initialAccount: string;
  /** Uid do usuário — persistência POR USUÁRIO da preferência de desconto. */
  currentUid?: string;
  /** Situação do desconto dos itens calculada pelo chamador. */
  discount: BazaarPurchaseDiscountInfo;
  /** Persiste a conta como "última utilizada" (seleção explícita/confirmação). */
  onRememberAccount?(account: string): void;
  /**
   * Confirmação com dados VÁLIDOS. `applyItemsDiscount` só vem `true` com a
   * caixa marcada E desconto disponível. Retorno com erro (ex.: personagem
   * duplicado) é exibido inline no próprio formulário.
   */
  onConfirm(input: { account: string; valorPago: number; applyItemsDiscount: boolean }): { ok: boolean; error?: string } | undefined;
  onCancel(): void;
}

export default function BazaarInlinePurchaseForm({
  formId,
  characterName,
  characterSummary,
  accounts,
  initialAccount,
  currentUid,
  discount,
  onRememberAccount,
  onConfirm,
  onCancel,
}: BazaarInlinePurchaseFormProps) {
  // ── Estados do rascunho (migrados 1:1 do BazarPanel) ──────────────────────
  const [account, setAccount] = useState(initialAccount);
  const [valorPago, setValorPago] = useState("");
  const [error, setError] = useState("");
  // Apresentação: conta pré-preenchida com a última utilizada (pulso "confira
  // antes de confirmar") × conta escolhida explicitamente na lista.
  const [accountPreset, setAccountPreset] = useState(!!initialAccount.trim());
  const [accountSelected, setAccountSelected] = useState(false);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [accountSearch, setAccountSearch] = useState("");
  const accountPickerRef = useRef<HTMLDivElement | null>(null);
  const accountInputRef = useRef<HTMLInputElement | null>(null);
  const valorPagoInputRef = useRef<HTMLInputElement | null>(null);

  // ── DESCONTO DOS ITENS (71ª): preferência persistida POR USUÁRIO ─────────
  const discountAvailable = discount.rc !== null && (discount.rc as number) > 0;
  const [applyDiscount, setApplyDiscount] = useState(() => readPurchaseDiscountPreference(currentUid));
  // Troca de usuário (raro com o form aberto): relê a preferência DELE.
  useEffect(() => { setApplyDiscount(readPurchaseDiscountPreference(currentUid)); }, [currentUid]);

  // Foco acompanha o fluxo (mesma regra do BazarPanel): primeira inclusão
  // começa na conta; com a última conta pré-preenchida, direto no valor pago.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const target = initialAccount.trim() ? valorPagoInputRef.current : accountInputRef.current;
      target?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fecha a lista de contas ao clicar fora (mesmo comportamento anterior).
  useEffect(() => {
    if (!isAccountMenuOpen) return;
    function closeOnOutsidePointer(event: MouseEvent) {
      if (!accountPickerRef.current?.contains(event.target as Node)) {
        setIsAccountMenuOpen(false);
        setAccountSearch("");
      }
    }
    document.addEventListener("mousedown", closeOnOutsidePointer);
    return () => document.removeEventListener("mousedown", closeOnOutsidePointer);
  }, [isAccountMenuOpen]);

  const availableAccounts = Array.from(new Set(accounts.map(item => item.trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const searchQuery = accountSearch.trim().toLocaleLowerCase("pt-BR");
  const filteredAccounts = searchQuery
    ? availableAccounts.filter(item => item.toLocaleLowerCase("pt-BR").includes(searchQuery))
    : availableAccounts;

  const accountValue = account.trim();
  const valorValue = valorPago.trim();
  const accountEmpty = !accountValue;
  const accountPresetActive = accountPreset && !!accountValue;
  const accountSelectedActive = accountSelected && !!accountValue;
  const accountChoosing = isAccountMenuOpen;
  const accountConfirmed = !!accountValue && !accountPresetActive;
  const valorEmpty = !valorValue;
  const formReady = accountConfirmed && !!valorValue;

  // Resumo do CUSTO FINAL com o desconto aplicado — prévia transparente do
  // que será persistido (mesma conta feita pelo App: valor pago − RC dos
  // itens; o resultado pode ser NEGATIVO = personagem com saldo positivo).
  const previewDiscountRc = discountAvailable && applyDiscount ? (discount.rc as number) : 0;
  const parsedValor = /^\d+$/.test(valorValue) ? Number(valorValue) : null;
  const finalCostPreview = parsedValor !== null && previewDiscountRc > 0 ? parsedValor - previewDiscountRc : null;

  function selectAccount(selected: string) {
    const normalized = selected.trim();
    setAccount(normalized);
    setError("");
    setAccountPreset(false);
    setAccountSelected(true);
    // Uma seleção é uma intenção explícita: persiste por usuário imediatamente
    // (mesma regra do fluxo original do BazarPanel).
    onRememberAccount?.(normalized);
    setIsAccountMenuOpen(false);
    setAccountSearch("");
    window.setTimeout(() => valorPagoInputRef.current?.focus(), 0);
  }

  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        const validationError = getBazaarInlinePurchaseValidationError(account, valorPago);
        if (validationError) {
          setError(validationError);
          return;
        }
        const response = onConfirm({
          account: account.trim(),
          valorPago: Number(valorPago),
          applyItemsDiscount: discountAvailable && applyDiscount,
        });
        if (response && !response.ok) {
          setError(response.error || "Não foi possível adicionar este personagem.");
        }
      }}
      className={`mx-auto flex w-full max-w-4xl flex-col gap-2 rounded-xl border bg-[var(--th-bg-raised)]/90 px-3 py-2.5 shadow-lg shadow-black/20 transition-colors sm:flex-row sm:flex-wrap sm:items-end ${formReady ? "border-emerald-400/50 shadow-emerald-500/10" : "border-emerald-400/25"}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[11px] font-black text-emerald-200">Adicionar {characterName || "personagem"}</span>
          <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] text-slate-400">
            {characterSummary}
          </span>
        </div>
        <p className="mt-0.5 text-[10px] leading-tight text-slate-500">
          {accountPresetActive ? (
            <>Os dados do Bazaar serão importados automaticamente. A conta foi <strong className="font-bold text-amber-300">pré-preenchida com a última utilizada</strong> — confira se é a correta antes de confirmar (pode alterar normalmente).</>
          ) : (
            "Os dados do Bazaar serão importados automaticamente. Informe somente a conta e o valor pago."
          )}
        </p>
      </div>
      <label className="block min-w-0 sm:w-44">
        <span className="mb-1 flex flex-wrap items-center gap-1 text-[9px] font-black uppercase tracking-wider text-slate-400">
          Conta
          {accountChoosing ? (
            <span className="inline-flex items-center gap-1 rounded border border-emerald-400/40 bg-emerald-500/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-emerald-300">escolhendo…</span>
          ) : accountEmpty ? (
            <span className="inline-flex items-center gap-1 rounded border border-amber-400/40 bg-amber-500/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-amber-300" title="Selecione na lista ou digite a conta do personagem"><span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />obrigatória</span>
          ) : accountPresetActive ? (
            <span className="inline-flex items-center gap-1 rounded border border-amber-400/40 bg-amber-500/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-amber-300" title="Pré-preenchida com a última conta utilizada — confira antes de confirmar. Você pode alterar normalmente."><span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />última usada — confira</span>
          ) : accountSelectedActive ? (
            <span className="inline-flex items-center gap-1 rounded border border-emerald-400/40 bg-emerald-500/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-emerald-300" title="Conta escolhida na lista de contas disponíveis">✓ selecionada</span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded border border-emerald-400/40 bg-emerald-500/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-emerald-300" title="Conta digitada manualmente">✓ preenchida</span>
          )}
        </span>
        <div ref={accountPickerRef} className="relative">
          <input
            ref={accountInputRef}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={isAccountMenuOpen}
            aria-controls={`bazaar-account-options-${formId}`}
            value={account}
            maxLength={40}
            onClick={() => {
              setAccountSearch("");
              setIsAccountMenuOpen(true);
            }}
            onChange={event => {
              const value = event.target.value;
              setAccount(value);
              setError("");
              setAccountPreset(false);
              setAccountSelected(false);
              setAccountSearch(value);
              setIsAccountMenuOpen(true);
            }}
            onKeyDown={event => {
              if (event.key === "Escape") {
                event.preventDefault();
                if (isAccountMenuOpen) {
                  setIsAccountMenuOpen(false);
                  setAccountSearch("");
                } else {
                  onCancel();
                }
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setAccountSearch("");
                setIsAccountMenuOpen(true);
              }
            }}
            placeholder={availableAccounts.length ? "Selecionar ou digitar" : "Digite uma conta"}
            aria-label={`Conta para ${characterName}`}
            title={accountPresetActive
              ? "Pré-preenchida com a última conta utilizada — confira antes de confirmar. Você pode alterar normalmente."
              : accountEmpty
                ? "Selecione na lista ou digite a conta do personagem"
                : `Conta selecionada: ${accountValue}`}
            className={`h-8 w-full rounded-lg border bg-black/30 px-2 pr-7 text-xs outline-none transition-colors focus:border-emerald-400/60 ${
              error && !accountValue
                ? "border-rose-400/60 text-slate-100 placeholder:text-rose-400/70"
                : accountChoosing
                  ? "border-emerald-400/70 bg-emerald-500/[0.06] text-emerald-100 shadow-[0_0_10px_rgba(16,185,129,0.20)] placeholder:text-emerald-400/60"
                  : accountEmpty
                    ? "bz-field-pulse border-amber-400/60 bg-amber-500/[0.04] text-slate-100 placeholder:text-amber-500/80"
                    : accountPresetActive
                      ? "bz-field-pulse bz-field-pulse--soft border-amber-400/50 bg-amber-500/[0.04] text-amber-100 placeholder:text-amber-500/80"
                      : "border-emerald-400/55 bg-emerald-500/[0.05] text-emerald-100 font-bold shadow-[0_0_8px_rgba(16,185,129,0.16)] placeholder:text-slate-600"
            }`}
          />
          <button
            type="button"
            aria-label="Abrir lista de contas"
            aria-expanded={isAccountMenuOpen}
            onClick={() => {
              setAccountSearch("");
              setIsAccountMenuOpen(open => !open);
            }}
            className="absolute inset-y-0 right-0 inline-flex w-7 items-center justify-center text-slate-500 transition-colors hover:text-emerald-200 cursor-pointer"
          >
            <ChevronDown size={13} className={`transition-transform ${isAccountMenuOpen ? "rotate-180" : ""}`} />
          </button>
          {isAccountMenuOpen && (
            <div id={`bazaar-account-options-${formId}`} role="listbox" className="absolute left-0 right-0 z-[80] mt-1 overflow-hidden rounded-lg border border-emerald-400/30 bg-[var(--th-bg-raised)]/95 shadow-xl shadow-black/45 backdrop-blur-md">
              <div className="border-b border-white/10 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-slate-500">
                Contas disponíveis
              </div>
              <div className="max-h-40 overflow-y-auto custom-scrollbar py-1">
                {filteredAccounts.length > 0 ? filteredAccounts.map(item => (
                  <button
                    key={item}
                    type="button"
                    role="option"
                    aria-selected={item === account}
                    onClick={() => selectAccount(item)}
                    className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors cursor-pointer ${
                      item === account
                        ? "bg-emerald-500/15 text-emerald-100 ring-1 ring-inset ring-emerald-400/30"
                        : "text-slate-300 hover:bg-white/[0.06] hover:text-white"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate font-bold">{item}</span>
                    {item === account && (
                      <span className="flex flex-shrink-0 items-center gap-1 text-[8px] font-black uppercase tracking-wide text-emerald-300">
                        <Check size={12} strokeWidth={3} /> Selecionada
                      </span>
                    )}
                  </button>
                )) : (
                  <div className="px-2.5 py-2 text-[10px] leading-tight text-slate-500">
                    {availableAccounts.length
                      ? "Nenhuma conta cadastrada corresponde. Você pode usar a conta digitada."
                      : "Nenhuma conta cadastrada ainda. Digite uma nova conta para continuar."}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </label>
      <label className="block min-w-0 sm:w-28">
        <span className="mb-1 flex flex-wrap items-center gap-1 text-[9px] font-black uppercase tracking-wider text-slate-400">
          Valor pago
          {valorEmpty ? (
            <span className="inline-flex items-center gap-1 rounded border border-amber-400/40 bg-amber-500/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-amber-300" title="Informe o valor pago em RC"><span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />obrigatório</span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded border border-emerald-400/40 bg-emerald-500/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-emerald-300" title="Valor informado">✓ informado</span>
          )}
        </span>
        <input
          ref={valorPagoInputRef}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={valorPago}
          maxLength={15}
          onChange={event => {
            const value = event.target.value.replace(/\D/g, "");
            setValorPago(value);
            setError("");
          }}
          onKeyDown={event => { if (event.key === "Escape") onCancel(); }}
          placeholder="0 RC"
          aria-label={`Valor pago por ${characterName}`}
          title={valorEmpty ? "Informe o valor pago em RC" : "Valor pago em RC"}
          className={`h-8 w-full rounded-lg border bg-black/30 px-2 text-right font-mono text-xs outline-none transition-colors focus:border-emerald-400/60 ${
            error && !valorValue
              ? "border-rose-400/60 text-slate-100 placeholder:text-rose-400/70"
              : valorEmpty
                ? "bz-field-pulse border-amber-400/60 bg-amber-500/[0.04] text-slate-100 placeholder:text-amber-500/80"
                : "border-emerald-400/55 bg-emerald-500/[0.05] text-emerald-200 font-bold shadow-[0_0_8px_rgba(16,185,129,0.16)] placeholder:text-slate-600"
          }`}
        />
      </label>
      <div className="flex items-center gap-1.5 sm:flex-shrink-0">
        <button
          type="submit"
          title={formReady
            ? "Adicionar o personagem à sua lista"
            : "Antes de confirmar, confira a conta selecionada e o valor pago"}
          className={`inline-flex h-8 items-center justify-center gap-1 rounded-lg border px-2.5 text-[10px] font-black transition-colors cursor-pointer ${
            formReady
              ? "border-emerald-400/60 bg-emerald-500/25 text-emerald-100 shadow-[0_0_14px_rgba(16,185,129,0.28)] hover:bg-emerald-500/35"
              : "border-emerald-400/45 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
          }`}
        >
          <Check size={12} strokeWidth={3} /> Confirmar
        </button>
        <button type="button" onClick={onCancel} className="inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[10px] font-black text-slate-400 transition-colors hover:bg-white/10 hover:text-white cursor-pointer">
          <X size={12} strokeWidth={3} /> Cancelar
        </button>
      </div>
      {/* ── DESCONTAR VALOR DOS ITENS (71ª) — disponível nas DUAS guias ──────
          Caixa persistida POR USUÁRIO; desabilitada (com o motivo no título)
          quando o personagem não tem itens com valor ou o servidor está sem
          cotação. A prévia mostra exatamente o custo final que será salvo. */}
      <div className="w-full basis-full flex flex-wrap items-center gap-x-3 gap-y-1">
        <label
          className={`inline-flex items-center gap-1.5 text-[10px] font-bold ${discountAvailable ? "text-slate-300 cursor-pointer" : "text-slate-600 cursor-not-allowed"}`}
          title={discountAvailable
            ? `Custo final = Valor pago − ${(discount.rc as number).toLocaleString("de-DE")} RC (valor dos itens convertido pela cotação oficial do servidor${discount.detail ? ` — ${discount.detail}` : ""}). O desconto é aplicado uma única vez, ao confirmar.`
            : (discount.reason || "Desconto indisponível para este personagem.")}
        >
          <input
            type="checkbox"
            checked={discountAvailable && applyDiscount}
            disabled={!discountAvailable}
            onChange={event => {
              const checked = event.target.checked;
              setApplyDiscount(checked);
              // Última escolha do usuário persistida (volta marcada/desmarcada
              // ao reabrir o fluxo e após recarregar a página).
              savePurchaseDiscountPreference(currentUid, checked);
            }}
            className="h-3.5 w-3.5 accent-emerald-500 cursor-pointer disabled:cursor-not-allowed"
          />
          <span>Descontar valor dos itens</span>
          {discountAvailable && (
            <span className="font-mono text-emerald-300">(−{(discount.rc as number).toLocaleString("de-DE")} RC)</span>
          )}
        </label>
        {finalCostPreview !== null && (
          <span
            className={`text-[10px] font-bold ${finalCostPreview < 0 ? "text-emerald-300" : "text-slate-400"}`}
            title="Valor que será salvo como custo do personagem (Valor pago − valor dos itens em RC). Negativo = os itens valem mais do que o valor pago (saldo positivo)."
          >
            Custo final: <span className="font-mono">{finalCostPreview.toLocaleString("de-DE")} RC</span>
          </span>
        )}
      </div>
      {error && <p role="alert" className="w-full basis-full text-[10px] font-medium text-rose-300">{error}</p>}
    </form>
  );
}
