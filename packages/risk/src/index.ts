export interface RiskProfile {
  maxPositionSizeUsd: number;
  maxDailyLossUsd: number;
  maxDrawdownPct: number;
  maxOpenTrades: number;
  cooldownMinutesAfterLoss: number;
}

export interface ProposedTrade {
  positionSizeUsd: number;
}

export interface AccountState {
  openTradesCount: number;
  dailyLossUsd: number;
  currentDrawdownPct: number;
  lastLossAt: Date | null;
}

export interface RiskResult {
  approved: boolean;
  reasons: string[];
}

export function evaluate(
  proposed: ProposedTrade,
  account: AccountState,
  profile: RiskProfile,
): RiskResult {
  const reasons: string[] = [];

  if (proposed.positionSizeUsd > profile.maxPositionSizeUsd) {
    reasons.push(
      `Position size $${proposed.positionSizeUsd} exceeds max $${profile.maxPositionSizeUsd}`,
    );
  }

  if (account.dailyLossUsd >= profile.maxDailyLossUsd) {
    reasons.push(
      `Daily loss $${account.dailyLossUsd.toFixed(2)} reached limit $${profile.maxDailyLossUsd}`,
    );
  }

  if (account.currentDrawdownPct >= profile.maxDrawdownPct) {
    reasons.push(
      `Drawdown ${account.currentDrawdownPct.toFixed(2)}% reached limit ${profile.maxDrawdownPct}%`,
    );
  }

  if (account.openTradesCount >= profile.maxOpenTrades) {
    reasons.push(`Open trades ${account.openTradesCount} reached limit ${profile.maxOpenTrades}`);
  }

  if (account.lastLossAt !== null) {
    const minutesSinceLoss = (Date.now() - account.lastLossAt.getTime()) / 60_000;
    if (minutesSinceLoss < profile.cooldownMinutesAfterLoss) {
      reasons.push(
        `Cooldown: last loss ${Math.round(minutesSinceLoss)}m ago, cooldown is ${profile.cooldownMinutesAfterLoss}m`,
      );
    }
  }

  return { approved: reasons.length === 0, reasons };
}
