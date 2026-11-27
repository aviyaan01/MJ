import type { BudgetSettings, BudgetStatusSummary, TokenUsage } from './types.js';

/**
 * Default illustrative token & audio pricing (verify current rates at console.x.ai).
 * Users can override these rates in Settings -> Usage.
 */
export const DEFAULT_BUDGET_SETTINGS: BudgetSettings = {
  dailyCapUsd: 2.0,
  softCapUsd: 10,
  hardCapUsd: 25,
  inputRatePerMillionUsd: 2.0,
  outputRatePerMillionUsd: 6.0,
  cachedInputRatePerMillionUsd: 0.5,
  voiceRatePerMinuteUsd: 0.05,
  ttsRatePerMillionCharsUsd: 15.0,
  sttRatePerHourUsd: 0.1,
};

export function estimateResponseCostUsd(
  usage: Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'cachedTokens'>,
  rates: Pick<
    BudgetSettings,
    'inputRatePerMillionUsd' | 'outputRatePerMillionUsd' | 'cachedInputRatePerMillionUsd'
  >,
): number {
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedTokens);
  const inputCost = (uncachedInput / 1_000_000) * rates.inputRatePerMillionUsd;
  const cachedCost = (usage.cachedTokens / 1_000_000) * rates.cachedInputRatePerMillionUsd;
  const outputCost = (usage.outputTokens / 1_000_000) * rates.outputRatePerMillionUsd;
  return Number((inputCost + cachedCost + outputCost).toFixed(6));
}

export function estimateVoiceDurationCostUsd(
  durationSeconds: number,
  voiceRatePerMinuteUsd: number,
): number {
  const minutes = Math.max(0, durationSeconds) / 60;
  return Number((minutes * voiceRatePerMinuteUsd).toFixed(6));
}

export function estimateTtsCostUsd(
  characterCount: number,
  ttsRatePerMillionCharsUsd: number,
): number {
  return Number(((Math.max(0, characterCount) / 1_000_000) * ttsRatePerMillionCharsUsd).toFixed(6));
}

export function estimateSttCostUsd(
  durationSeconds: number,
  sttRatePerHourUsd: number,
): number {
  const hours = Math.max(0, durationSeconds) / 3600;
  return Number((hours * sttRatePerHourUsd).toFixed(6));
}

export function evaluateBudgetStatus(
  monthlySpendUsd: number,
  dailySpendUsd: number,
  budget: BudgetSettings,
): BudgetStatusSummary {
  let level: BudgetStatusSummary['level'] = 'ok';
  if (budget.hardCapUsd > 0 && monthlySpendUsd >= budget.hardCapUsd) {
    level = 'hard_cap_reached';
  } else if (budget.softCapUsd > 0 && monthlySpendUsd >= budget.softCapUsd) {
    level = 'soft_cap_warning';
  }

  const dailyCapUsd = budget.dailyCapUsd ?? 0;
  const dailyLevel: BudgetStatusSummary['dailyLevel'] =
    dailyCapUsd > 0 && dailySpendUsd >= dailyCapUsd ? 'daily_cap_exceeded' : 'ok';

  const roundedMonth = Number(monthlySpendUsd.toFixed(6));
  const roundedDay = Number(dailySpendUsd.toFixed(6));

  const percentOfDailyCap =
    dailyCapUsd > 0
      ? Number(Math.min(999, (dailySpendUsd / dailyCapUsd) * 100).toFixed(1))
      : null;
  const remainingDailyCapUsd =
    dailyCapUsd > 0 ? Number(Math.max(0, dailyCapUsd - dailySpendUsd).toFixed(6)) : null;

  const percentOfSoftCap =
    budget.softCapUsd > 0
      ? Number(Math.min(999, (monthlySpendUsd / budget.softCapUsd) * 100).toFixed(1))
      : null;
  const percentOfHardCap =
    budget.hardCapUsd > 0
      ? Number(Math.min(999, (monthlySpendUsd / budget.hardCapUsd) * 100).toFixed(1))
      : null;

  const remainingSoftCapUsd =
    budget.softCapUsd > 0 ? Number(Math.max(0, budget.softCapUsd - monthlySpendUsd).toFixed(6)) : null;
  const remainingHardCapUsd =
    budget.hardCapUsd > 0 ? Number(Math.max(0, budget.hardCapUsd - monthlySpendUsd).toFixed(6)) : null;

  return {
    level,
    dailyLevel,
    monthlySpendUsd: roundedMonth,
    dailySpendUsd: roundedDay,
    dailyCapUsd,
    softCapUsd: budget.softCapUsd,
    hardCapUsd: budget.hardCapUsd,
    percentOfDailyCap,
    remainingDailyCapUsd,
    percentOfSoftCap,
    percentOfHardCap,
    remainingSoftCapUsd,
    remainingHardCapUsd,
  };
}
