export type VipPlanId = "plan30" | "plan90";

export interface VipPlanConfig {
  id: VipPlanId;
  label: string;
  durationDays: number;
  priceRc: number;
}

export type VipPlansConfig = Record<VipPlanId, VipPlanConfig>;

export const DEFAULT_VIP_PLANS: VipPlansConfig = {
  plan30: {
    id: "plan30",
    label: "Plano 30 dias",
    durationDays: 30,
    priceRc: 100,
  },
  plan90: {
    id: "plan90",
    label: "Plano 90 dias",
    durationDays: 90,
    priceRc: 250,
  },
};

export function normalizeVipPlans(data: any): VipPlansConfig {
  const plans = data?.plans || data || {};
  const normalizePlan = (id: VipPlanId): VipPlanConfig => {
    const fallback = DEFAULT_VIP_PLANS[id];
    const source = plans[id] || {};
    const durationDays = Number(source.durationDays);
    const priceRc = Number(source.priceRc);
    return {
      id,
      label: typeof source.label === "string" && source.label.trim() ? source.label : fallback.label,
      durationDays: Number.isInteger(durationDays) && durationDays >= 30 && durationDays % 30 === 0
        ? durationDays
        : fallback.durationDays,
      priceRc: Number.isInteger(priceRc) && priceRc >= 0 ? priceRc : fallback.priceRc,
    };
  };

  return {
    plan30: normalizePlan("plan30"),
    plan90: normalizePlan("plan90"),
  };
}