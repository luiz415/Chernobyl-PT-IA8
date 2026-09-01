/**
 * serviceVisibility.ts
 * --------------------
 * Módulo de domínio puro para a visibilidade dos personagens de Service
 * (Lista de Espera / WaitingListPanel / ServiceList).
 *
 * FUNÇÃO PURA — sem dependências de React, AuthContext ou Firebase.
 *
 * REGRA:
 *   1. Boss enxerga todos os services.
 *   2. Se o cliente escolheu um Serviceiro específico (campo `addedBy`),
 *      apenas esse usuário enxerga o personagem.
 *   3. Se ficou "Qualquer um" (ou vazio), o personagem é visível para todos.
 *
 * O Serviceiro designado é gravado por NOME em `addedBy` — mesmo critério já
 * usado por canEditService, canAddServiceToPT e canViewServiceWhats. Este
 * módulo centraliza a comparação para não repetir a regra em cada tela.
 */

import { ANY_SERVICEIRO_LABEL } from "../hooks/useEligibleServiceiros";

/** Mínimo necessário de um service para decidir a visibilidade. */
export interface ServiceVisibilityEntity {
  /** Nome do Serviceiro designado ("Qualquer um" quando livre). */
  addedBy?: string;
}

/**
 * Indica se o service está liberado para qualquer usuário, isto é, quando
 * nenhum Serviceiro específico foi escolhido.
 */
export function isServiceOpenToAnyone(item: ServiceVisibilityEntity): boolean {
  const assigned = (item.addedBy || "").trim();
  return !assigned || assigned.toLowerCase() === ANY_SERVICEIRO_LABEL.toLowerCase();
}

/**
 * Decide se o usuário atual pode VER o personagem de service na lista.
 *
 * @param item        service avaliado
 * @param viewerName  nome do usuário logado
 * @param isBoss      true quando o usuário tem papel Boss
 */
export function canViewServiceEntry(
  item: ServiceVisibilityEntity,
  viewerName: string,
  isBoss: boolean
): boolean {
  if (isBoss) return true;
  if (isServiceOpenToAnyone(item)) return true;
  const assigned = (item.addedBy || "").trim().toLowerCase();
  return assigned === (viewerName || "").trim().toLowerCase();
}

// ============================================================================
// VISIBILIDADE POR AMIZADE E PROJEÇÃO SEGURA
// ----------------------------------------------------------------------------
// Regras acrescentadas na reestruturação dos Services:
//
//   • "Qualquer um"  -> visível a qualquer usuário aprovado.
//   • Serviceiro específico -> visível ao próprio dono, ao Boss e aos AMIGOS
//     do dono. Quem não é amigo não enxerga o personagem.
//
// O WhatsApp nunca vai para quem não é dono nem Boss: `projectServiceForViewer`
// remove os campos antes de entregar aos componentes.
// ============================================================================

/** Campos privados que não podem vazar para terceiros. */
export interface ServicePrivateFields {
  whatsappCountry?: string;
  whatsappArea?: string;
  whatsappNumber?: string;
}

export interface ServiceOwnership extends ServiceVisibilityEntity, ServicePrivateFields {
  /** UID do Serviceiro dono (quando o service veio de sharedServices). */
  serviceiroUid?: string;
}

export interface ServiceViewerContext {
  /** UID do usuário logado. */
  viewerUid: string;
  /** Nome do usuário logado (usado pela regra legada por nome). */
  viewerName: string;
  isBoss: boolean;
  /** UIDs de amigos aceitos — vem do AuthContext, sem regra paralela. */
  friendUids: Set<string> | string[];
}

function toSet(value: Set<string> | string[]): Set<string> {
  return value instanceof Set ? value : new Set(value);
}

/** true quando o usuário é o dono do service. */
export function isServiceOwner(item: ServiceOwnership, viewer: ServiceViewerContext): boolean {
  const ownerUid = (item.serviceiroUid || "").trim();
  if (ownerUid && viewer.viewerUid) return ownerUid === viewer.viewerUid;
  // Registros legados não têm UID: cai na comparação por nome.
  const assigned = (item.addedBy || "").trim().toLowerCase();
  return !!assigned && assigned === (viewer.viewerName || "").trim().toLowerCase();
}

/**
 * Decide se o usuário pode VER o service na ServiceList.
 *
 * Substitui `canViewServiceEntry` nos fluxos que têm contexto de amizade;
 * a função antiga continua válida onde só existe o nome do visualizador.
 */
export function canViewServiceForViewer(item: ServiceOwnership, viewer: ServiceViewerContext): boolean {
  if (viewer.isBoss) return true;
  // Sem Serviceiro designado: aberto a todos os aprovados.
  if (isServiceOpenToAnyone(item)) return true;
  if (isServiceOwner(item, viewer)) return true;
  // Amigos do dono também enxergam.
  const ownerUid = (item.serviceiroUid || "").trim();
  if (!ownerUid) return false;
  return toSet(viewer.friendUids).has(ownerUid);
}

/** Só o dono e o Boss enxergam WhatsApp e demais dados pessoais. */
export function canViewServicePrivateData(item: ServiceOwnership, viewer: ServiceViewerContext): boolean {
  return viewer.isBoss || isServiceOwner(item, viewer);
}

/**
 * Projeção segura: devolve o service SEM os campos privados quando o
 * visualizador não tem direito a eles.
 *
 * Aplicada antes de os dados chegarem aos componentes, de modo que o
 * WhatsApp sequer existe em memória para terceiros — não basta escondê-lo
 * no JSX.
 */
export function projectServiceForViewer<T extends ServiceOwnership>(item: T, viewer: ServiceViewerContext): T {
  if (canViewServicePrivateData(item, viewer)) return item;
  return { ...item, whatsappCountry: "", whatsappArea: "", whatsappNumber: "" };
}
