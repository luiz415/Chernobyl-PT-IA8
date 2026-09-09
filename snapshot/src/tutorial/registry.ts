// ============================================================================
// TUTORIAL — REGISTRO DE TÓPICOS
// ----------------------------------------------------------------------------
// Ponto único de agregação: para adicionar um painel novo ao tutorial, crie o
// arquivo do tópico em src/tutorial/topics/ e acrescente-o ao array ALL_TOPICS
// abaixo — nada mais precisa mudar (menu, progresso e navegação são genéricos).
//
// A ordem do array é a ordem exibida no menu e percorrida pelo
// "Tutorial Completo". Tópicos com `bossOnly` só aparecem para o papel Boss.
// ============================================================================
import type { TourTopic } from "./types";
import primeirosPassos from "./topics/primeirosPassos";
import meusPersonagens from "./topics/meusPersonagens";
import gerenciadorPts from "./topics/gerenciadorPts";
import painelPt from "./topics/painelPt";
import meusServices from "./topics/meusServices";
import servicesFila from "./topics/servicesFila";
import meuHistorico from "./topics/meuHistorico";
import bazaar from "./topics/bazaar";
import stats from "./topics/stats";
import ranking from "./topics/ranking";
import notas from "./topics/notas";
import vipDoacoes from "./topics/vipDoacoes";
import utilitarios from "./topics/utilitarios";

const ALL_TOPICS: TourTopic[] = [
  primeirosPassos,
  meusPersonagens,
  gerenciadorPts,
  painelPt,
  meusServices,
  servicesFila,
  meuHistorico,
  bazaar,
  stats,
  ranking,
  notas,
  vipDoacoes,
  utilitarios,
];

export function getTourTopics(isBoss: boolean): TourTopic[] {
  return ALL_TOPICS.filter(t => !t.bossOnly || isBoss);
}

/**
 * Verificador de conformidade (apenas DEV): loga cenas cujo anchor não existe
 * no DOM atual. Não substitui o fallback em runtime — serve para detectar
 * anchors órfãos cedo, durante o desenvolvimento.
 */
export function auditTourAnchors(): void {
  if (!import.meta.env.DEV) return;
  const missing: string[] = [];
  ALL_TOPICS.forEach(topic => topic.scenes.forEach(scene => {
    if (scene.anchor && !document.querySelector(`[data-tour="${scene.anchor}"]`)) {
      missing.push(`${topic.id}/${scene.id} → [data-tour="${scene.anchor}"]`);
    }
  }));
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.info("[tutorial] anchors ausentes no DOM atual (podem ser condicionais):\n" + missing.join("\n"));
  }
}
