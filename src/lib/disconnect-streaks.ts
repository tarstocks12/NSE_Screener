import { HistoricalAuditDayEntry } from "./walk-forward-audit";

export interface DisconnectStreakDay {
  date: string;
  movePct: number;
}

export interface DisconnectStreakItem<TLabel extends string = "BULL" | "BEAR"> {
  symbol: string;
  streak: number;
  type: TLabel;
  pnlSum: number;
  days: DisconnectStreakDay[];
}

export interface DisconnectStreakResult<TLabel extends string = "BULL" | "BEAR"> {
  anchorDate: string | null;
  signalDate: string | null;
  streaks: DisconnectStreakItem<TLabel>[];
}

/**
 * Sorts audit logs strictly descending by outcome date, deduplicates per date,
 * and filters out unclosed placeholder EOD snapshots (where all picks have 0% actual PnL).
 */
export function extractClosedAuditLogs(
  filteredAuditLogs: HistoricalAuditDayEntry[]
): HistoricalAuditDayEntry[] {
  if (!filteredAuditLogs || filteredAuditLogs.length === 0) return [];

  const byDate = new Map<string, HistoricalAuditDayEntry>();
  const sortedDesc = [...filteredAuditLogs].sort((a, b) =>
    String(b.date || "").localeCompare(String(a.date || ""))
  );

  for (const log of sortedDesc) {
    if (!log?.date) continue;
    if (!byDate.has(log.date)) {
      byDate.set(log.date, log);
    }
  }

  return Array.from(byDate.values()).filter((log) => {
    const picks = [...(log.bullishPicks || []), ...(log.bearishPicks || [])];
    if (picks.length === 0) return false;
    return picks.some((p: any) => Math.abs(Number(p?.pnlPercent ?? 0)) > 0);
  });
}

/**
 * Computes genuine Prediction Disconnect Streaks anchored at `closedLogs[offset]`:
 * - offset = 0 -> Latest closed trading day
 * - offset = 1 -> Previous trading day
 * - offset = 2..10 -> 2 to 10 trading days ago
 *
 * Strictly enforces:
 * 1. Consecutive closed trading sessions walking backward from `offset` with zero skipped days.
 * 2. Unambiguous single predicted direction on every day (BULL XOR BEAR).
 * 3. Actual market outcome strictly opposite to predicted direction on every day:
 *    - Predicted BULL -> actual movePct < 0 && actualOutcome === false
 *    - Predicted BEAR -> actual movePct > 0 && actualOutcome === false
 * 4. Same predicted direction across all consecutive days, with streak >= max(2, minDays).
 */
export function computeDisconnectStreaksAtOffset<TLabel extends string>(
  closedLogs: HistoricalAuditDayEntry[],
  offset: number,
  minDays: number,
  activeUniverseSet: Set<string>,
  bullLabel: TLabel,
  bearLabel: TLabel
): DisconnectStreakResult<TLabel> {
  const effectiveMinDays = Math.max(2, minDays);
  if (
    !closedLogs ||
    offset < 0 ||
    offset >= closedLogs.length ||
    closedLogs.length - offset < effectiveMinDays
  ) {
    return {
      anchorDate: closedLogs?.[offset]?.date ?? null,
      signalDate: closedLogs?.[offset]?.signalDate ?? null,
      streaks: [],
    };
  }

  const anchorLog = closedLogs[offset];
  const anchorCandidates = new Set<string>();

  anchorLog.bullishPicks?.forEach((p: any) => {
    if (p?.symbol && (activeUniverseSet.size === 0 || activeUniverseSet.has(p.symbol))) {
      anchorCandidates.add(p.symbol);
    }
  });
  anchorLog.bearishPicks?.forEach((p: any) => {
    if (p?.symbol && (activeUniverseSet.size === 0 || activeUniverseSet.has(p.symbol))) {
      anchorCandidates.add(p.symbol);
    }
  });

  const results: DisconnectStreakItem<TLabel>[] = [];

  anchorCandidates.forEach((sym) => {
    let curStreak = 0;
    let curType: TLabel | null = null;
    let dirPnlSum = 0;
    const days: DisconnectStreakDay[] = [];

    for (let i = offset; i < closedLogs.length; i++) {
      const log = closedLogs[i];
      const bullPick = log.bullishPicks?.find((p: any) => p.symbol === sym);
      const bearPick = log.bearishPicks?.find((p: any) => p.symbol === sym);

      const isOnlyBull = Boolean(bullPick && !bearPick);
      const isOnlyBear = Boolean(bearPick && !bullPick);
      const pick = isOnlyBull ? bullPick : isOnlyBear ? bearPick : null;
      const type: TLabel | null = isOnlyBull ? bullLabel : isOnlyBear ? bearLabel : null;

      if (!pick || type === null) break;

      const movePct = Number(pick.pnlPercent ?? 0);
      const isOppositeOutcome =
        pick.actualOutcome === false &&
        ((isOnlyBull && movePct < 0) || (isOnlyBear && movePct > 0));

      if (!isOppositeOutcome) break;

      if (curStreak === 0) {
        curType = type;
      } else if (type !== curType) {
        break;
      }

      curStreak++;
      const dirPnl = isOnlyBull ? movePct : -movePct;
      dirPnlSum += dirPnl;
      days.push({ date: log.date, movePct: Number(movePct.toFixed(2)) });
    }

    if (curStreak >= effectiveMinDays && curType !== null) {
      results.push({
        symbol: sym,
        streak: curStreak,
        type: curType,
        pnlSum: parseFloat(dirPnlSum.toFixed(2)),
        days,
      });
    }
  });

  results.sort((a, b) => b.streak - a.streak || a.pnlSum - b.pnlSum);

  return {
    anchorDate: anchorLog.date,
    signalDate: anchorLog.signalDate ?? null,
    streaks: results,
  };
}
