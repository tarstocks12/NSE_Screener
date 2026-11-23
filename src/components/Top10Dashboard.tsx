import React, { useState, useEffect, useMemo } from 'react';
import {
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  ExternalLink,
  BrainCircuit,
  Activity,
  BarChart2,
  Search,
  Sliders,
  CheckCircle2,
  Layers
} from 'lucide-react';
import { Timeframe } from '../types';
import { FNO_SYMBOLS_LIST, NIFTY_500_SYMBOLS_LIST } from '../data/watchlists';
import {
  LAYA_QUANT_QUESTIONS_SCHEMA,
  LayaCalibrationReport,
  LayaDecisionOutput,
  evaluateLayaSystemOne,
  fitLayaCalibrationFromHistory,
  runLayaTournament,
  computeD1ToD4CombinedLaya,
  D1ToD4CombinedIntel,
  LayaPreTurnMode,
  getGlobalLayaLearnedState,
  setGlobalLayaLearnedState,
  subscribeLayaLearnedState,
  LayaSelfLearnedState,
} from '../lib/laya-engine';
import { LayaIntelCell } from './LayaIntelCell';
import { VERIFIED_LAYA_PRETURN_AUDIT_BASELINE } from '../data/verified-laya-preturn-audit-baseline';
import { mergeVerifiedAuditLogs, HistoricalAuditDayEntry } from '../lib/walk-forward-audit';

const LAYA_PRETURN_VAULT_STORAGE_KEY = "quant_swt_laya_preturn_audit_vault_v2";

function loadClientLayaPreTurnVault(): HistoricalAuditDayEntry[] {
  try {
    const raw = localStorage.getItem(LAYA_PRETURN_VAULT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return mergeVerifiedAuditLogs(VERIFIED_LAYA_PRETURN_AUDIT_BASELINE, parsed);
      }
    }
  } catch {}
  return [...VERIFIED_LAYA_PRETURN_AUDIT_BASELINE];
}

function saveClientLayaPreTurnVault(entries: HistoricalAuditDayEntry[]) {
  try {
    const merged = mergeVerifiedAuditLogs(VERIFIED_LAYA_PRETURN_AUDIT_BASELINE, entries);
    localStorage.setItem(LAYA_PRETURN_VAULT_STORAGE_KEY, JSON.stringify(merged));
    return merged;
  } catch {
    return entries;
  }
}

interface LayaPreTurnCandidateRow {
  symbol: string;
  intel: D1ToD4CombinedIntel;
  turnBullScore: number; // 0..100 (directly from D5 Laya Pre-Turn Intel column: intel.combinedLaya.score)
  turnBearScore: number; // 0..100 (bearish turn conviction: 100 - intel.combinedLaya.score)
  maxRvol: number;
  maxRvolTf: string;
  bullClimaxCount: number;
  bearClimaxCount: number;
  shrinkingVolCount: number;
  tfData: any;
  fullRow: any;
  layaBull?: LayaDecisionOutput;
  layaBear?: LayaDecisionOutput;
}

const REGIME_LABELS: Record<string, string> = {
  trend_continuation: "Trend Continuation",
  pullback_continuation: "Pullback Continuation",
  climax_reversal: "Climax Reversal",
  chop_avoid: "Chop / Avoid"
};

const ALL_D5_TIMEFRAMES: Timeframe[] = ["5m", "15m", "1H", "3H", "4H", "1D", "3D", "1W"];
const INSPECT_TIMEFRAMES: Timeframe[] = ["15m", "1H", "4H", "1D", "1W"];

export default function Top10Dashboard({ personalSymbols = [] }: { personalSymbols?: string[] }) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eodStatusBanner, setEodStatusBanner] = useState<string | null>(null);

  const [learnedState, setLearnedState] = useState<LayaSelfLearnedState>(() => getGlobalLayaLearnedState());
  const [layaCalibration, setLayaCalibration] = useState<LayaCalibrationReport | null>(null);
  const [serverLayaMap, setServerLayaMap] = useState<Record<string, LayaDecisionOutput>>({});
  const [layaBatchLatencyMs, setLayaBatchLatencyMs] = useState<number>(0);

  const [auditLogs, setAuditLogs] = useState<HistoricalAuditDayEntry[]>(() => {
    const vault = loadClientLayaPreTurnVault();
    return [...vault].reverse();
  });
  const [selectedAuditIdx, setSelectedAuditIdx] = useState<number>(0);
  const [liveQuotes, setLiveQuotes] = useState<Record<string, number>>({});

  // D5 Laya Pre-Turn Intelligence Mode:
  // "rvol_wick" -> Volume-Weighted & RVOL Confirmation (D5 Default, mapped to "Reversal" in Audit Log)
  // "standard"  -> Standard D1-D4 Multi-TF Inflection (mapped to "Trend" in Audit Log)
  const [layaMode, setLayaMode] = useState<LayaPreTurnMode>("rvol_wick");
  const [watchlistFilter, setWatchlistFilter] = useState("FNO");
  const [activeTimeframe, setActiveTimeframe] = useState<Timeframe>("1D");
  const [sortMode, setSortMode] = useState<"preturn" | "hybrid" | "laya_s1" | "live">("preturn");
  const [tournamentOnly, setTournamentOnly] = useState<boolean>(false);
  const [inspectedDecision, setInspectedDecision] = useState<LayaDecisionOutput | null>(null);

  const [auditSearchSymbol, setAuditSearchSymbol] = useState("");
  const [minStreakDays, setMinStreakDays] = useState<number>(2);

  useEffect(() => {
    return subscribeLayaLearnedState((st) => setLearnedState({ ...st }));
  }, []);

  const getTradingViewUrl = (symbol: string) => {
    let formattedSymbol = symbol;
    if (symbol === "NIFTY") formattedSymbol = "NIFTY";
    else if (symbol === "BANKNIFTY") formattedSymbol = "BANKNIFTY";
    else if (symbol === "CNXFINANCE") formattedSymbol = "CNXFINANCE";
    else formattedSymbol = symbol.replace("_", "-");
    return `https://www.tradingview.com/chart/?symbol=NSE:${formattedSymbol}`;
  };

  // In audit logs: "Reversal" stores RVOL + Wick Climax Laya Pre-Turn picks, "Trend" stores Standard Multi-TF Pre-Turn picks
  const filteredAuditLogs = useMemo(() => {
    return auditLogs.filter(log => layaMode === "standard" ? log.type === "Trend" : log.type === "Reversal");
  }, [auditLogs, layaMode]);

  const overArchingMetrics = useMemo(() => {
    let bullWins = 0, bullTotal = 0, bullPnL = 0;
    let bearWins = 0, bearTotal = 0, bearPnL = 0;
    filteredAuditLogs.forEach(log => {
      log.bullishPicks?.forEach((p: any) => {
        bullTotal++;
        if (p.actualOutcome) bullWins++;
        bullPnL += p.pnlPercent || 0;
      });
      log.bearishPicks?.forEach((p: any) => {
        bearTotal++;
        if (p.actualOutcome) bearWins++;
        bearPnL += p.pnlPercent || 0;
      });
    });
    return {
      bullWinRate: bullTotal ? Math.round((bullWins / bullTotal) * 100) : 0,
      bullAvgPnl: bullTotal ? (bullPnL / bullTotal).toFixed(2) : "0.00",
      bearWinRate: bearTotal ? Math.round((bearWins / bearTotal) * 100) : 0,
      bearAvgPnl: bearTotal ? (bearPnL / bearTotal).toFixed(2) : "0.00",
    };
  }, [filteredAuditLogs]);

  const streakData = useMemo(() => {
    if (!filteredAuditLogs || filteredAuditLogs.length === 0) return [];

    const effectiveMinDays = Math.max(2, minStreakDays);
    const activeSymbols = new Set<string>();

    if (data && data.length > 0) {
      data.forEach(d => activeSymbols.add(d.Symbol));
    } else {
      filteredAuditLogs.forEach(log => {
        log.bullishPicks?.forEach((p: any) => activeSymbols.add(p.symbol));
        log.bearishPicks?.forEach((p: any) => activeSymbols.add(p.symbol));
      });
    }

    const results: any[] = [];

    activeSymbols.forEach(sym => {
      let curStreak = 0;
      let curType = "";
      let curPnlSum = 0;

      // Strictly evaluate active consecutive trading days starting from the most recent session (i = 0).
      // Do NOT skip non-disconnect days with `continue` to surface old streaks from weeks/months ago.
      for (let i = 0; i < filteredAuditLogs.length; i++) {
        const log = filteredAuditLogs[i];
        const bullPick = log.bullishPicks?.find((p: any) => p.symbol === sym);
        const bearPick = log.bearishPicks?.find((p: any) => p.symbol === sym);

        // Require a single unambiguous pre-turn call on this trading day
        const pick = bullPick && !bearPick ? bullPick : bearPick && !bullPick ? bearPick : null;
        const type = bullPick && !bearPick ? "TURN BULL" : bearPick && !bullPick ? "TURN BEAR" : "";

        // Must be a genuine opposite-market outcome:
        // - Predicted TURN BULL, but actual market was BEAR (actualOutcome === false && pnlPercent < 0)
        // - Predicted TURN BEAR, but actual market was BULL (actualOutcome === false && pnlPercent > 0)
        const isOppositeMarketOutcome =
          pick !== null &&
          pick.actualOutcome === false &&
          ((type === "TURN BULL" && (pick.pnlPercent ?? 0) < 0) ||
           (type === "TURN BEAR" && (pick.pnlPercent ?? 0) > 0));

        if (!isOppositeMarketOutcome) {
          // Stop immediately: active consecutive streak from the latest trading day ends here
          break;
        }

        if (curStreak === 0) {
          curStreak = 1;
          curType = type;
          curPnlSum = pick.pnlPercent || 0;
        } else if (type === curType) {
          // Exact same pre-turn call on consecutive trading days with opposite actual market result
          curStreak++;
          curPnlSum += pick.pnlPercent || 0;
        } else {
          // Pre-turn call switched between TURN BULL and TURN BEAR -> stop immediately (do not combine)
          break;
        }
      }

      if (curStreak >= effectiveMinDays) {
        results.push({
          symbol: sym,
          streak: curStreak,
          type: curType,
          pnlSum: parseFloat(curPnlSum.toFixed(2))
        });
      }
    });

    return results.sort((a, b) => b.streak - a.streak);
  }, [filteredAuditLogs, minStreakDays, data]);

  const symbolSearchMetrics = useMemo(() => {
    if (!auditSearchSymbol.trim()) return null;
    const search = auditSearchSymbol.toUpperCase().trim();
    let wins = 0, total = 0, pnl = 0;
    const history: any[] = [];
    filteredAuditLogs.forEach(log => {
      log.bullishPicks?.forEach((p: any) => {
        if (p.symbol.includes(search)) {
          total++;
          if (p.actualOutcome) wins++;
          pnl += p.pnlPercent || 0;
          history.push({ date: log.date, type: "TURN BULL", ...p });
        }
      });
      log.bearishPicks?.forEach((p: any) => {
        if (p.symbol.includes(search)) {
          total++;
          if (p.actualOutcome) wins++;
          pnl += p.pnlPercent || 0;
          history.push({ date: log.date, type: "TURN BEAR", ...p });
        }
      });
    });
    return {
      winRate: total ? Math.round((wins / total) * 100) : 0,
      avgPnl: total ? (pnl / total).toFixed(2) : "0.00",
      total,
      history
    };
  }, [filteredAuditLogs, auditSearchSymbol]);

  useEffect(() => {
    setSelectedAuditIdx(0);
  }, [layaMode]);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      let targetList: string[] = [];
      if (watchlistFilter === "Personal") targetList = personalSymbols;
      else if (watchlistFilter === "Nifty500") targetList = NIFTY_500_SYMBOLS_LIST;
      else if (watchlistFilter === "FNO") targetList = FNO_SYMBOLS_LIST;

      if (targetList.length === 0) {
        setData([]);
        setLoading(false);
        return;
      }

      // 1. Fetch Self-Learned Laya Weights, RLCD Calibration, and D5 Laya Pre-Turn 50-Day Walk-Forward Audit Logs
      const [weightsRes, auditRes] = await Promise.all([
        fetch("/api/dynamic-weights"),
        fetch(`/api/laya-preturn-audit?universe=${watchlistFilter}&symbols=${encodeURIComponent(targetList.slice(0, 50).join(','))}`)
      ]);
      const weightsJson = await weightsRes.json();
      const auditJson = await auditRes.json();

      if (weightsJson.status === "ok") {
        if (weightsJson.layaCalibration) {
          setLayaCalibration(weightsJson.layaCalibration);
        }
        if (weightsJson.layaLearnedState) {
          setGlobalLayaLearnedState(weightsJson.layaLearnedState);
        }
      }

      if (auditJson.status === "ok" && Array.isArray(auditJson.data)) {
        const clientVault = loadClientLayaPreTurnVault();
        const unifiedChronological = mergeVerifiedAuditLogs(
          VERIFIED_LAYA_PRETURN_AUDIT_BASELINE,
          clientVault,
          auditJson.data
        );
        saveClientLayaPreTurnVault(unifiedChronological);
        const reversed = [...unifiedChronological].reverse();
        setAuditLogs(reversed);
        if (reversed.length > 0) setSelectedAuditIdx(0);

        if (unifiedChronological.length > auditJson.data.length) {
          fetch("/api/sync-laya-preturn-audit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              universe: watchlistFilter,
              entries: unifiedChronological
            })
          }).catch(() => {});
        }

        if (!weightsJson.layaCalibration) {
          setLayaCalibration(fitLayaCalibrationFromHistory(reversed));
        }
      }

      // 2. Fetch D5 Multi-Timeframe Matrix Data in chunks so Top 10 renders rapidly
      const chunkCount = 45;
      const chunks: string[][] = [];
      for (let i = 0; i < targetList.length; i += chunkCount) {
        chunks.push(targetList.slice(i, i + chunkCount));
      }

      const allData: any[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const symbolsQuery = chunk.join(",");
        const response = await fetch(`/api/wt-dashboard?symbols=${encodeURIComponent(symbolsQuery)}`);
        const json = await response.json();
        if (json.status === "ok" && Array.isArray(json.data)) {
          allData.push(...json.data);
          setData([...allData]);
        }
        if (json.layaLearnedState) setGlobalLayaLearnedState(json.layaLearnedState);
        if (i === 0) {
          setLoading(false);
        }
      }
    } catch (err: any) {
      setError(err.message || "Failed to load D5 Laya Pre-Turn Intel data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [watchlistFilter, personalSymbols]);

  // Compute exact D5 Virtual Dashboard `Laya Pre-Turn Intel` column scores + Laya System-1 RLCD decisions
  const baseScoredRows = useMemo(() => {
    if (!data.length) return [];

    const calTemp = layaCalibration?.temperature || [1.1, 1.05, 1.15];
    const calRuntime = layaCalibration?.runtimeMode || "laya-rlcd-calibrated";
    const sysMode = layaMode === "rvol_wick" ? "reversal" : "trend";

    const rawRows: LayaPreTurnCandidateRow[] = data.map(row => {
      // Exact computation used in D5VirtualizedDashboard.tsx for the `Laya Pre-Turn Intel` column
      const intel: D1ToD4CombinedIntel = computeD1ToD4CombinedLaya(row, layaMode);
      const tfData = row.timeframes?.[activeTimeframe] || row.timeframes?.["1D"] || row.timeframes?.["1H"] || null;

      // Aggregate RVOL & Wick Climax stats across all 8 D5 timeframes
      let maxRvol = 1.0;
      let maxRvolTf = "1D";
      let bullClimaxCount = 0;
      let bearClimaxCount = 0;
      let shrinkingVolCount = 0;

      for (const tf of ALL_D5_TIMEFRAMES) {
        const d = row.timeframes?.[tf];
        if (!d || d.isUnavailable) continue;
        const rv = Number(d.rvol ?? 1.0);
        if (rv > maxRvol) {
          maxRvol = rv;
          maxRvolTf = tf;
        }
        if (d.isBullClimaxAbsorption) bullClimaxCount++;
        if (d.isBearClimaxAbsorption) bearClimaxCount++;
        if (d.isShrinkingVolume) shrinkingVolCount++;
      }

      // In D5 `Laya Pre-Turn Intel`:
      // combinedLaya.score is 0..100 where >= 76 is STRONG TURN BULL, >= 58 is TURN BULL,
      // <= 24 is STRONG TURN BEAR, <= 42 is TURN BEAR.
      // Thus Turn Bull Strength = combinedLaya.score (higher = stronger Turn Bull),
      // and Turn Bear Strength = 100 - combinedLaya.score (higher = stronger Turn Bear, i.e., lowest combinedLaya.score).
      const turnBullScore = intel.combinedLaya.score;
      const turnBearScore = 100 - intel.combinedLaya.score;

      const layaBull =
        serverLayaMap[`${row.Symbol}_BULL_${sysMode}_${activeTimeframe}`] ||
        evaluateLayaSystemOne(
          row.Symbol,
          activeTimeframe,
          sysMode,
          "BULL",
          tfData,
          turnBullScore,
          100,
          calTemp,
          calRuntime
        );

      const layaBear =
        serverLayaMap[`${row.Symbol}_BEAR_${sysMode}_${activeTimeframe}`] ||
        evaluateLayaSystemOne(
          row.Symbol,
          activeTimeframe,
          sysMode,
          "BEAR",
          tfData,
          turnBearScore,
          100,
          calTemp,
          calRuntime
        );

      return {
        symbol: row.Symbol,
        intel,
        turnBullScore,
        turnBearScore,
        maxRvol: Number(maxRvol.toFixed(2)),
        maxRvolTf,
        bullClimaxCount,
        bearClimaxCount,
        shrinkingVolCount,
        tfData,
        fullRow: row,
        layaBull,
        layaBear
      };
    });

    const validRows = rawRows.filter(r => r.tfData !== null);
    const bullDecisions = runLayaTournament(
      validRows.map(r => r.layaBull!).filter(Boolean),
      16,
      10
    );
    const bearDecisions = runLayaTournament(
      validRows.map(r => r.layaBear!).filter(Boolean),
      16,
      10
    );

    const bullMap = new Map(bullDecisions.map(d => [d.symbol, d]));
    const bearMap = new Map(bearDecisions.map(d => [d.symbol, d]));

    return validRows.map(r => ({
      ...r,
      layaBull: bullMap.get(r.symbol) || r.layaBull,
      layaBear: bearMap.get(r.symbol) || r.layaBear
    }));
  }, [data, activeTimeframe, layaMode, layaCalibration, serverLayaMap, learnedState.version]);

  // Synchronize with backend `/api/laya-decide` endpoint
  useEffect(() => {
    if (!data.length) return;
    const sysMode = layaMode === "rvol_wick" ? "reversal" : "trend";
    const itemsPayload: any[] = [];

    for (const row of data) {
      const tfData = row.timeframes?.[activeTimeframe] || row.timeframes?.["1D"];
      if (!tfData || tfData.isUnavailable) continue;
      const matched = baseScoredRows.find(b => b.symbol === row.Symbol);
      const bullScore = matched?.turnBullScore || 50;
      const bearScore = matched?.turnBearScore || 50;

      itemsPayload.push({
        symbol: row.Symbol,
        timeframe: activeTimeframe,
        mode: sysMode,
        direction: "BULL",
        tfData,
        mwuaScore: bullScore,
        maxMwuaScore: 100
      });
      itemsPayload.push({
        symbol: row.Symbol,
        timeframe: activeTimeframe,
        mode: sysMode,
        direction: "BEAR",
        tfData,
        mwuaScore: bearScore,
        maxMwuaScore: 100
      });
    }

    if (itemsPayload.length === 0) return;

    let cancelled = false;
    fetch("/api/laya-decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: itemsPayload,
        groupSize: 16,
        finalistsCount: 10
      })
    })
      .then(res => res.json())
      .then(json => {
        if (cancelled || json.status !== "ok") return;
        if (json.calibration) setLayaCalibration(json.calibration);
        if (typeof json.batchLatencyMs === "number") setLayaBatchLatencyMs(json.batchLatencyMs);
        if (Array.isArray(json.decisions)) {
          const nextMap: Record<string, LayaDecisionOutput> = {};
          for (const d of json.decisions) {
            nextMap[`${d.symbol}_${d.direction}_${sysMode}_${activeTimeframe}`] = d;
          }
          setServerLayaMap(prev => ({ ...prev, ...nextMap }));
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [data, activeTimeframe, layaMode]);

  const getRowCombinedScore = (item: LayaPreTurnCandidateRow, isBull: boolean) => {
    const rawLayaColumnScore = item.intel.combinedLaya.score; // 0..100 on D5 column
    const turnStrengthPct = isBull ? item.turnBullScore : item.turnBearScore; // 0..100 directional strength
    const layaDec = isBull ? item.layaBull : item.layaBear;
    const layaS1Score = layaDec?.compositeScore ?? turnStrengthPct;
    const hybridScore = Math.round(turnStrengthPct * 0.6 + layaS1Score * 0.4);
    return {
      rawLayaColumnScore,
      turnStrengthPct,
      layaS1Score,
      hybridScore,
      layaDec
    };
  };

  const { currentBullish, currentBearish } = useMemo(() => {
    let bullPool = [...baseScoredRows];
    let bearPool = [...baseScoredRows];

    if (tournamentOnly) {
      const qualBull = bullPool.filter(r => r.layaBull?.tournament?.qualified);
      const qualBear = bearPool.filter(r => r.layaBear?.tournament?.qualified);
      if (qualBull.length > 0) bullPool = qualBull;
      if (qualBear.length > 0) bearPool = qualBear;
    }

    const sortFn = (isBull: boolean) => (a: LayaPreTurnCandidateRow, b: LayaPreTurnCandidateRow) => {
      if (sortMode === "live") {
        const qa = liveQuotes[a.symbol] || 0;
        const qb = liveQuotes[b.symbol] || 0;
        return isBull ? qb - qa : qa - qb;
      }
      const sa = getRowCombinedScore(a, isBull);
      const sb = getRowCombinedScore(b, isBull);
      if (sortMode === "laya_s1") return sb.layaS1Score - sa.layaS1Score;
      if (sortMode === "hybrid") return sb.hybridScore - sa.hybridScore;
      // Default "preturn": exact D5 Virtual Dashboard `Laya Pre-Turn Intel` column ranking!
      // Strongest Turn Bull = highest combinedLaya.score (turnBullScore desc)
      // Strongest Turn Bear = lowest combinedLaya.score (turnBearScore desc)
      if (sb.turnStrengthPct !== sa.turnStrengthPct) {
        return sb.turnStrengthPct - sa.turnStrengthPct;
      }
      return sb.hybridScore - sa.hybridScore;
    };

    const topBull = bullPool.sort(sortFn(true)).slice(0, 10);
    const topBear = bearPool.sort(sortFn(false)).slice(0, 10);

    return { currentBullish: topBull, currentBearish: topBear };
  }, [baseScoredRows, sortMode, tournamentOnly, liveQuotes, layaMode]);

  // Keep default inspected decision synced with top #1 Strongest Turn Bull pick
  useEffect(() => {
    if (!inspectedDecision && currentBullish.length > 0 && currentBullish[0].layaBull) {
      setInspectedDecision(currentBullish[0].layaBull);
    }
  }, [currentBullish, inspectedDecision]);

  const finalizeEOD = async () => {
    try {
      if (currentBullish.length === 0 && currentBearish.length === 0) {
        setEodStatusBanner("No Laya Pre-Turn Intel candidate picks available to finalize.");
        return;
      }

      const mapPick = (item: LayaPreTurnCandidateRow, rank: number, isBull: boolean) => ({
        rank,
        symbol: item.symbol,
        prediction: isBull ? "BULL" : "BEAR",
        actualOutcome: true,
        pnlPercent: 0,
        signalScore: item.intel.combinedLaya.score,
        indicators: {
          hmaFired: isBull ? item.intel.d1Laya.direction === "BULL" : item.intel.d1Laya.direction === "BEAR",
          stFired: isBull ? item.intel.d2Laya.direction === "BULL" : item.intel.d2Laya.direction === "BEAR",
          wtFired: isBull ? item.intel.d3Laya.direction === "BULL" : item.intel.d3Laya.direction === "BEAR",
          tsiFired: isBull ? item.intel.d4Laya.direction === "BULL" : item.intel.d4Laya.direction === "BEAR",
          htfFired: Boolean(item.intel.combinedLaya.rvolClimaxConfirmed || (isBull ? item.bullClimaxCount > 0 : item.bearClimaxCount > 0))
        }
      });

      const bullishPicks = currentBullish.map((item, idx) => mapPick(item, idx + 1, true));
      const bearishPicks = currentBearish.map((item, idx) => mapPick(item, idx + 1, false));

      const response = await fetch("/api/finalize-laya-preturn-eod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          universe: watchlistFilter,
          type: layaMode === "standard" ? "Trend" : "Reversal",
          bullishPicks,
          bearishPicks
        })
      });
      if (response.ok) {
        const resJson = await response.json().catch(() => ({}));
        if (resJson.entry) {
          const updatedVault = saveClientLayaPreTurnVault([...loadClientLayaPreTurnVault(), resJson.entry]);
          setAuditLogs([...updatedVault].reverse());
        }
        setEodStatusBanner("D5 Laya Pre-Turn Intel EOD snapshot recorded to server & browser vault. Walk-forward calibration updated.");
        setTimeout(() => setEodStatusBanner(null), 6000);
        fetchData();
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    const symbolsToFetch = [
      ...currentBullish.map(i => i.symbol),
      ...currentBearish.map(i => i.symbol)
    ];
    if (symbolsToFetch.length === 0) return;

    fetch(`/api/live-quotes?symbols=${encodeURIComponent(symbolsToFetch.join(','))}`)
      .then(res => res.json())
      .then(json => {
        if (json.status === "ok" && json.data) {
          setLiveQuotes(json.data);
        }
      })
      .catch(console.error);
  }, [currentBullish, currentBearish]);

  const getNextTradingDay = () => {
    const now = new Date();
    const istString = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const istDate = new Date(istString);

    const dayOfWeek = istDate.getDay();
    const hours = istDate.getHours();
    const minutes = istDate.getMinutes();

    let addDays = 0;
    const isMarketClosed = hours > 15 || (hours === 15 && minutes >= 30);

    if (dayOfWeek === 6) {
      addDays = 2;
    } else if (dayOfWeek === 0) {
      addDays = 1;
    } else if (isMarketClosed) {
      if (dayOfWeek === 5) {
        addDays = 3;
      } else {
        addDays = 1;
      }
    }

    istDate.setDate(istDate.getDate() + addDays);

    const y = istDate.getFullYear();
    const m = String(istDate.getMonth() + 1).padStart(2, '0');
    const d = String(istDate.getDate()).padStart(2, '0');

    return `${y}-${m}-${d}`;
  };
  const nextTradingDay = getNextTradingDay();

  const renderCandidateCard = (item: LayaPreTurnCandidateRow, idx: number, isBull: boolean) => {
    const { rawLayaColumnScore, turnStrengthPct, layaS1Score, hybridScore, layaDec } = getRowCombinedScore(item, isBull);
    const regimeChoice = layaDec?.answers.setup_regime.choice || "climax_reversal";
    const regimeProb = Math.round((layaDec?.answers.setup_regime.confidence ?? 0.5) * 100);
    const convictionTier = layaDec?.answers.conviction_tier.tier || "moderate";
    const followThroughPct = Math.round((layaDec?.answers.follow_through_prob.noul ?? 0.5) * 100);
    const whipsawPct = Math.round((layaDec?.answers.whipsaw_trap_risk.noul ?? 0.3) * 100);
    const isInspected =
      inspectedDecision?.symbol === item.symbol &&
      inspectedDecision?.direction === (isBull ? "BULL" : "BEAR");

    return (
      <div
        key={`${item.symbol}-${idx}`}
        onClick={() => layaDec && setInspectedDecision(layaDec)}
        className={`rounded-xl border p-4 max-md:p-3.5 transition-colors cursor-pointer ${
          isInspected
            ? 'bg-slate-800/90 border-emerald-500/70'
            : 'bg-slate-800/60 border-slate-700/80 hover:border-slate-600'
        }`}
      >
        <div className="flex items-start justify-between gap-4 max-md:flex-col max-md:items-stretch max-md:gap-3">
          <div className="flex items-start gap-3.5 min-w-0">
            <div className={`w-7 h-7 rounded-md border flex items-center justify-center font-mono font-semibold text-xs shrink-0 mt-0.5 ${
              isBull
                ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                : 'bg-rose-950/60 border-rose-500/40 text-rose-300'
            }`}>
              #{idx + 1}
            </div>
            <div className="min-w-0">
              <div className="font-bold text-base text-slate-100 flex items-center gap-2 flex-wrap">
                <span>{item.symbol}</span>
                <a
                  href={getTradingViewUrl(item.symbol)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-slate-500 hover:text-emerald-400 transition-colors"
                  title="Open in TradingView"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                {liveQuotes[item.symbol] !== undefined && (
                  <span
                    className={`text-xs font-mono tabular-nums ${
                      liveQuotes[item.symbol] > 0
                        ? 'text-emerald-400'
                        : liveQuotes[item.symbol] < 0
                        ? 'text-rose-400'
                        : 'text-slate-400'
                    }`}
                  >
                    {liveQuotes[item.symbol] > 0 ? '+' : ''}
                    {liveQuotes[item.symbol].toFixed(2)}%
                  </span>
                )}
                <span className="text-[11px] font-mono tabular-nums text-orange-400">
                  Peak RVOL {item.maxRvol.toFixed(1)}x ({item.maxRvolTf})
                </span>
              </div>

              {/* Clean unboxed Laya System-1 + D5 Pre-Turn telemetry */}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                <span className="text-slate-200 font-medium">
                  {REGIME_LABELS[regimeChoice] || regimeChoice}
                </span>
                <span className="font-mono tabular-nums text-slate-500">({regimeProb}%)</span>
                <span aria-hidden="true">·</span>
                <span className="capitalize text-indigo-300">{convictionTier} tier</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums text-slate-300">
                  D1:{item.intel.d1Laya.score} D2:{item.intel.d2Laya.score} D3:{item.intel.d3Laya.score} D4:{item.intel.d4Laya.score}
                </span>
                {layaDec?.tournament?.finalRank && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-amber-300/90">
                      T-Rank #{layaDec.tournament.finalRank}
                    </span>
                  </>
                )}
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono tabular-nums text-slate-400">
                <span>
                  Follow-Through Noul:{' '}
                  <strong className={followThroughPct >= 60 ? 'text-emerald-400' : 'text-slate-200'}>
                    {followThroughPct}%
                  </strong>
                </span>
                <span aria-hidden="true">/</span>
                <span>
                  Whipsaw Risk:{' '}
                  <strong className={whipsawPct >= 45 ? 'text-rose-400' : 'text-emerald-400'}>
                    {whipsawPct}%
                  </strong>
                </span>
                {item.intel.combinedLaya.triggerTfs.length > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className={isBull ? 'text-emerald-400/90' : 'text-rose-400/90'}>
                      Turn TFs: {item.intel.combinedLaya.triggerTfs.join(", ")}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0 max-md:justify-between max-md:pt-2.5 max-md:border-t max-md:border-slate-700/50">
            <div className="border-r border-slate-700/60 pr-3">
              <div className="text-[9px] uppercase font-mono text-emerald-400/90 text-center mb-0.5">
                D5 Laya Pre-Turn Intel
              </div>
              <LayaIntelCell intel={item.intel.combinedLaya} compact />
            </div>
            <div className="text-right">
              <div className="text-xs font-mono tabular-nums text-slate-300">
                {isBull ? 'Turn Bull' : 'Turn Bear'}{' '}
                <strong className="text-slate-100 text-sm">{turnStrengthPct}%</strong>
              </div>
              <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5">
                D5 Col {rawLayaColumnScore}/100 · S1 {layaS1Score}%
              </div>
              <div className="w-28 h-1.5 bg-slate-900 rounded-full overflow-hidden mt-2 flex ml-auto">
                <div
                  className={`h-full ${isBull ? 'bg-emerald-500' : 'bg-rose-500'}`}
                  style={{ width: `${Math.round(turnStrengthPct * 0.6)}%` }}
                  title={`D5 Laya Pre-Turn Strength: ${turnStrengthPct}%`}
                />
                <div
                  className="h-full bg-indigo-400"
                  style={{ width: `${Math.round(layaS1Score * 0.4)}%` }}
                  title={`Laya System-1 Component: ${layaS1Score}% (Hybrid ${hybridScore}%)`}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Header & Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-slate-800/40 p-5 rounded-xl border border-slate-700">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-emerald-500/15 rounded-lg border border-emerald-500/30">
            <Layers className="w-6 h-6 text-emerald-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-100">
              D5 Laya Pre-Turn Intel Top 10 ({nextTradingDay})
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mt-0.5">
              <span>Top 10 Strongest Turn Bull &amp; Strongest Turn Bear from D5 Virtual Dashboard</span>
              <span aria-hidden="true">·</span>
              <span>
                {layaMode === "rvol_wick"
                  ? "Volume-Weighted & RVOL Climax Confirmation"
                  : "Standard D1–D4 Multi-TF Inflection"}
              </span>
              {layaCalibration && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-emerald-300">
                    Brier {layaCalibration.brierScore.toFixed(3)} · ECE {(layaCalibration.expectedCalibrationError * 100).toFixed(1)}% · {layaBatchLatencyMs || 1.2}ms pass
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* D5 Laya Pre-Turn Mode Switcher */}
          <div className="flex bg-slate-900 rounded-lg p-1 border border-slate-700">
            <button
              onClick={() => setLayaMode("rvol_wick")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                layaMode === "rvol_wick" ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Volume-Weighted & RVOL Confirmation for Laya Pre-Turn Signals (D5 Default)"
            >
              RVOL + Wick Climax
            </button>
            <button
              onClick={() => setLayaMode("standard")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                layaMode === "standard" ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Standard D1–D4 Multi-Timeframe Pre-Turn Inflection"
            >
              Standard Pre-Turn
            </button>
          </div>

          {/* Sort Mode Selector */}
          <div className="flex bg-slate-900 rounded-lg p-1 border border-slate-700">
            <button
              onClick={() => setSortMode("preturn")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                sortMode === "preturn" ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Sort directly by D5 Laya Pre-Turn Intel column score"
            >
              Laya Pre-Turn
            </button>
            <button
              onClick={() => setSortMode("hybrid")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                sortMode === "hybrid" ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Hybrid
            </button>
            <button
              onClick={() => setSortMode("laya_s1")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                sortMode === "laya_s1" ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Laya S1
            </button>
            <button
              onClick={() => setSortMode("live")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                sortMode === "live" ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Live %
            </button>
          </div>

          <button
            onClick={() => setTournamentOnly(prev => !prev)}
            className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
              tournamentOnly
                ? 'bg-emerald-600/20 border-emerald-500 text-emerald-200'
                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
            title="Filter via Laya 16-group Tournament Elimination (predictTournament)"
          >
            Tournament 16x
          </button>

          <select
            value={watchlistFilter}
            onChange={(e) => setWatchlistFilter(e.target.value)}
            className="bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 outline-none focus:border-emerald-500"
          >
            <option value="Personal">Personal</option>
            <option value="Nifty500">Nifty 500</option>
            <option value="FNO">FnO (F&amp;O)</option>
          </select>

          <select
            value={activeTimeframe}
            onChange={(e) => setActiveTimeframe(e.target.value as Timeframe)}
            className="bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 outline-none focus:border-emerald-500"
            title="Anchor Timeframe for Laya System-1 State Inspector"
          >
            {INSPECT_TIMEFRAMES.map(tf => (
              <option key={tf} value={tf}>{tf}</option>
            ))}
          </select>

          <button
            onClick={fetchData}
            disabled={loading}
            className="p-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors"
            title="Refresh D5 Laya Pre-Turn Intel Top 10 & Walk-Forward Audit"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {eodStatusBanner && (
        <div className="p-3.5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-300 text-sm flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{eodStatusBanner}</span>
        </div>
      )}

      {loading && data.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-4">
            <BrainCircuit className="w-10 h-10 text-emerald-400 animate-pulse" />
            <p className="text-slate-400 font-medium text-sm">
              Scanning D5 Virtual Matrix &amp; ranking Top 10 Strongest Turn Bull / Turn Bear from Laya Pre-Turn Intel...
            </p>
          </div>
        </div>
      ) : error ? (
        <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400">{error}</div>
      ) : (
        <div className="space-y-8">
          {/* SECTION A: Top 10 Strongest Turn Bull & Top 10 Strongest Turn Bear from D5 Laya Pre-Turn Intel */}
          <div className="grid lg:grid-cols-2 gap-6">
            <div className="space-y-3.5">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <ArrowUpRight className="w-5 h-5 text-emerald-400" />
                  <h3 className="text-base font-bold text-slate-100">
                    Top 10 Strongest Turn Bull — Laya Pre-Turn Intel ({nextTradingDay})
                  </h3>
                </div>
                <span className="text-xs text-slate-400">Click any symbol to inspect Laya schema</span>
              </div>
              <div className="flex flex-col gap-3">
                {currentBullish.map((item, idx) => renderCandidateCard(item, idx, true))}
              </div>
            </div>

            <div className="space-y-3.5">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <ArrowDownRight className="w-5 h-5 text-rose-400" />
                  <h3 className="text-base font-bold text-slate-100">
                    Top 10 Strongest Turn Bear — Laya Pre-Turn Intel ({nextTradingDay})
                  </h3>
                </div>
                <span className="text-xs text-slate-400">Click any symbol to inspect Laya schema</span>
              </div>
              <div className="flex flex-col gap-3">
                {currentBearish.map((item, idx) => renderCandidateCard(item, idx, false))}
              </div>
            </div>
          </div>

          {/* SECTION A.2: Laya System-1 Decision Schema Inspector */}
          {inspectedDecision && (
            <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-700/70 pb-3.5">
                <div>
                  <div className="flex items-center gap-2.5">
                    <Sliders className="w-4 h-4 text-emerald-400" />
                    <h3 className="font-bold text-slate-100 text-base">
                      Laya System-1 Decision Telemetry: {inspectedDecision.symbol} (TURN {inspectedDecision.direction})
                    </h3>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Non-autoregressive single forward pass calibrated via Reinforcement Learning for Calibrated Decisions (RLCD) on D5 Laya Pre-Turn Intel
                  </p>
                </div>
                <div className="flex items-center gap-3 text-xs font-mono tabular-nums text-slate-400">
                  <span>Runtime: <strong className="text-slate-200">{inspectedDecision.routing.runtime}</strong></span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Temp T=[{inspectedDecision.routing.temperature.join(", ")}]
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>Composite: <strong className="text-emerald-300">{inspectedDecision.compositeScore}%</strong></span>
                </div>
              </div>

              {/* Serialized State Vector */}
              <div className="bg-slate-900/80 border border-slate-700/70 rounded-lg p-3">
                <div className="text-[11px] text-slate-400 mb-1 font-medium">
                  Input State Vector (`state` passed to `router.predict`)
                </div>
                <div className="font-mono text-xs text-slate-200 break-all leading-relaxed">
                  {inspectedDecision.state}
                </div>
              </div>

              {/* 3-Column Typed Schema Breakdown: choice | score | noul */}
              <div className="grid md:grid-cols-3 gap-4">
                {/* 1. Typed Choice */}
                <div className="bg-slate-900/50 border border-slate-700/60 rounded-lg p-4 space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400 font-medium">1. Typed Choice (`setup_regime`)</span>
                    <span className="font-mono text-indigo-300">type: "choice"</span>
                  </div>
                  <div className="text-xs text-slate-500">
                    {LAYA_QUANT_QUESTIONS_SCHEMA.setup_regime.instructions}
                  </div>
                  <div className="space-y-2 pt-1">
                    {Object.entries(inspectedDecision.answers.setup_regime.probabilities).map(([key, prob]) => {
                      const pct = Math.round(Number(prob) * 100);
                      const isWinner = inspectedDecision.answers.setup_regime.choice === key;
                      return (
                        <div key={key} className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className={isWinner ? 'text-slate-100 font-semibold' : 'text-slate-400'}>
                              {REGIME_LABELS[key] || key}
                            </span>
                            <span className="font-mono tabular-nums text-slate-300">{pct}%</span>
                          </div>
                          <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full ${isWinner ? 'bg-indigo-400' : 'bg-slate-600'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 2. Ordinal Score */}
                <div className="bg-slate-900/50 border border-slate-700/60 rounded-lg p-4 space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400 font-medium">2. Ordinal Score (`conviction_tier`)</span>
                    <span className="font-mono text-indigo-300">type: "score"</span>
                  </div>
                  <div className="text-xs text-slate-500">
                    Expected Value: <strong className="text-slate-200 font-mono">{inspectedDecision.answers.conviction_tier.score}/100</strong>
                  </div>
                  <div className="space-y-2 pt-1">
                    {Object.entries(inspectedDecision.answers.conviction_tier.distribution).map(([tier, prob]) => {
                      const pct = Math.round(Number(prob) * 100);
                      const isWinner = inspectedDecision.answers.conviction_tier.tier === tier;
                      return (
                        <div key={tier} className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className={`capitalize ${isWinner ? 'text-slate-100 font-semibold' : 'text-slate-400'}`}>
                              {tier}
                            </span>
                            <span className="font-mono tabular-nums text-slate-300">{pct}%</span>
                          </div>
                          <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full ${isWinner ? 'bg-emerald-400' : 'bg-slate-600'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 3. Binary Noul Probabilities */}
                <div className="bg-slate-900/50 border border-slate-700/60 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400 font-medium">3. Binary Noul (`noul`)</span>
                    <span className="font-mono text-indigo-300">type: "noul"</span>
                  </div>

                  <div className="space-y-1.5 pt-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-300 font-medium">Session Follow-Through (`yes`)</span>
                      <span className="font-mono tabular-nums text-emerald-400 font-semibold">
                        {(inspectedDecision.answers.follow_through_prob.noul * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500"
                        style={{ width: `${Math.round(inspectedDecision.answers.follow_through_prob.noul * 100)}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {LAYA_QUANT_QUESTIONS_SCHEMA.follow_through_prob.instructions}
                    </div>
                  </div>

                  <div className="space-y-1.5 pt-2 border-t border-slate-800">
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-300 font-medium">Whipsaw / Trap Risk (`yes`)</span>
                      <span className="font-mono tabular-nums text-rose-400 font-semibold">
                        {(inspectedDecision.answers.whipsaw_trap_risk.noul * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-rose-500"
                        style={{ width: `${Math.round(inspectedDecision.answers.whipsaw_trap_risk.noul * 100)}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {LAYA_QUANT_QUESTIONS_SCHEMA.whipsaw_trap_risk.instructions}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={finalizeEOD}
              className="px-5 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-100 rounded-lg transition-colors font-medium text-xs flex items-center gap-2"
            >
              <Activity className="w-4 h-4 text-emerald-400" />
              Finalize EOD Run (Update D5 Laya Pre-Turn Audit &amp; RLCD Calibration)
            </button>
          </div>

          <div className="grid lg:grid-cols-2 gap-8 pt-6 border-t border-slate-700">
            {/* SECTION B: 50-Day Audit Log & Backtesting for D5 Laya Pre-Turn Intel */}
            <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-5 max-md:p-3.5 flex flex-col h-[500px] max-md:h-auto max-md:max-h-[680px] lg:col-span-2">
              <div className="flex items-center justify-between max-md:flex-col max-md:items-stretch max-md:gap-2.5 mb-4">
                <div className="flex items-center gap-2">
                  <BarChart2 className="w-5 h-5 text-emerald-400" />
                  <h3 className="font-bold text-slate-100">
                    50-Day Audit Log &amp; Backtesting — D5 Laya Pre-Turn Intel
                  </h3>
                </div>
                <div className="flex items-center gap-4 max-md:gap-2 max-md:flex-wrap">
                  <div className="relative max-md:flex-1">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Search className="w-4 h-4 text-slate-500" />
                    </div>
                    <input
                      type="text"
                      placeholder="Search symbol..."
                      value={auditSearchSymbol}
                      onChange={(e) => setAuditSearchSymbol(e.target.value.toUpperCase())}
                      className="bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-lg pl-9 pr-3 py-1.5 outline-none focus:border-emerald-500 w-40 max-md:w-full"
                    />
                  </div>
                  {filteredAuditLogs.length > 0 && !symbolSearchMetrics && (
                    <select
                      value={selectedAuditIdx}
                      onChange={(e) => setSelectedAuditIdx(Number(e.target.value))}
                      className="bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-1.5 outline-none focus:border-emerald-500 max-md:w-full"
                    >
                      {filteredAuditLogs.map((log, idx) => (
                        <option key={idx} value={idx}>
                          {log.signalDate ? `${log.signalDate} → ${log.date}` : log.date} ({log.type === "Reversal" ? "RVOL + Wick Pre-Turn" : "Standard Pre-Turn"})
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {symbolSearchMetrics ? (
                <div className="flex-1 overflow-auto max-h-[500px]">
                  <div className="grid grid-cols-3 max-md:grid-cols-1 gap-4 max-md:gap-2.5 mb-6">
                    <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-700/50">
                      <div className="text-slate-400 text-xs mb-1 font-medium">Total Laya Pre-Turn Signals</div>
                      <div className="text-xl font-bold text-slate-200 font-mono tabular-nums">{symbolSearchMetrics.total}</div>
                    </div>
                    <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-700/50">
                      <div className="text-slate-400 text-xs mb-1 font-medium">Walk-Forward Win Rate</div>
                      <div className="text-xl font-bold text-emerald-400 font-mono tabular-nums">{symbolSearchMetrics.winRate}%</div>
                    </div>
                    <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-700/50">
                      <div className="text-slate-400 text-xs mb-1 font-medium">Average Realized PnL</div>
                      <div className={`text-xl font-bold font-mono tabular-nums ${parseFloat(symbolSearchMetrics.avgPnl) > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {parseFloat(symbolSearchMetrics.avgPnl) > 0 ? '+' : ''}{symbolSearchMetrics.avgPnl}%
                      </div>
                    </div>
                  </div>
                  <table className="w-full text-left text-sm text-slate-300">
                    <thead className="text-slate-400 border-b border-slate-700/50 sticky top-0 bg-slate-800/90">
                      <tr>
                        <th className="py-2">Outcome Date</th>
                        <th className="py-2">Symbol</th>
                        <th className="py-2">Pre-Turn Call</th>
                        <th className="py-2">Pre-Turn Drivers</th>
                        <th className="py-2">Result</th>
                        <th className="py-2 text-right">Actual %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {symbolSearchMetrics.history.map((pick, idx) => {
                        const firedList = [
                          pick.indicators?.hmaFired && "D1-HMA",
                          pick.indicators?.stFired && "D2-ST",
                          pick.indicators?.wtFired && "D3-WT",
                          pick.indicators?.tsiFired && "D4-TSI",
                          pick.indicators?.htfFired && "RVOL/HTF"
                        ].filter(Boolean).join(" · ");
                        return (
                          <tr key={idx} className="border-b border-slate-700/30 hover:bg-slate-800/50">
                            <td className="py-2 font-mono text-xs">{pick.date}</td>
                            <td className="py-2 font-medium">{pick.symbol}</td>
                            <td className="py-2">
                              <span className={`text-xs font-medium ${pick.type === 'TURN BULL' ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {pick.type}
                              </span>
                            </td>
                            <td className="py-2 text-xs text-slate-400 font-mono">{firedList || "—"}</td>
                            <td className="py-2">
                              {pick.actualOutcome ? (
                                <span className="text-emerald-400">Win</span>
                              ) : (
                                <span className="text-rose-400">Loss</span>
                              )}
                            </td>
                            <td className={`py-2 text-right font-mono tabular-nums ${pick.pnlPercent > 0 ? 'text-emerald-400' : pick.pnlPercent < 0 ? 'text-rose-400' : 'text-slate-400'}`}>
                              {pick.pnlPercent > 0 ? '+' : ''}{pick.pnlPercent}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : filteredAuditLogs[selectedAuditIdx] ? (
                <div className="flex-1 overflow-auto max-h-[500px]">
                  <div className="grid grid-cols-2 max-md:grid-cols-1 gap-4 max-md:gap-2.5 mb-4">
                    <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3 flex justify-between items-center max-md:flex-wrap max-md:gap-2">
                      <div className="text-slate-300 text-sm font-medium">50-Day Walk-Forward Turn Bull</div>
                      <div className="flex gap-4 text-sm font-bold font-mono tabular-nums">
                        <span className="text-emerald-400">{overArchingMetrics.bullWinRate}% Win Rate</span>
                        <span className="text-emerald-400">Avg {parseFloat(overArchingMetrics.bullAvgPnl) > 0 ? '+' : ''}{overArchingMetrics.bullAvgPnl}%</span>
                      </div>
                    </div>
                    <div className="bg-rose-500/5 border border-rose-500/20 rounded-lg p-3 flex justify-between items-center max-md:flex-wrap max-md:gap-2">
                      <div className="text-slate-300 text-sm font-medium">50-Day Walk-Forward Turn Bear</div>
                      <div className="flex gap-4 text-sm font-bold font-mono tabular-nums">
                        <span className="text-rose-400">{overArchingMetrics.bearWinRate}% Win Rate</span>
                        <span className="text-rose-400">Avg {parseFloat(overArchingMetrics.bearAvgPnl) > 0 ? '+' : ''}{overArchingMetrics.bearAvgPnl}%</span>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 max-md:grid-cols-1 gap-4">
                    {/* Strongest Turn Bull Picks */}
                    <div>
                      <h4 className="text-sm font-semibold text-emerald-400 mb-2 sticky top-0 bg-slate-800/90 py-1">
                        Top 10 Strongest Turn Bull
                      </h4>
                      <table className="w-full text-left text-xs text-slate-300">
                        <thead className="text-slate-400 border-b border-slate-700/50">
                          <tr>
                            <th className="py-1">Rank</th>
                            <th className="py-1">Symbol</th>
                            <th className="py-1">Laya Score</th>
                            <th className="py-1">Triggered</th>
                            <th className="py-1">Result</th>
                            <th className="py-1 text-right">Actual %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredAuditLogs[selectedAuditIdx].bullishPicks?.map((pick: any, idx: number) => {
                            const triggers = [
                              pick.indicators?.hmaFired && "D1",
                              pick.indicators?.stFired && "D2",
                              pick.indicators?.wtFired && "D3",
                              pick.indicators?.tsiFired && "D4",
                              pick.indicators?.htfFired && "RVOL"
                            ].filter(Boolean).join("·");
                            return (
                              <tr key={`${pick.symbol}-${idx}`} className="border-b border-slate-700/30 hover:bg-slate-800/50">
                                <td className="py-1 text-slate-500 font-mono">#{pick.rank}</td>
                                <td className="py-1 font-medium flex items-center gap-1">
                                  {pick.symbol}
                                  <a href={getTradingViewUrl(pick.symbol)} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-emerald-400 transition-colors">
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                </td>
                                <td className="py-1 font-mono text-emerald-400">
                                  {pick.signalScore !== undefined ? `${pick.signalScore}/100` : "—"}
                                </td>
                                <td className="py-1 text-[10px] font-mono text-slate-400">{triggers || "—"}</td>
                                <td className="py-1">
                                  {pick.actualOutcome ? (
                                    <span className="text-emerald-400">Win</span>
                                  ) : (
                                    <span className="text-rose-400">Loss</span>
                                  )}
                                </td>
                                <td className={`py-1 text-right font-mono tabular-nums ${pick.pnlPercent > 0 ? 'text-emerald-400' : pick.pnlPercent < 0 ? 'text-rose-400' : 'text-slate-400'}`}>
                                  {pick.pnlPercent > 0 ? '+' : ''}{pick.pnlPercent}%
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Strongest Turn Bear Picks */}
                    <div>
                      <h4 className="text-sm font-semibold text-rose-400 mb-2 sticky top-0 bg-slate-800/90 py-1">
                        Top 10 Strongest Turn Bear
                      </h4>
                      <table className="w-full text-left text-xs text-slate-300">
                        <thead className="text-slate-400 border-b border-slate-700/50">
                          <tr>
                            <th className="py-1">Rank</th>
                            <th className="py-1">Symbol</th>
                            <th className="py-1">Laya Score</th>
                            <th className="py-1">Triggered</th>
                            <th className="py-1">Result</th>
                            <th className="py-1 text-right">Actual %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredAuditLogs[selectedAuditIdx].bearishPicks?.map((pick: any, idx: number) => {
                            const triggers = [
                              pick.indicators?.hmaFired && "D1",
                              pick.indicators?.stFired && "D2",
                              pick.indicators?.wtFired && "D3",
                              pick.indicators?.tsiFired && "D4",
                              pick.indicators?.htfFired && "RVOL"
                            ].filter(Boolean).join("·");
                            return (
                              <tr key={`${pick.symbol}-${idx}`} className="border-b border-slate-700/30 hover:bg-slate-800/50">
                                <td className="py-1 text-slate-500 font-mono">#{pick.rank}</td>
                                <td className="py-1 font-medium flex items-center gap-1">
                                  {pick.symbol}
                                  <a href={getTradingViewUrl(pick.symbol)} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-emerald-400 transition-colors">
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                </td>
                                <td className="py-1 font-mono text-rose-400">
                                  {pick.signalScore !== undefined ? `${pick.signalScore}/100` : "—"}
                                </td>
                                <td className="py-1 text-[10px] font-mono text-slate-400">{triggers || "—"}</td>
                                <td className="py-1">
                                  {pick.actualOutcome ? (
                                    <span className="text-emerald-400">Win</span>
                                  ) : (
                                    <span className="text-rose-400">Loss</span>
                                  )}
                                </td>
                                <td className={`py-1 text-right font-mono tabular-nums ${pick.pnlPercent > 0 ? 'text-emerald-400' : pick.pnlPercent < 0 ? 'text-rose-400' : 'text-slate-400'}`}>
                                  {pick.pnlPercent > 0 ? '+' : ''}{pick.pnlPercent}%
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-slate-500">
                  No Laya Pre-Turn audit logs available.
                </div>
              )}
            </div>

            {/* SECTION D: Prediction Disconnect Streaks for D5 Laya Pre-Turn Intel */}
            <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-5 flex flex-col h-[500px]">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Activity className="w-5 h-5 text-rose-400" />
                  <h3 className="font-bold text-slate-100">Prediction Disconnect Streaks</h3>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">Min Days:</span>
                  <select
                    value={minStreakDays}
                    onChange={(e) => setMinStreakDays(Number(e.target.value))}
                    className="bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-lg px-2 py-1 outline-none focus:border-rose-500"
                  >
                    <option value={2}>2 Days</option>
                    <option value={3}>3 Days</option>
                    <option value={4}>4 Days</option>
                    <option value={5}>5 Days</option>
                  </select>
                </div>
              </div>
              <div className="text-xs text-slate-400 mb-4 leading-relaxed">
                Symbols from the <span className="text-emerald-400 font-semibold">D5 Laya Pre-Turn Intel</span> column consistently predicted in one turn direction but experiencing opposite results for <span className="text-slate-200 font-bold">{minStreakDays}+ consecutive days</span>.
              </div>
              <div className="flex-1 overflow-auto">
                {streakData.length > 0 ? (
                  <table className="w-full text-left text-sm text-slate-300">
                    <thead className="text-slate-400 border-b border-slate-700/50 sticky top-0 bg-slate-800/90">
                      <tr>
                        <th className="py-2">Symbol</th>
                        <th className="py-2 text-center">Pre-Turn Call</th>
                        <th className="py-2 text-center">Streak (Days)</th>
                        <th className="py-2 text-right">Cum. PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {streakData.map((item, idx) => (
                        <tr key={idx} className="border-b border-slate-700/30 hover:bg-slate-800/50">
                          <td className="py-2 font-medium flex items-center gap-1">
                            {item.symbol}
                            <a href={getTradingViewUrl(item.symbol)} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-emerald-400 transition-colors">
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          </td>
                          <td className="py-2 text-center">
                            <span className={`text-xs font-semibold ${item.type === 'TURN BULL' ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {item.type}
                            </span>
                          </td>
                          <td className="py-2 text-center font-bold text-rose-400 font-mono">{item.streak}</td>
                          <td className={`py-2 text-right font-mono ${item.pnlSum > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {item.pnlSum > 0 ? '+' : ''}{item.pnlSum}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-slate-500 space-y-2">
                    <Activity className="w-8 h-8 opacity-20" />
                    <p>No active disconnect streaks ≥ {minStreakDays} days found.</p>
                  </div>
                )}
              </div>
            </div>

            {/* SECTION C: Self-Learning D5 Laya Pre-Turn Weight Matrix & RLCD Calibration */}
            <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-5 flex flex-col justify-between space-y-6">
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <BrainCircuit className="w-5 h-5 text-emerald-400" />
                  <h3 className="font-bold text-slate-100">
                    Self-Learning Laya Pre-Turn Matrix ({layaMode === "rvol_wick" ? "RVOL + Wick Climax" : "Standard Multi-TF"})
                  </h3>
                </div>
                <div className="space-y-2.5">
                  {[
                    { label: "D1 HMA 21 Pre-Turn Weight", val: Math.round(learnedState.dashboardWeights.d1_hma * 100), max: 45, unit: "%" },
                    { label: "D2 SuperTrend Pre-Turn Weight", val: Math.round(learnedState.dashboardWeights.d2_st * 100), max: 45, unit: "%" },
                    { label: "D3 WaveTrend Exhaustion Weight", val: Math.round(learnedState.dashboardWeights.d3_wt * 100), max: 45, unit: "%" },
                    { label: "D4 TSI Curl Pre-Turn Weight", val: Math.round(learnedState.dashboardWeights.d4_tsi * 100), max: 45, unit: "%" },
                    { label: "RVOL 1.8x+ Climax Absorption Logit", val: Math.round(learnedState.rlcdLogitWeights.rvolClimaxWeight * 40), max: 40, unit: " pts" },
                    { label: "Wick Rejection Tail Logit", val: Math.round(learnedState.rlcdLogitWeights.wickRejectionWeight * 40), max: 40, unit: " pts" },
                    { label: "Oscillator Stretch Logit", val: Math.round(learnedState.rlcdLogitWeights.oscillatorStretchWeight * 25), max: 40, unit: " pts" },
                    { label: "HTF Multi-Timeframe Confluence", val: Math.round(learnedState.rlcdLogitWeights.htfConfluenceWeight * 35), max: 40, unit: " pts" },
                    { label: "Low-Volume (<0.6x) Flag Penalty", val: Math.round(learnedState.rlcdLogitWeights.lowVolFlagPenalty * 35), max: 40, unit: " pts" },
                    { label: "Walk-Forward Pre-Turn Conversion Rate", val: Math.round(learnedState.overallPreTurnConversionPct), max: 100, unit: "%" },
                  ].map((rowItem) => {
                    const pct = Math.min(100, Math.round((rowItem.val / rowItem.max) * 100));
                    return (
                      <div key={rowItem.label} className="flex flex-col gap-1">
                        <div className="flex justify-between text-xs text-slate-400">
                          <span>{rowItem.label}</span>
                          <span className="font-mono tabular-nums text-emerald-300">
                            {rowItem.val}{rowItem.unit}
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-slate-700 rounded-full overflow-hidden">
                          <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {layaCalibration && (
                <div className="pt-4 border-t border-slate-700/80 space-y-2">
                  <div className="text-xs font-semibold text-slate-200">
                    Laya RLCD Strictly Proper Scoring Calibration
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs font-mono tabular-nums">
                    <div className="bg-slate-900/60 border border-slate-700/60 rounded-lg p-2.5">
                      <div className="text-[10px] text-slate-400 font-sans">Brier Score</div>
                      <div className="text-emerald-400 font-semibold mt-0.5">{layaCalibration.brierScore.toFixed(4)}</div>
                    </div>
                    <div className="bg-slate-900/60 border border-slate-700/60 rounded-lg p-2.5">
                      <div className="text-[10px] text-slate-400 font-sans">Log Loss</div>
                      <div className="text-indigo-300 font-semibold mt-0.5">{layaCalibration.logLoss.toFixed(4)}</div>
                    </div>
                    <div className="bg-slate-900/60 border border-slate-700/60 rounded-lg p-2.5">
                      <div className="text-[10px] text-slate-400 font-sans">Calib. ECE</div>
                      <div className="text-slate-200 font-semibold mt-0.5">{(layaCalibration.expectedCalibrationError * 100).toFixed(2)}%</div>
                    </div>
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                    Temperatures: choice={layaCalibration.temperature[0]} · score={layaCalibration.temperature[1]} · noul={layaCalibration.temperature[2]} ({layaCalibration.sampleCount} EOD samples)
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
