import type { BudgetSettings, BudgetStatusSummary, TokenUsage } from './types.js';

/**
 * Default illustrative token & audio pricing (verify current rates at console.x.ai).
 * Users can override these rates in Settings -> Usage.
 */
export const DEFAULT_BUDGET_SETTINGS: BudgetSettings = {
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

  return {
    level,
    monthlySpendUsd: Number(monthlySpendUsd.toFixed(6)),
    dailySpendUsd: Number(dailySpendUsd.toFixed(6)),
    softCapUsd: budget.softCapUsd,
    hardCapUsd: budget.hardCapUsd,
  };
}
