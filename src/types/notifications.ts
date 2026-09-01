export interface Notification {
  id: string
  type: "pt_added" | "pt_reminder" | "update_available" | "payment_received" | "schedule_changed" | "quest_completed_donation" | "request_entry" | "rate_limit_block" | "pt_updated" | "vip_approved" | "bazaar_interest_ending" | "bazaar_daily_available" | "service_request" | "service_waiting" | "party_finalized"
  title: string
  body: string
  status: "pending" | "done"
  createdAt: number
  partyId?: string
  partyName?: string
  /** Id do documento da Lista de Espera (notificações de service "Qualquer um"). */
  serviceId?: string
  questType?: "soulwar" | "sanguine"
  scheduledTime?: number
  addedBy?: string
  paidBy?: string
  paidAmount?: number
  paidAmountFormatted?: string
  changedBy?: string
  read?: boolean
  ignored?: boolean
  ignoredAt?: number
  ignoredBy?: string
  userId?: string
  targetRole?: string
  action?: "install_update"
  actionLabel?: string
  updateVersion?: string
  participantCharIds?: string[]
  participantSlotData?: Record<string, { itemDropado: string; split: boolean; itemVendido: number }>
  splitValue?: number
  attCharsDone?: boolean
  attCharsDoneAt?: number
  vipDays?: number
  auctionId?: string
  bazaarVersion?: string
  url?: string
}