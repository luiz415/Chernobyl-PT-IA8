import { ITEM_COLORS } from "../components/CharTable";

/**
 * Classificação de lucro da PT a partir dos itens DROPADOS pelos seus
 * personagens — a MESMA regra do rodapé do PartyPanel, extraída 1:1
 * para um único ponto de verdade:
 *
 *   score por item (pela cor oficial do mapa ITEM_COLORS):
 *     #22c55e ou #fbbf24 → 5    (tier top: verdes-base e sanguine grand)
 *     #4ade80 #86efac #a3e635 → 4
 *     #eab308 → 3
 *     #f97316 → 2
 *     demais (inclui itens fora do mapa) → 1
 *   avg = soma ÷ itens dropados:
 *     ≥ 4.5 "Lucro Alto"        #22c55e
 *     ≥ 3.5 "Lucro Médio Alto"  #4ade80
 *     ≥ 2.5 "Lucro Mediano"     #eab308
 *     ≥ 1.5 "Lucro Médio Baixo" #f97316
 *     senão   "Lucro Baixo"     #ef4444
 *   Sem nenhum drop → { label: "—", color: "#64748b" }.
 *
 * PartyPanel.dropClassification e o resumo do histórico privado chamam ESTA
 * função — nunca recriar a tabela de scores/thresholds em outro lugar.
 */
export interface ProfitClassification {
  label: string;
  color: string;
}

export function classifyDroppedItems(droppedItems: ReadonlyArray<string | undefined | null>): ProfitClassification {
  const items = (droppedItems || []).filter((item): item is string => !!item);
  if (items.length === 0) return { label: "—", color: "#64748b" };

  let totalScore = 0;
  items.forEach(item => {
    const col = ITEM_COLORS[item];
    if (col === "#22c55e" || col === "#fbbf24") totalScore += 5;
    else if (col === "#4ade80" || col === "#86efac" || col === "#a3e635") totalScore += 4;
    else if (col === "#eab308") totalScore += 3;
    else if (col === "#f97316") totalScore += 2;
    else totalScore += 1;
  });

  const avg = totalScore / items.length;
  if (avg >= 4.5) return { label: "Lucro Alto", color: "#22c55e" };
  if (avg >= 3.5) return { label: "Lucro Médio Alto", color: "#4ade80" };
  if (avg >= 2.5) return { label: "Lucro Mediano", color: "#eab308" };
  if (avg >= 1.5) return { label: "Lucro Médio Baixo", color: "#f97316" };
  return { label: "Lucro Baixo", color: "#ef4444" };
}