import { useState, useMemo, useEffect } from "react";
import { Sword, Coins, Award, Clock, User, Archive } from "lucide-react";
import type { PartyTab } from "../types";
import { formatRC } from "../types";
import { useAuth } from "../context/AuthContext";
import { FilterSelect } from "./FilterTypes";
import { serverLabel } from "../constants/servers";

const ITEM_COLORS: Record<string, string> = {
  "Soulbleeder": "#22c55e", "Soulkamas": "#22c55e", "Soulshredder": "#22c55e",
  "Pair of Soulwalkers": "#4ade80", "Soulshell": "#4ade80",
  "Pair of Soulstalkers": "#86efac", "Souleater": "#86efac", "Soulmaimer": "#86efac",
  "Soultainter": "#a3e635", "Soulmantle": "#a3e635", "Soulgarb": "#a3e635",
  "Soulhexer": "#eab308", "Soulcrusher": "#eab308",
  "Soulshanks": "#f97316", "Soulstrider": "#f97316", "Soulsoles": "#f97316",
  "Soulcutter": "#ef4444", "Soulpiercer": "#ef4444",
  "Soulshroud": "#dc2626", "Soulbastion": "#dc2626", "Soulbiter": "#dc2626",
  "Grand Sanguine Bow": "#fbbf24", "Grand Sanguine Crossbow": "#fbbf24",
  "Grand Sanguine Rod": "#fbbf24", "Grand Sanguine Coil": "#fbbf24",
  "Grand Sanguine Claws": "#fbbf24", "Grand Sanguine Blade": "#fbbf24",
  "Grand Sanguine Battleaxe": "#fbbf24", "Grand Sanguine Bludgeon": "#fbbf24",
  "Grand Sanguine Razor": "#fbbf24", "Grand Sanguine Hatchet": "#fbbf24",
  "Grand Sanguine Cudgel": "#fbbf24",
  "Sanguine Bow": "#22c55e",
  "Sanguine Legs": "#22c55e",
  "Sanguine Greaves": "#4ade80",
  "Sanguine Coil": "#4ade80",
  "Sanguine Razor": "#86efac",
  "Sanguine Claws": "#86efac",
  "Sanguine Rod": "#a3e635",
  "Sanguine Trousers": "#a3e635",
  "Sanguine Boots": "#eab308",
  "Sanguine Galoshes": "#eab308",
  "Sanguine Bludgeon": "#f97316",
  "Sanguine Blade": "#f97316",
  "Sanguine Crossbow": "#ef4444",
  "Sanguine Battleaxe": "#ef4444",
  "Sanguine Hatchet": "#dc2626",
  "Sanguine Cudgel": "#dc2626",
};

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h <= 0) return `${m}m`;
  return `${h}h${m}m`;
}

type SortKey = "date" | "profit";
type SortDir = "asc" | "desc";

function getPartyTotalValue(p: PartyTab): number {
  const selIds = p.selectedIds || [];
  const custs = p.customMembers || [];
  const memberIds = [...selIds, ...custs.map(c => c.id)];
  const sdMap = p.slotData || {};
  return memberIds.reduce((sum, id) => sum + (sdMap[id]?.itemVendido || 0), 0);
}

function getPartyDateValue(p: PartyTab): number {
  if (p.ptStartedAt && p.ptDuration) return p.ptStartedAt + p.ptDuration;
  return p.archivedAt || p.ptStartedAt || p.createdAt || 0;
}

function getPartyMainServer(p: PartyTab): string {
  const counts: Record<string, number> = {};
  const addServer = (srv?: string) => {
    // Canoniza antes de contar: snapshots antigos gravados com o nome
    // pré-merge somam no servidor atual em vez de virar uma linha à parte.
    const clean = serverLabel(srv);
    if (!clean) return;
    counts[clean] = (counts[clean] || 0) + 1;
  };

  (p.selectedIds || []).forEach(id => addServer(p.memberSnapshots?.[id]?.servidor));
  (p.customMembers || []).forEach(member => addServer(member.servidor));
  if (p.servidor) addServer(p.servidor);

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"));
  return sorted[0]?.[0] || "—";
}

// ============================================================================
// ArchivedPartyList — Histórico de PT's (Hist. PT's)
// ============================================================================
// Trabalha EXCLUSIVAMENTE com PTs provenientes da coleção "archivedParties".
// Toda PT exibida aqui já foi definitivamente finalizada (botão "PAGAMENTO
// REALIZADO / FINALIZAR PT" ou marcada como Falha) e NÃO pode mais ser reaberta.
// O componente serve apenas para consulta histórica.
// ============================================================================
export default function ArchivedPartyList({ parties, userName, highlightedId, onClearHighlight }: {
  parties: PartyTab[];
  // onRestore/onDelete mantidos opcionais por compatibilidade com o App.tsx,
  // porém NÃO são utilizados — não há restauração no novo fluxo.
  onRestore?: (id: string) => void;
  onDelete?: (id: string) => void;
  userName: string;
  highlightedId?: string | null;
  // Callback para limpar o estado de destaque no App.tsx após o consumo único.
  onClearHighlight?: () => void;
}) {
  const { currentUser, userProfile } = useAuth();
  const isBoss = userProfile?.role === "Boss";
  const [onlyMine, setOnlyMine] = useState(false);

  // Efeito para destacar e realizar scroll até a PT arquivada quando invocada a partir de uma notificação
  // Comportamento de uso único: após o destaque ser consumido, limpa o estado no App.tsx
  // para evitar que volte a ocorrer ao reabrir a aba de histórico.
  const [flashingId, setFlashingId] = useState<string | null>(null);
  useEffect(() => {
    if (!highlightedId) return;
    setFlashingId(highlightedId);
    const flashTimer = setTimeout(() => setFlashingId(null), 4000);
    // Realiza scroll até o card
    const scrollTimer = setTimeout(() => {
      const el = document.getElementById(`archived_pt_${highlightedId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Limpa o estado de destaque no pai imediatamente após o consumo
      if (onClearHighlight) onClearHighlight();
    }, 100);
    return () => {
      clearTimeout(flashTimer);
      clearTimeout(scrollTimer);
    };
  }, [highlightedId, parties, onClearHighlight]);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [serverFilter, setServerFilter] = useState("");
  const [characterFilter, setCharacterFilter] = useState("");
  const [charNameFilter, setCharNameFilter] = useState("");
  // Normal e VIP veem apenas as próprias PT's. Filtro "Minhas PT's" só é exibido ao Boss.
  const effectiveOnlyMine = !isBoss ? true : onlyMine;

  const visibilityParties = useMemo(() => {
    const uid = currentUser?.uid;
    return parties.filter(p => {
      if (p.visibility !== "private") return true;
      if (userProfile?.role === "Boss") return true;
      if (!uid) return false;
      if (p.LeaderPT === uid || p.leaderUid === uid) return true;
      return Object.values(p.slotData || {}).some(sd => sd.ownerUid === uid);
    });
  }, [parties, currentUser?.uid, userProfile?.role]);

  const filteredParties = useMemo(() => {
    if (!effectiveOnlyMine || !userName) return visibilityParties;
    const lowerUser = userName.toLowerCase();
    return visibilityParties.filter(p => {
      // Líder da PT
      if (p.LeaderPT && p.LeaderPT.toLowerCase() === lowerUser) return true;

      // Participante via slotData (owner/player)
      if (p.slotData) {
        const isParticipant = Object.values(p.slotData).some(sd =>
          (sd.owner && sd.owner.toLowerCase() === lowerUser) ||
          (sd.player && sd.player.toLowerCase() === lowerUser)
        );
        if (isParticipant) return true;
      }

      // Membro externo (customMembers)
      if (p.customMembers) {
        const isCustom = p.customMembers.some(cm =>
          cm.label && cm.label.toLowerCase() === lowerUser
        );
        if (isCustom) return true;
      }

      return false;
    });
  }, [visibilityParties, effectiveOnlyMine, userName]);

  // Lista de TODOS os personagens participantes (jogadores) já presentes
  // em PTs visíveis (visibilityParties), usada para alimentar o filtro
  // "Personagens" — independe do filtro "Minhas PT's" para permitir
  // buscas em PTs de outros usuários.
  const characterOptions = useMemo(() => {
    const set = new Set<string>();
    visibilityParties.forEach(p => {
      const selIds = p.selectedIds || [];
      const custs = p.customMembers || [];
      const sdMap = p.slotData || {};
      selIds.forEach((id, idx) => {
        const sd = sdMap[id];
        let nome: string | null = null;
        if (sd && sd.player && sd.player.trim()) nome = sd.player.trim();
        else if (sd && sd.owner && sd.owner.trim()) nome = sd.owner.trim();
        const ci = idx - selIds.length;
        if (!nome && ci >= 0 && ci < custs.length && custs[ci].label) nome = custs[ci].label;
        if (nome) set.add(nome);
      });
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
  }, [visibilityParties]);

  // Filtra PTs que contenham o personagem (jogador) pesquisado.
  // A pesquisa é parcial e ignora maiúsculas/minúsculas.
  const characterFilteredParties = useMemo(() => {
    if (!characterFilter) return filteredParties;
    const needle = characterFilter.toLowerCase();
    return filteredParties.filter(p => {
      const selIds = p.selectedIds || [];
      const custs = p.customMembers || [];
      const sdMap = p.slotData || {};
      for (let i = 0; i < selIds.length; i++) {
        const id = selIds[i];
        const sd = sdMap[id];
        if (sd && sd.player && sd.player.toLowerCase().includes(needle)) return true;
        if (sd && sd.owner && sd.owner.toLowerCase().includes(needle)) return true;
      }
      for (let i = 0; i < custs.length; i++) {
        if (custs[i].label && custs[i].label.toLowerCase().includes(needle)) return true;
      }
      return false;
    });
  }, [filteredParties, characterFilter]);

  // Lista de PERSONAGENS (nomes dos chars, extraídos de memberSnapshots e customMembers),
  // usada para o filtro "Filtrar Personagem". Pesquisa parcial, case-insensitive.
  const charNameOptions = useMemo(() => {
    const set = new Set<string>();
    filteredParties.forEach(p => {
      const custs = p.customMembers || [];
      (p.selectedIds || []).forEach(id => {
        const snap = p.memberSnapshots?.[id];
        if (snap?.personagem && snap.personagem.trim()) set.add(snap.personagem.trim());
      });
      custs.forEach(c => { if (c.label && c.label.trim()) set.add(c.label.trim()); });
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
  }, [filteredParties]);

  // Filtra PTs que contenham o PERSONAGEM (nome do char) pesquisado.
  const charNameFilteredParties = useMemo(() => {
    if (!charNameFilter) return characterFilteredParties;
    const needle = charNameFilter.toLowerCase();
    return characterFilteredParties.filter(p => {
      const custs = p.customMembers || [];
      for (let i = 0; i < (p.selectedIds || []).length; i++) {
        const id = p.selectedIds[i];
        const snap = p.memberSnapshots?.[id];
        if (snap?.personagem && snap.personagem.toLowerCase().includes(needle)) return true;
      }
      for (let i = 0; i < custs.length; i++) {
        if (custs[i].label && custs[i].label.toLowerCase().includes(needle)) return true;
      }
      return false;
    });
  }, [characterFilteredParties, charNameFilter]);

  const sortedParties = useMemo(() => {
    const visible = serverFilter
      ? charNameFilteredParties.filter(p => getPartyMainServer(p) === serverFilter)
      : charNameFilteredParties;

    return [...visible].sort((a, b) => {
      const av = sortKey === "date" ? getPartyDateValue(a) : getPartyTotalValue(a);
      const bv = sortKey === "date" ? getPartyDateValue(b) : getPartyTotalValue(b);
      return sortDir === "asc" ? av - bv : bv - av;
    });
  }, [charNameFilteredParties, serverFilter, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(prev => prev === "asc" ? "desc" : "asc");
    } else {
       setSortKey(key);
      setSortDir("desc");
    }
  }

  // Opções do filtro de servidor, derivadas APÓS os filtros de personagem para
  // manter coerência com a lista visível final.
  const serverOptions = useMemo(() => {
    return Array.from(new Set(charNameFilteredParties.map(getPartyMainServer).filter(server => server !== "—"))).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [charNameFilteredParties]);

  function renderCard(p: PartyTab) {
    const selIds = p.selectedIds || [];
    const custs = p.customMembers || [];
    const memberIds = [...selIds, ...custs.map(c => c.id)];
    const sdMap = p.slotData || {};

    const allSD = memberIds.map(id => sdMap[id] || { deaths: 0, drop: 0, itemDropado: "", itemVendido: 0, player: "", split: true, owner: "", notes: "", pago: false });

    // Informações gerais
    const dataConclusao = p.ptStartedAt && p.ptDuration
      ? new Date(p.ptStartedAt + p.ptDuration).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "—";

    const duracaoQuest = p.ptDuration ? formatDuration(p.ptDuration) : "—";

    // Itens Dropados (usados apenas para calcular o indicador de LUCRO
    // por raridade — cada item é exibido individualmente na seção de drops
    // via `dropsDetalhados`, sem qualquer validação de "vendido").
    const itensDropados = allSD.map(sd => sd.itemDropado).filter(Boolean);

    // Média do Lucro
    let totalScore = 0;
    itensDropados.forEach(item => {
      const col = ITEM_COLORS[item];
      if (col === "#22c55e" || col === "#fbbf24") totalScore += 5;
      else if (col === "#4ade80" || col === "#86efac" || col === "#a3e635") totalScore += 4;
      else if (col === "#eab308") totalScore += 3;
      else if (col === "#f97316") totalScore += 2;
      else totalScore += 1;
    });

    let classificacao = { label: "—", color: "#64748b" };
    if (itensDropados.length > 0) {
      const avg = totalScore / itensDropados.length;
      if (avg >= 4.5) classificacao = { label: "Lucro Alto", color: "#22c55e" };
      else if (avg >= 3.5) classificacao = { label: "Lucro Médio Alto", color: "#4ade80" };
      else if (avg >= 2.5) classificacao = { label: "Lucro Mediano", color: "#eab308" };
      else if (avg >= 1.5) classificacao = { label: "Lucro Médio Baixo", color: "#f97316" };
      else classificacao = { label: "Lucro Baixo", color: "#ef4444" };
    }
    const lucroLabel = classificacao.label.replace(/^Lucro\s*/i, "").trim() || "—";

    // Valores
    const valorTotal = allSD.reduce((sum, sd) => sum + sd.itemVendido, 0);
    const splitSD = allSD.filter(sd => sd.split);
    const splitCount = splitSD.length;
    const splitItemVendido = splitSD.reduce((sum, sd) => sum + sd.itemVendido, 0);
    const valorIndividual = splitCount > 0 ? Math.round(splitItemVendido / splitCount) : 0;

    // Tipo da Quest
    const questLabel = p.ptType === "sanguine" ? "SANGUINE" : p.ptType === "soulwar" ? "SOULWAR" : "QUEST";
    const questColor = p.ptType === "sanguine" ? "rose" : "slate";

    const isHighlighted = flashingId === p.id;

    // Lista de drops individualizada, com as informações persistidas em
    // slotData: item dropado + valor em RC. NÃO faz nenhuma validação
    // sobre "vendido/não vendido" — apenas consome o que foi gravado
    // quando a PT foi concluída. Se `itemVendido` for 0 ou ausente,
    // exibe "(Não informado)"; caso contrário, "(Vendido por X RC)".
    const dropsDetalhados = allSD
      .filter(sd => !!sd.itemDropado)
      .map(sd => ({
        item: sd.itemDropado,
        valor: typeof sd.itemVendido === "number" ? sd.itemVendido : 0,
      }));

    // ── PARTICIPANTES: personagem ↔ dono ↔ jogador ↔ mortes ↔ drop ────────
    // Une, POR SLOT, o que antes era exibido em listas independentes
    // ("Personagens", "Jogadores" e "Drop"), onde não havia como saber de
    // quem era cada drop nem quem jogou com qual personagem. O vínculo é o
    // próprio ID do membro: `slotData[id]` guarda dono/jogador/mortes/drop e
    // `memberSnapshots[id]` guarda o personagem.
    // Somente leitura de dados já persistidos — nada é recalculado.
    const participantes = memberIds.map((id, idx) => {
      const sd = sdMap[id];
      const ci = idx - selIds.length;
      const isCustom = ci >= 0 && ci < custs.length;
      const snap = p.memberSnapshots?.[id];

      // Personagem: snapshot para membros da lista; label para externos.
      const personagem = (isCustom ? custs[ci].label : snap?.personagem) || "";

      // Dono do personagem. `slotData.owner` é a fonte gravada na conclusão;
      // para membros EXTERNOS o `ownerName` informado no "+ Externo" serve de
      // reserva; o snapshot cobre PTs antigas sem esses campos.
      const dono = (sd?.owner || "").trim()
        || (isCustom ? (custs[ci].ownerName || "").trim() : "")
        || (snap?.ownerName || "").trim();

      // Jogador: quem de fato jogou o personagem — pode diferir do dono.
      // Para externos o label é o nome do personagem, então NÃO serve como
      // jogador; nesse caso o campo fica honestamente "não informado".
      const jogador = (sd?.player || "").trim();

      // Mortes DESTE personagem (não agregadas por jogador).
      const mortes = typeof sd?.deaths === "number" && sd.deaths > 0 ? sd.deaths : 0;

      const item = (sd?.itemDropado || "").trim();
      const valor = typeof sd?.itemVendido === "number" ? sd.itemVendido : 0;

      return {
        id,
        personagem,
        dono,
        jogador,
        mortes,
        item,
        valor,
        isService: !!sd?.isService || isCustom,
      };
    });

    const participantesResumo = participantes
      .map(m => {
        const partes = [m.personagem || "Personagem não informado"];
        partes.push(`Dono: ${m.dono || "não informado"}`);
        partes.push(`Jogador: ${m.jogador || "não informado"}`);
        partes.push(m.mortes > 0 ? `${m.mortes} morte${m.mortes !== 1 ? "s" : ""}` : "sem mortes");
        partes.push(m.item ? `${m.item}${m.valor > 0 ? ` (${formatRC(m.valor)})` : " (valor não informado)"}` : "sem drop");
        return partes.join(" · ");
      })
      .join("\n");

    // Total de mortes da PT — resume no cabeçalho o que antes era a linha
    // "Jogadores", agora detalhada por participante.
    const totalMortes = participantes.reduce((sum, m) => sum + m.mortes, 0);
    return (
      <div
        id={`archived_pt_${p.id}`}
        key={p.id}
        className={`flex items-stretch rounded-xl border transition-all duration-300 select-none overflow-hidden min-h-[70px] ${
          isHighlighted
            ? "border-amber-400 bg-amber-500/25 ring-2 ring-amber-400/60 shadow-[0_0_20px_color-mix(in_oklab,var(--color-amber-500)_35%,transparent)] animate-pulse"
            : "bg-[var(--th-bg-raised)] border-[var(--th-line)]/100 hover:border-[var(--th-line)]/45 shadow-md"
        }`}
      >
        {/* === CANTO ESQUERDO: Nome da PT + Quest === */}
        <div className="flex flex-col items-center justify-center px-4 min-w-[130px] flex-shrink-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <div className="w-2 h-2 rounded-full flex-shrink-0 bg-emerald-500 shadow-lg shadow-emerald-500/50" />
            <span className="text-sm font-bold text-white truncate tracking-wide max-w-[100px]">{p.name}</span>
          </div>
          <div className="flex items-center gap-1">
            <span className={`text-[8px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${
              questColor === "rose"
                ? "bg-rose-500/20 text-rose-300 border border-rose-500/80"
                : "bg-slate-500/20 text-slate-200 border border-slate-500/80"
            }`}>
              {questLabel}
            </span>
            {p.questFalha && (
              <span className="text-[8px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider bg-rose-500/20 text-rose-300 border border-rose-500/70">
                FALHOU
              </span>
            )}
          </div>
          {/* Servidor principal da PT (visualizado no canto esquerdo do card,
              abaixo do badge de Quest, seguindo o mesmo padrão visual dos
              demais rótulos informativos). */}
          <div
            className="mt-1 px-2 py-0.5 rounded bg-sky-500/10 border border-sky-500/30 text-sky-300 text-[8px] font-black uppercase tracking-wider max-w-[110px] truncate"
            title={`Servidor: ${getPartyMainServer(p)}`}
          >
            <span className="opacity-70 mr-0.5"></span>{getPartyMainServer(p)}
          </div>
        </div>

        {/* === BARRA DIVISORA ESQUERDA === */}
        <div className="w-px bg-white/10 flex-shrink-0" />

        {/* === ESPAÇO MAIOR DO MEIO: 2 linhas === */}
        <div className="flex-1 min-w-0 flex flex-col justify-center px-4 py-1.5 gap-1">
          {/* Linha superior (1): Líder, Concluída, Jogadores */}
          <div className="flex flex-wrap items-center gap-x-3 text-[10px] text-slate-400 min-w-0 leading-tight">
            <span className="flex items-center gap-0.5 whitespace-nowrap">
              <User size={9} className="text-emerald-400" />
              <span>Líder: <span className="text-slate-200 font-semibold">{p.LeaderPT || "Anônimo"}</span></span>
            </span>

            <span className="flex items-center gap-0.5 whitespace-nowrap">
              <Clock size={9} className={p.questFalha ? "text-rose-400" : "text-emerald-400"} />
              <span>{p.questFalha ? "Falhou em:" : "Concluída:"} <span className={p.questFalha ? "text-rose-300" : "text-emerald-300"}>{dataConclusao}</span>{duracaoQuest !== "—" && <> | <span className="text-sky-300">{duracaoQuest}</span></>}</span>
            </span>

            {/* Resumo de mortes da PT. O detalhe por jogador migrou para
                cada participante, onde o vínculo com o personagem é claro. */}
            <span className="flex items-center gap-0.5 whitespace-nowrap">
              <span>Mortes:</span>
              <span className={`font-black tabular-nums ${totalMortes > 0 ? "text-rose-400" : "text-emerald-400/80"}`}>
                {totalMortes > 0 ? totalMortes : "nenhuma"}
              </span>
            </span>
          </div>

          {/* Linha (intermediária): PARTICIPANTES.
              Cada bloco reúne, para o MESMO slot, personagem + dono +
              jogador + mortes + drop + valor — substituindo as antigas
              listas soltas de "Personagens", "Jogadores" e "Drop", que não
              permitiam saber de quem era cada item nem quem jogou com qual
              personagem. Somente dados persistidos; nada é recalculado. */}
          {participantes.length > 0 && (
            <div className="flex flex-col gap-0.5 min-w-0" title={participantesResumo}>
              <div className="flex items-center gap-0.5 text-[10px] text-slate-400 leading-tight">
                <Sword size={9} className="text-slate-400 flex-shrink-0" />
                <span>Participantes ({participantes.length}):</span>
                <span className="text-slate-500 text-[9px]">
                  {dropsDetalhados.length > 0 ? `${dropsDetalhados.length} com drop` : "nenhum drop registrado"}
                </span>
              </div>

              {/* Duas colunas no máximo: com três, nomes longos de
                  personagem/jogador truncavam cedo demais ao lado do drop. */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-2 gap-y-0.5 min-w-0">
                {participantes.map(m => (
                  <div
                    key={m.id}
                    className="flex items-baseline gap-1 min-w-0 rounded px-1 py-px bg-white/[0.03] border border-white/5 leading-tight"
                  >
                    {/* Personagem · Dono · Jogador · Mortes */}
                    <span className="min-w-0 truncate text-[10px]">
                      <span className="font-semibold text-slate-200">
                        {m.personagem || <span className="italic text-slate-500 font-normal">Personagem —</span>}
                      </span>
                      {m.isService && (
                        <span className="ml-1 text-[8px] font-black uppercase tracking-wide text-violet-300/80">svc</span>
                      )}
                      {/* Dono do personagem */}
                      <span className="text-slate-600 mx-1">·</span>
                      <span className="text-[9px] text-slate-500">D:</span>{" "}
                      {m.dono ? (
                        <span className="text-amber-300/90">{m.dono}</span>
                      ) : (
                        <span className="italic text-slate-500">—</span>
                      )}
                      {/* Quem jogou */}
                      <span className="text-slate-600 mx-1">·</span>
                      <span className="text-[9px] text-slate-500">J:</span>{" "}
                      {m.jogador ? (
                        <span className="text-sky-300/90">{m.jogador}</span>
                      ) : (
                        <span className="italic text-slate-500">—</span>
                      )}
                      {/* Mortes do personagem — só aparecem quando existem */}
                      {m.mortes > 0 && (
                        <span className="ml-1 text-[9px] font-black tabular-nums text-rose-400" title={`${m.mortes} morte${m.mortes !== 1 ? "s" : ""}`}>
                          ☠{m.mortes}
                        </span>
                      )}
                    </span>

                    {/* Drop + Valor do PRÓPRIO participante */}
                    <span className="ml-auto flex items-baseline gap-1 flex-shrink-0 text-[9px] whitespace-nowrap">
                      {m.item ? (
                        <>
                          <span className="font-semibold" style={{ color: ITEM_COLORS[m.item] || "#cbd5e1" }}>
                            {m.item}
                          </span>
                          <span className={m.valor > 0 ? "font-mono font-bold text-emerald-400" : "italic text-slate-500"}>
                            {m.valor > 0 ? formatRC(m.valor) : "valor —"}
                          </span>
                        </>
                      ) : (
                        <span className="italic text-slate-600">sem drop</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* === BARRA DIVISORA DIREITA === */}
        <div className="w-px bg-white/10 flex-shrink-0" />

        {/* === CANTO DIREITO: Lucro + Total + Indiv === */}
        <div className="flex items-center px-3 gap-2 min-w-[260px] flex-shrink-0 bg-black/15">
          {/* Média Lucro */}
          <div
            className="flex-1 flex flex-col justify-center items-center h-10 rounded border px-2 text-[10px] font-semibold text-center leading-none"
            style={{
              color: classificacao.color,
              borderColor: classificacao.color + "33",
              backgroundColor: classificacao.color + "0D",
            }}
            title={classificacao.label}
          >
            <span className="text-[8px] uppercase opacity-60 mb-0.5 tracking-wider"><Award size={10} className="inline mr-0.5" />Lucro</span>
            <span className="font-bold truncate">{lucroLabel}</span>
          </div>

          {/* Total */}
          <div className="flex-1 flex flex-col justify-center items-center h-10 rounded bg-[var(--th-bg-base)] border border-[var(--th-line)]/80 text-[10px] leading-none text-center font-mono">
            <span className="text-[8px] uppercase text-slate-500 font-sans mb-0.5 tracking-wider"><Coins size={9} className="inline mr-0.5 text-emerald-400" />Total</span>
            <span className="font-bold text-emerald-400 truncate">{formatRC(valorTotal)}</span>
          </div>

          {/* Indiv */}
          <div className="flex-1 flex flex-col justify-center items-center h-10 rounded bg-emerald-500/10 border border-emerald-500/30 text-[10px] leading-none text-center font-mono">
            <span className="text-[8px] uppercase text-emerald-400 font-sans mb-0.5 tracking-wider font-semibold">Indiv</span>
            <span className="font-bold text-emerald-300 truncate">{formatRC(valorIndividual)}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-[var(--th-bg-base)] text-sm p-1.5 sm:p-2 gap-2 sm:gap-3">
      {/* Barra de controles (ordenação, filtro de servidor e Minhas PT's) */}
      <div className="flex items-center justify-between px-1.5 sm:px-2 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border border-[var(--th-brand)]/100 rounded-xl flex-shrink-0 overflow-x-auto" style={{ minHeight: "clamp(34px, 4.5vh, 46px)", padding: "clamp(4px, 0.6vh, 6px) clamp(6px, 1vw, 8px)" }}>
        <div className="flex items-center gap-1 sm:gap-2">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[var(--th-bg-base)] border border-[var(--th-line)]/100">
            <Archive size={13} className="text-amber-500" />
            <span className="text-xs font-bold text-amber-300 uppercase tracking-wider whitespace-nowrap">Histórico de PT's</span>
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">{sortedParties.length}</span>
          </div>

          <div className="relative flex items-center gap-0.5 bg-[var(--th-bg-base)] p-0.5 rounded-lg border border-[var(--th-line)]/100">
            <button
              type="button"
              onClick={() => toggleSort("date")}
              className={`rounded-md font-bold border transition-all cursor-pointer whitespace-nowrap ${
                sortKey === "date"
                  ? "bg-sky-500/15 border-sky-500/40 text-sky-300"
                  : "bg-white/[0.03] border-white/5 text-slate-400 hover:text-white hover:bg-white/5"
              }`} style={{ padding: "clamp(3px, 0.5vh, 6px) clamp(6px, 1vw, 8px)", fontSize: "clamp(8px, 1.3vh, 10px)" }}
              title="Ordenar por data"
            >
              <span className="hidden sm:inline">Data</span><span className="sm:hidden">Dt</span> {sortKey === "date" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
            </button>

            <button
              type="button"
              onClick={() => toggleSort("profit")}
              className={`rounded-md font-bold border transition-all cursor-pointer whitespace-nowrap ${
                sortKey === "profit"
                  ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                  : "bg-white/[0.03] border-white/5 text-slate-400 hover:text-white hover:bg-white/5"
              }`} style={{ padding: "clamp(3px, 0.5vh, 6px) clamp(6px, 1vw, 8px)", fontSize: "clamp(8px, 1.3vh, 10px)" }}
              title="Ordenar por lucro total"
            >
              <span className="hidden sm:inline">Lucro Total</span><span className="sm:hidden">Lucro</span> {sortKey === "profit" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
            </button>

            <FilterSelect
              label="Filtrar por servidor"
              options={serverOptions}
              selected={serverFilter}
              onSelect={setServerFilter}
              searchable
              placeholder="Filtrar Servidor"
            />

            <FilterSelect
              label="Personagens"
              options={characterOptions}
              selected={characterFilter}
              onSelect={setCharacterFilter}
              searchable
              searchPlaceholder="Buscar personagem..."
              allLabel="Todos"
              placeholder="Filtrar Usuários"
            />

            <FilterSelect
              label="Filtrar personagem por nome"
              options={charNameOptions}
              selected={charNameFilter}
              onSelect={setCharNameFilter}
              searchable
              searchPlaceholder="Buscar personagem..."
              allLabel="Todos"
              placeholder="Filtrar Personagem"
            />
          </div>

          {/* Filtro "Minhas PT's" — visível apenas para Boss */}
          {isBoss && (
            <button
              type="button"
              onClick={() => setOnlyMine(prev => !prev)}
              title="Mostra apenas as PT's em que o usuário logado participou, seja como líder, membro ou participante da slot data."
              aria-label="Filtrar apenas minhas PT's"
              className={`group px-3.5 py-1.5 text-xs font-bold rounded-full border transition-all cursor-pointer flex items-center gap-2 shadow-sm ${
                effectiveOnlyMine
                  ? "bg-gradient-to-r from-violet-600 to-fuchsia-600 border-violet-400/50 text-white shadow-md shadow-violet-600/25 ring-1 ring-violet-400/20"
                  : "bg-white/[0.03] border-white/30 text-slate-400 hover:text-white hover:bg-white/5 hover:border-violet-500/30 hover:shadow-violet-500/10 hover:shadow-md"
              }`}
            >
              <span className={`flex items-center justify-center w-5 h-5 rounded-full border ${effectiveOnlyMine ? "bg-black/15 border-white/15" : "bg-white/5 border-white/10"}`}>
                <User size={10} className={effectiveOnlyMine ? "text-white" : "text-violet-300"} />
              </span>
              <span className="flex items-center gap-1 whitespace-nowrap">
                Minhas PT's
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full uppercase tracking-wider ${effectiveOnlyMine ? "bg-black/15 text-white/90" : "bg-white/5 text-slate-500"}`}>
                  {effectiveOnlyMine ? "Ativo" : "Filtro"}
                </span>
              </span>
            </button>
          )}
        </div>

        <span className="text-[10px] text-slate-500 font-medium">
          Salvo permanentemente no histórico
        </span>
      </div>

      {/* Lista de PT's arquivadas */}
      <div className="flex-1 min-h-0 overflow-y-auto pr-1">
        <div className="flex flex-col gap-3">
          {sortedParties.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-500 gap-3">
              <Archive size={36} className="opacity-30" />
              <span className="italic">Nenhuma PT finalizada no histórico</span>
            </div>
          ) : (
            sortedParties.map(p => renderCard(p))
          )}
        </div>
      </div>
    </div>
  );
}