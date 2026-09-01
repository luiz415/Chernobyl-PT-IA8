import { useEffect, useMemo, useRef, useState } from "react";
import { readOfficialBazaarCache, readBazaarInterestsCache } from "../services/bazaarOfficialService";
import { buildBazaarBidUrl } from "../utils/bazaarBid";
import type { AutoBidMode, AutoBidRecord } from "../autoBid/types";
import {
  addHistory,
  executionKey,
  isExecuted,
  loadBrowser,
  loadConfigs,
  loadMode,
  markExecuted,
  mergeWithOfficial,
  saveConfigs,
} from "../autoBid/store";
import { dueItems } from "../autoBid/scheduler";
import { executeBid, isBrowserOpen, isElectronRuntime, onConnection, sessionState } from "../autoBid/ipc";
import { bumpConfigsRevision, bumpHistoryRevision, setAutoBidConnection, useAutoBidStore } from "../autoBid/engineStore";

// ============================================================================
// AUTO BID — engine (sempre montado, roda em segundo plano)
// ----------------------------------------------------------------------------
// Independente do AutoBidModal: o agendamento e a execução dos lances NÃO
// dependem de o modal estar aberto. O engine:
//   • lê do localStorage a lista oficial (cache), os interesses (cache), os
//     configs, o modo e o navegador;
//   • acompanha o relógio e, no momento configurado, executa o Bid pelo modo
//     selecionado (CDP);
//   • detecta conectado/desconectado/expirado por polling da sessão;
//   • registra resultados no histórico e no ledger (anti-duplicado).
//
// Roda apenas no Electron (nunca na Web) e é seguro por idempotência:
// `dueItems` + ledger + executor serial garantem que um lance não é repetido.
// ============================================================================

interface Props {
  currentUserUid: string | null;
}

export default function AutoBidEngine({ currentUserUid }: Props) {
  const isElectron = isElectronRuntime();
  const store = useAutoBidStore();
  const inFlightRef = useRef<Set<string>>(new Set());
  // Relógio do agendamento (independente de revisões de configs).
  const [nowMs, setNowMs] = useState(() => Date.now());

  const mode: AutoBidMode = (loadMode() as AutoBidMode) || "cdp";
  const browser = loadBrowser();

  // ── Fonte de dados (localStorage — mesma fonte do modal/Bazaar) ─────────
  const data = useMemo(() => {
    if (!currentUserUid || !isElectron) return { official: [], interests: {} as Record<string, any[]>, version: "" };
    const cache = readOfficialBazaarCache();
    const characters = cache?.characters?.length ? cache.characters : [];
    const interests = readBazaarInterestsCache(cache?.version)?.interests || {};
    return { official: characters, interests, version: cache?.version || "" };
  }, [currentUserUid, isElectron, store.configsRevision]);

  // Personagens com interesse do usuário atual e leilão ativo.
  const official = useMemo(() => {
    const interested = new Set<string>();
    Object.entries(data.interests).forEach(([key, users]) => {
      if ((users || []).some(u => u.uid === currentUserUid)) interested.add(String(key));
    });
    return data.official
      .filter(c => c.id && c.auctionEndTs && interested.has(String(c.id)))
      .map(c => ({ id: String(c.id), name: c.name || "", server: c.server || "", vocation: c.vocation || "", url: c.url || "", auctionEndTs: c.auctionEndTs ?? null }));
  }, [data, currentUserUid]);

  const configs = useMemo(() => {
    if (!official.length) return [];
    const merged = mergeWithOfficial(loadConfigs(), official, data.version);
    // Persiste só se mudou (mergeWithOfficial já persiste; mantemos consistência).
    return merged;
  }, [official, data.version]);

  // ── Relógio (1s) — reavalia o agendamento a cada segundo ────────────────
  useEffect(() => {
    if (!isElectron) return;
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [isElectron]);

  // ── Monitoramento de sessão SOB DEMANDA ─────────────────────────────────
  // Só verifica a sessão quando existe navegador do Auto Bid aberto/conectado
  // (ou conexão em preparação — que o processo principal já sinaliza). Um Auto
  // Bid só consegue executar com o navegador/sessão abertos, então não faz
  // sentido consultar cookies/DOM/CDP com o navegador fechado — mesmo que haja
  // um config ativo persistido, ele não pode disparar sem navegador.
  // Com o navegador fechado: NENHUMA chamada de sessão é feita — sem consultar
  // cookies/DOM/CDP, sem enviar "Desconectado" repetidamente e sem os logs
  // repetitivos. Ao abrir o navegador, o polling inicia automaticamente; ao
  // fechar, para imediatamente. A checagem usa `isBrowserOpen` (sinal leve, não
  // lê cookies/DOM e não gera log). Timers são criados/derrubados aqui, sem
  // duplicatas ou listeners órfãos (cleanup cobre os dois timers).
  useEffect(() => {
    if (!isElectron) return;

    let running = false;
    let sessionTimer: number | null = null;
    let evalTimer: number | null = null;
    let disposed = false;

    const stopSessionPolling = () => {
      running = false;
      if (sessionTimer !== null) {
        window.clearInterval(sessionTimer);
        sessionTimer = null;
      }
    };

    const startSessionPolling = () => {
      if (running || disposed) return;
      running = true;
      const check = () => {
        sessionState(mode, browser).then(state => {
          if (!state) return;
          if (state.status === "validada") setAutoBidConnection("conectado", "");
          else if (state.status === "expirada") setAutoBidConnection("expirada", "Sessão expirada.");
          else setAutoBidConnection("desconectado", "");
        }).catch(() => {});
      };
      check();
      sessionTimer = window.setInterval(check, 2000);
    };

    const evaluate = async () => {
      if (disposed) return;
      const browserOpen = await isBrowserOpen(mode, browser);
      if (disposed) return;
      // Só monitora a sessão se houver navegador aberto/conectado. Fechado →
      // nenhuma verificação de sessão.
      if (browserOpen) startSessionPolling();
      else stopSessionPolling();
    };

    void evaluate();
    evalTimer = window.setInterval(evaluate, 2000);

    return () => {
      disposed = true;
      stopSessionPolling();
      if (evalTimer !== null) window.clearInterval(evalTimer);
    };
  }, [isElectron, mode, browser]);

  // ── Eventos de conexão vindos do processo principal ─────────────────────
  useEffect(() => {
    if (!isElectron) return;
    const unsubscribe = onConnection((event: any) => {
      if (event?.state) setAutoBidConnection(event.state, event.detail || "");
    });
    return unsubscribe;
  }, [isElectron]);

  // ── Execução dos lances devidos (independente do modal) ─────────────────
  useEffect(() => {
    if (!isElectron) return;
    if (store.connection !== "conectado") return;
    if (!currentUserUid) return;

    const due = dueItems(configs, nowMs).filter(c => !inFlightRef.current.has(c.auctionId));
    if (due.length === 0) return;

    const run = async () => {
      for (const config of due) {
        if (inFlightRef.current.has(config.auctionId)) continue;
        if (isExecuted(executionKey(config))) continue;

        // Revalida do localStorage imediatamente antes de executar: garante que
        // um cancelamento/desativação feito a qualquer momento impeça o Bid,
        // mesmo se a config em memória estiver defasada.
        const fresh = loadConfigs().find(c => c.auctionId === config.auctionId);
        if (!fresh || fresh.active !== true) {
          continue;
        }

        inFlightRef.current.add(config.auctionId);
        try {
          const bidUrl = buildBazaarBidUrl(config.url, config.auctionId, String(config.bidAmount));
          const result = await executeBid({
            mode,
            browser,
            bidUrl: bidUrl || "",
            auctionId: config.auctionId,
            auctionEndTs: config.auctionEndTs,
          });

          const record: AutoBidRecord = {
            auctionId: config.auctionId,
            name: config.name,
            server: config.server,
            bidAmount: config.bidAmount,
            atMs: Date.now(),
            status: "falhou",
            browser,
            detail: "",
          };

          if (result?.ok && (result.status === "concluido" || result.deduplicated)) {
            markExecuted(executionKey(config));
            record.status = "concluido";
            record.detail = result.detail || "Submit Bid confirmado";
            // Atualiza config no localStorage.
            const next = loadConfigs().map(c => c.auctionId === config.auctionId
              ? { ...c, executedAtMs: Date.now(), lastResult: record.detail }
              : c);
            saveConfigs(next);
            bumpConfigsRevision();
          } else if (result && result.status === "desconectado") {
            record.status = "desconectado";
            record.detail = result.detail || "Sessão perdida durante o lance";
            setAutoBidConnection("desconectado", record.detail);
          } else if (result) {
            record.status = "falhou";
            record.detail = result.detail || "Falha na execução";
            const next = loadConfigs().map(c => c.auctionId === config.auctionId
              ? { ...c, lastResult: record.detail }
              : c);
            saveConfigs(next);
            bumpConfigsRevision();
          }
          addHistory(record);
          bumpHistoryRevision();
        } finally {
          inFlightRef.current.delete(config.auctionId);
        }
      }
    };
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isElectron, store.connection, configs, mode, browser, currentUserUid, nowMs]);

  // Renderiza nada (é um motor em segundo plano).
  return null;
}