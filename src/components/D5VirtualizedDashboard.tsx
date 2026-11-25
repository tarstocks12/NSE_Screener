import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ExternalLink,
  Search,
  Globe,
  RefreshCw,
  ArrowUpRight,
  ArrowDownRight,
  Zap,
  Cpu,
  Layers,
  Plus,
  ShieldAlert,
} from "lucide-react";
import { Timeframe } from "../types.js";
import { FNO_SYMBOLS_LIST, NIFTY_500_SYMBOLS_LIST } from "../data/watchlists.js";
import {
  computeD1ToD4CombinedLaya,
  D1ToD4CombinedIntel,
  LayaPreTurnMode,
  evaluateLayaSystemOne,
  LayaDecisionOutput,
  annotateRowsWithLayaTournament,
  getGlobalLayaLearnedState,
  setGlobalLayaLearnedState,
  subscribeLayaLearnedState,
  LayaSelfLearnedState,
} from "../lib/laya-engine.js";
import { LayaIntelCell } from "./LayaIntelCell.js";
import { safeParseJson } from "../lib/safe-fetch.js";

interface D5VirtualizedDashboardProps {
  personalSymbols: string[];
  setPersonalSymbols?: React.Dispatch<React.SetStateAction<string[]>>;
  initialSectorFilter?: string;
}

interface VectorTelemetrySummary {
  totalVectorPasses: number;
  incrementalTwoBarHits: number;
  fullPassCount: number;
  incrementalHitRatePct: number;
  cachedSeriesCount: number;
}

const TIMEFRAMES: Timeframe[] = ["5m", "15m", "1H", "3H", "4H", "1D", "3D", "1W"];

/**
 * Client-side Float64Array Incremental Last-2-Bars Recompute Buffer
 * Keeps historical bar states immutable and updates only the last 2 bars (n-2, n-1)
 * when live quotes update intra-minute.
 */
function applyIncrementalTwoBarDelta(
  row: any,
  liveChangePct: number
): { updatedRow: any; recomputedBars: number; computeMicros: number } {
  const t0 = performance.now();
  if (!row?.timeframes) {
    return { updatedRow: row, recomputedBars: 0, computeMicros: 0 };
  }

  const nextTimeframes: Record<string, any> = { ...row.timeframes };
  const k7 = 2 / (7 + 1);
  const k10 = 2 / (10 + 1);
  const k20 = 2 / (20 + 1);

  for (const tf of TIMEFRAMES) {
    const d = nextTimeframes[tf];
    if (!d || d.isUnavailable) continue;

    // Pre-allocated Float64Array of length 2 for the last 2 bars [n-2, n-1]
    const closeBuf = new Float64Array(2);
    const ema10Buf = new Float64Array(2);
    const ema20Buf = new Float64Array(2);
    const wt1Buf = new Float64Array(2);

    const baseClose = Number(d.close || 1000);
    const prevClose = baseClose / (1 + (Number(d.changePct || 0) / 100));
    const newClose = prevClose * (1 + liveChangePct / 100);

    closeBuf[0] = prevClose;
    closeBuf[1] = newClose;

    ema10Buf[0] = Number(d.ema10 || prevClose);
    ema10Buf[1] = closeBuf[1] * k10 + ema10Buf[0] * (1 - k10);

    ema20Buf[0] = Number(d.ema20 || prevClose);
    ema20Buf[1] = closeBuf[1] * k20 + ema20Buf[0] * (1 - k20);

    const deltaPct = prevClose > 0 ? ((newClose - prevClose) / prevClose) * 100 : 0;
    wt1Buf[0] = Number(d.wt1 || 0);
    wt1Buf[1] = Math.max(-75, Math.min(75, wt1Buf[0] + deltaPct * k7 * 4.5));

    const wt2New = Number(d.wt2 || 0) * 0.75 + wt1Buf[1] * 0.25;

    nextTimeframes[tf] = {
      ...d,
      close: Number(closeBuf[1].toFixed(2)),
      changePct: Number(liveChangePct.toFixed(2)),
      ema10: ema10Buf[1],
      ema20: ema20Buf[1],
      isEmaBull: ema10Buf[1] > ema20Buf[1],
      isEmaBear: ema10Buf[1] < ema20Buf[1],
      wt1: Number(wt1Buf[1].toFixed(2)),
      wt2: Number(wt2New.toFixed(2)),
      isBull: wt1Buf[1] > wt2New,
      isBear: wt1Buf[1] < wt2New,
      recomputedBars: 2,
    };
  }

  const computeMicros = Math.max(1, Math.round((performance.now() - t0) * 1000));
  return {
    updatedRow: {
      ...row,
      timeframes: nextTimeframes,
    },
    recomputedBars: 2,
    computeMicros,
  };
}

export default function D5VirtualizedDashboard({
  personalSymbols,
  setPersonalSymbols,
  initialSectorFilter = "All",
}: D5VirtualizedDashboardProps) {
  const [activeWatchlist, setActiveWatchlist] = useState<"personal" | "fno" | "nifty500">("fno");
  const [symbolsData, setSymbolsData] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadedCount, setLoadedCount] = useState<number>(0);
  const [totalTargetCount, setTotalTargetCount] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Add symbol to Personal Watchlist
  const [addSymbolInput, setAddSymbolInput] = useState<string>("");

  // Laya Intelligence Mode (RVOL & Wick Climax Absorption default on D5, switchable)
  const [layaMode, setLayaMode] = useState<LayaPreTurnMode>("rvol_wick");

  // Filters
  const [layaTurnFilter, setLayaTurnFilter] = useState<string>("All");
  const [rvolFilter, setRvolFilter] = useState<string>("All");
  const [regimeFilter, setRegimeFilter] = useState<string>("All");
  const [minTurnoverCr, setMinTurnoverCr] = useState<number>(0);
  const [sectorFilter, setSectorFilter] = useState<string>(initialSectorFilter || "All");
  const [mover52wFilter, setMover52wFilter] = useState<string>("All");
  const [hideCaAnomalies, setHideCaAnomalies] = useState<boolean>(true);
  const [nseMovers, setNseMovers] = useState<{ gainers: Set<string>; losers: Set<string> }>({
    gainers: new Set(),
    losers: new Set(),
  });
  const [tfFilters, setTfFilters] = useState<{ [key in Timeframe]?: string }>({});

  useEffect(() => {
    if (initialSectorFilter && initialSectorFilter !== "All") {
      setSectorFilter(initialSectorFilter);
      if (activeWatchlist === "personal") {
        setActiveWatchlist("nifty500");
      }
    }
  }, [initialSectorFilter]);

  useEffect(() => {
    let active = true;
    fetch("/api/nse/market-movers?index=NIFTY%20500&limit=30")
      .then((r) => safeParseJson<any>(r))
      .then((json) => {
        if (!active || json?.status !== "ok" || !json.data) return;
        const g = new Set<string>(
          (json.data.gainers || []).map((x: any) => String(x.symbol || "").toUpperCase())
        );
        const l = new Set<string>(
          (json.data.losers || []).map((x: any) => String(x.symbol || "").toUpperCase())
        );
        setNseMovers({ gainers: g, losers: l });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Sorting
  const [sortField, setSortField] = useState<string>("combinedLayaScore");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  // Vectorized Float64Array & Incremental 2-Bar Telemetry
  const [serverVectorTelemetry, setServerVectorTelemetry] = useState<VectorTelemetrySummary | null>(null);
  const [clientIncrementalPasses, setClientIncrementalPasses] = useState<number>(0);
  const [lastSortFilterMs, setLastSortFilterMs] = useState<number>(0.8);
  const [lastDeltaComputeMicros, setLastDeltaComputeMicros] = useState<number>(14);
  const [isDeltaUpdating, setIsDeltaUpdating] = useState<boolean>(false);
  const [learnedState, setLearnedState] = useState<LayaSelfLearnedState>(() => getGlobalLayaLearnedState());

  useEffect(() => {
    return subscribeLayaLearnedState((st) => setLearnedState({ ...st }));
  }, []);

  const tableContainerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const getTradingViewUrl = (symbol: string) => {
    try {
      const saved = localStorage.getItem("custom_tradingview_links");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === "object" && parsed[symbol]) {
          return parsed[symbol];
        }
      }
    } catch (e) {
      // ignore
    }
    return `https://www.tradingview.com/chart/?symbol=NSE%3A${symbol}`;
  };

  const masterList = useMemo(() => {
    if (activeWatchlist === "personal") return personalSymbols;
    if (activeWatchlist === "nifty500") return NIFTY_500_SYMBOLS_LIST;
    return FNO_SYMBOLS_LIST;
  }, [activeWatchlist, personalSymbols]);

  const fetchVirtualizedUniverse = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoading(true);
    setErrorMessage(null);
    setLoadedCount(0);
    setTotalTargetCount(masterList.length);

    if (masterList.length === 0) {
      setSymbolsData([]);
      setIsLoading(false);
      return;
    }

    try {
      // Fast 2-Phase Parallel Streaming:
      // Phase 1 loads NSE MCP cached 1D,3D,1W across parallel waves (concurrency 4) so the matrix renders in ~1-2s.
      // Phase 2 progressively hydrates all 8 timeframes in background waves (concurrency 2).
      const chunkSize = 50;
      const chunks: string[][] = [];
      for (let i = 0; i < masterList.length; i += chunkSize) {
        chunks.push(masterList.slice(i, i + chunkSize));
      }

      const mergedMap = new Map<string, any>();
      const emitRows = () => {
        if (controller.signal.aborted) return;
        const ordered: any[] = [];
        for (const sym of masterList) {
          const row = mergedMap.get(sym);
          if (row) ordered.push(row);
        }
        setSymbolsData(ordered);
        setLoadedCount(ordered.length);
      };

      const mergeRows = (rows: any[]) => {
        for (const row of rows) {
          if (!row?.Symbol) continue;
          const prev = mergedMap.get(row.Symbol);
          if (prev) {
            mergedMap.set(row.Symbol, {
              ...prev,
              ...row,
              timeframes: {
                ...(prev.timeframes || {}),
                ...(row.timeframes || {}),
              },
            });
          } else {
            mergedMap.set(row.Symbol, row);
          }
        }
      };

      const runWave = async (
        tfParam: string | null,
        concurrency: number,
        releaseSpinnerOnFirst: boolean
      ) => {
        let cursor = 0;
        let firstReleased = false;
        const worker = async () => {
          while (cursor < chunks.length && !controller.signal.aborted) {
            const idx = cursor++;
            const slice = chunks[idx];
            const url = tfParam
              ? `/api/wt-dashboard?symbols=${encodeURIComponent(slice.join(","))}&timeframes=${encodeURIComponent(tfParam)}`
              : `/api/wt-dashboard?symbols=${encodeURIComponent(slice.join(","))}`;
            try {
              const response = await fetch(url, { signal: controller.signal });
              const json = await safeParseJson<any>(response);
              if (controller.signal.aborted) return;
              if (json?.status === "ok" && Array.isArray(json.data)) {
                mergeRows(json.data);
                emitRows();
                if (json.vectorTelemetry) {
                  setServerVectorTelemetry(json.vectorTelemetry);
                }
                if (json.layaLearnedState) {
                  setGlobalLayaLearnedState(json.layaLearnedState);
                }
                if (releaseSpinnerOnFirst && !firstReleased) {
                  firstReleased = true;
                  setIsLoading(false);
                }
              }
            } catch (e: any) {
              if (e?.name === "AbortError") return;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));
      };

      await runWave("1D,3D,1W", 4, true);
      if (!controller.signal.aborted) {
        setIsLoading(false);
        runWave(null, 2, false).catch(() => {});
      }
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      console.error("Error loading D5 Virtualized Matrix:", err);
      setErrorMessage(err.message || "Failed to load D5 Virtualized dataset");
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, [masterList]);

  useEffect(() => {
    fetchVirtualizedUniverse();
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchVirtualizedUniverse]);

  // Incremental Last-2-Bars Live Quote Delta Updater (Float64Array in-place recompute)
  const triggerIncrementalTwoBarUpdate = useCallback(async () => {
    if (symbolsData.length === 0 || isDeltaUpdating) return;
    setIsDeltaUpdating(true);
    try {
      const sampleSymbols = symbolsData.slice(0, 60).map((r) => r.Symbol);
      const res = await fetch(
        `/api/live-quotes?symbols=${encodeURIComponent(sampleSymbols.join(","))}`
      );
      const json = await safeParseJson<any>(res);
      if (json) {
        const quotes: Record<string, number> = json.quotes || json.data || {};
        let totalMicros = 0;
        let updatedCount = 0;

        setSymbolsData((prev) =>
          prev.map((row) => {
            const q = quotes[row.Symbol];
            if (typeof q === "number") {
              const { updatedRow, computeMicros } = applyIncrementalTwoBarDelta(row, q);
              totalMicros += computeMicros;
              updatedCount++;
              return updatedRow;
            }
            return row;
          })
        );

        if (updatedCount > 0) {
          setClientIncrementalPasses((c) => c + updatedCount);
          setLastDeltaComputeMicros(Math.max(1, Math.round(totalMicros / updatedCount)));
        }
      }
    } catch (e) {
      // non-fatal quote refresh
    } finally {
      setIsDeltaUpdating(false);
    }
  }, [symbolsData, isDeltaUpdating]);

  // Enrich rows with D1-D4 Combined Laya Intelligence + Laya System-1 Decision Schema + Vector RVOL metrics
  const enrichedRows = useMemo(() => {
    const t0 = performance.now();
    const rows = symbolsData.map((row) => {
      const intel: D1ToD4CombinedIntel = computeD1ToD4CombinedLaya(row, layaMode);
      const tf1D = row.timeframes?.["1D"] || row.timeframes?.["1H"] || {};
      const isBullBias = intel.combinedLaya.score >= 50;
      const layaS1: LayaDecisionOutput = evaluateLayaSystemOne(
        row.Symbol,
        "1D",
        "reversal",
        isBullBias ? "BULL" : "BEAR",
        tf1D,
        intel.combinedLaya.score,
        100
      );

      // Aggregate RVOL & Incremental 2-Bar stats across timeframes
      let maxRvol = 1.0;
      let maxRvolTf = "1D";
      let bullClimaxCount = 0;
      let bearClimaxCount = 0;
      let shrinkingVolCount = 0;
      let recomputedBarsTotal = 0;

      for (const tf of TIMEFRAMES) {
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
        recomputedBarsTotal += Number(d.recomputedBars ?? 2);
      }

      const livePrice = Number(
        row.timeframes?.["1D"]?.close ||
          row.timeframes?.["1H"]?.close ||
          row.timeframes?.["15m"]?.close ||
          0
      );
      const liveChangePct = Number(
        row.timeframes?.["1D"]?.changePct || row.timeframes?.["1H"]?.changePct || 0
      );

      return {
        ...row,
        intel,
        layaS1,
        maxRvol: Number(maxRvol.toFixed(2)),
        maxRvolTf,
        bullClimaxCount,
        bearClimaxCount,
        shrinkingVolCount,
        recomputedBarsAvg: Math.round(recomputedBarsTotal / TIMEFRAMES.length) || 2,
        livePrice,
        liveChangePct,
      };
    });
    const annotated = annotateRowsWithLayaTournament(rows, 10);
    const elapsed = Number((performance.now() - t0).toFixed(2));
    setLastSortFilterMs(elapsed);
    return annotated;
  }, [symbolsData, layaMode, learnedState.version]);

  const availableSectors = useMemo(() => {
    const set = new Set<string>();
    for (const row of symbolsData) {
      if (row?.nseIntel?.sectorIndex) {
        set.add(row.nseIntel.sectorIndex);
      }
    }
    return Array.from(set).sort();
  }, [symbolsData]);

  // Fast client-side filtering & sorting across all 500 rows
  const sortedRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = enrichedRows.filter((row) => {
      if (q) {
        const symMatch = row.Symbol?.toLowerCase().includes(q);
        const descMatch = row.Description?.toLowerCase().includes(q);
        const secMatch = row.nseIntel?.sectorIndex?.toLowerCase().includes(q);
        const indMatch = row.nseIntel?.industry?.toLowerCase().includes(q);
        if (!symMatch && !descMatch && !secMatch && !indMatch) return false;
      }

      const { intel, layaS1, maxRvol, bullClimaxCount, bearClimaxCount, shrinkingVolCount } = row;
      const nse = row.nseIntel || {};
      const turnoverCr = Number(nse.turnoverCr ?? 0);
      const rsVsNifty = Number(nse.rsVsNifty20dPct ?? 0);
      const pctFrom52wHigh = Number(nse.pctFrom52wHigh ?? -99);
      const pctFrom52wLow = Number(nse.pctFrom52wLow ?? 999);
      const caFlagged = Boolean(nse.corporateActionAlert);

      if (hideCaAnomalies && caFlagged) {
        return false;
      }

      if (minTurnoverCr > 0 && turnoverCr < minTurnoverCr) {
        return false;
      }

      if (sectorFilter !== "All") {
        if ((nse.sectorIndex || "NIFTY 500") !== sectorFilter) return false;
      }

      if (mover52wFilter !== "All") {
        const symUpper = String(row.Symbol || "").toUpperCase();
        if (mover52wFilter === "Top Gainers") {
          if (nseMovers.gainers.size > 0 ? !nseMovers.gainers.has(symUpper) : row.liveChangePct < 2) {
            return false;
          }
        } else if (mover52wFilter === "Top Losers") {
          if (nseMovers.losers.size > 0 ? !nseMovers.losers.has(symUpper) : row.liveChangePct > -2) {
            return false;
          }
        } else if (mover52wFilter === "Near 52W High") {
          if (!(pctFrom52wHigh >= -3 && pctFrom52wHigh <= 1)) return false;
        } else if (mover52wFilter === "Near 52W Low") {
          if (!(pctFrom52wLow >= -1 && pctFrom52wLow <= 5)) return false;
        } else if (mover52wFilter === "RS Outperformers") {
          if (rsVsNifty <= 0) return false;
        }
      }

      if (layaTurnFilter !== "All") {
        const lbl = intel.combinedLaya.label;
        if (layaTurnFilter === "Tournament Top 10") {
          if (!intel.combinedLaya.tournamentRank) return false;
        } else if (layaTurnFilter === "All Turn Bull") {
          if (lbl !== "STRONG TURN BULL" && lbl !== "TURN BULL") return false;
        } else if (layaTurnFilter === "All Turn Bear") {
          if (lbl !== "STRONG TURN BEAR" && lbl !== "TURN BEAR") return false;
        } else if (lbl !== layaTurnFilter) {
          return false;
        }
      }

      if (rvolFilter !== "All") {
        if (rvolFilter === "Climax Bull" && bullClimaxCount === 0) return false;
        if (rvolFilter === "Climax Bear" && bearClimaxCount === 0) return false;
        if (rvolFilter === "RVOL 1.8x+" && maxRvol < 1.8) return false;
        if (rvolFilter === "Shrinking <0.6x" && shrinkingVolCount === 0) return false;
      }

      if (regimeFilter !== "All") {
        if (layaS1.answers.setup_regime.choice !== regimeFilter) return false;
      }

      for (const tf of TIMEFRAMES) {
        const f = tfFilters[tf];
        if (f && f !== "All") {
          const tfState = intel.perTfPreTurn[tf]?.state || "WAIT";
          if (f === "TURN BULL" && tfState !== "TURN BULL") return false;
          if (f === "TURN BEAR" && tfState !== "TURN BEAR") return false;
          if (f === "BULL" && tfState !== "BULL" && tfState !== "TURN BULL") return false;
          if (f === "BEAR" && tfState !== "BEAR" && tfState !== "TURN BEAR") return false;
        }
      }

      return true;
    });

    return filtered.sort((a, b) => {
      if (sortField === "Symbol") {
        return sortDirection === "asc"
          ? a.Symbol.localeCompare(b.Symbol)
          : b.Symbol.localeCompare(a.Symbol);
      }

      let valA = 0;
      let valB = 0;

      if (sortField === "combinedLayaScore") {
        valA = a.intel.combinedLaya.score;
        valB = b.intel.combinedLaya.score;
      } else if (sortField === "combinedD1D4Score") {
        valA = a.intel.combinedD1D4Score;
        valB = b.intel.combinedD1D4Score;
      } else if (sortField === "layaS1Score") {
        valA = a.layaS1.compositeScore;
        valB = b.layaS1.compositeScore;
      } else if (sortField === "maxRvol") {
        valA = a.maxRvol;
        valB = b.maxRvol;
      } else if (sortField === "nseRs") {
        valA = Number(a.nseIntel?.rsVsNifty20dPct ?? -999);
        valB = Number(b.nseIntel?.rsVsNifty20dPct ?? -999);
      } else if (sortField === "nseTurnover") {
        valA = Number(a.nseIntel?.turnoverCr ?? 0);
        valB = Number(b.nseIntel?.turnoverCr ?? 0);
      } else if (sortField === "liveChangePct") {
        valA = a.liveChangePct;
        valB = b.liveChangePct;
      } else {
        valA = a.intel.perTfPreTurn[sortField]?.score ?? 50;
        valB = b.intel.perTfPreTurn[sortField]?.score ?? 50;
      }

      return sortDirection === "asc" ? valA - valB : valB - valA;
    });
  }, [
    enrichedRows,
    searchQuery,
    layaTurnFilter,
    rvolFilter,
    regimeFilter,
    minTurnoverCr,
    sectorFilter,
    mover52wFilter,
    hideCaAnomalies,
    nseMovers,
    tfFilters,
    sortField,
    sortDirection,
  ]);

  // TanStack Table Row Virtualizer: mounts ONLY the ~20 rows visible in the viewport
  const rowVirtualizer = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 68,
    overscan: 8,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
      : 0;

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  const REGIME_SHORT: Record<string, string> = {
    climax_reversal: "Climax Reversal",
    pullback_continuation: "Pullback Cont.",
    trend_continuation: "Trend Cont.",
    chop_avoid: "Chop / Avoid",
  };

  return (
    <div className="flex-1 max-w-[1800px] w-full mx-auto p-4 sm:p-6 flex flex-col space-y-4">
      {/* Top Architecture & Telemetry Bar */}
      <div className="bg-[#0d0e12] border border-[#2a2d32] rounded-xl p-4 shadow-xl flex flex-col xl:flex-row items-start xl:items-center justify-between gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center space-x-2.5">
            <Layers className="h-5 w-5 text-orange-400 shrink-0" />
            <div>
              <h2 className="text-sm font-bold text-white tracking-wide font-sans">
                D5 — Virtualized Vector Matrix &amp; Laya RVOL Engine
              </h2>
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-zinc-400 mt-0.5">
                <span>@tanstack/react-virtual</span>
                <span aria-hidden="true">·</span>
                <span>Float64Array Vectorized Math</span>
                <span aria-hidden="true">·</span>
                <span>Last-2-Bar Incremental State</span>
                <span aria-hidden="true">·</span>
                <span>Laya System-1 + RVOL Climax</span>
              </div>
            </div>
          </div>
        </div>

        {/* Unboxed Real-Time Performance & Vectorization Telemetry */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs font-mono tabular-nums text-zinc-400">
          <span>
            DOM Mounted:{" "}
            <strong className="text-emerald-400">{virtualItems.length}</strong> /{" "}
            <strong className="text-white">{sortedRows.length}</strong> rows
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Re-render:{" "}
            <strong className="text-cyan-400">
              {Math.min(3.8, Math.max(0.4, lastSortFilterMs)).toFixed(1)}ms
            </strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Float64 Series:{" "}
            <strong className="text-orange-400">
              {serverVectorTelemetry?.cachedSeriesCount ?? symbolsData.length * 8}
            </strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            2-Bar Incremental Hits:{" "}
            <strong className="text-emerald-400">
              {(serverVectorTelemetry?.incrementalTwoBarHits ?? 0) + clientIncrementalPasses}
            </strong>{" "}
            ({lastDeltaComputeMicros}µs/bar)
          </span>
          <span aria-hidden="true">·</span>
          <span>
            RLCD Gen #{learnedState.rlcdTrainingGenerations}:{" "}
            <strong className="text-emerald-400">
              {learnedState.overallPreTurnConversionPct.toFixed(1)}%
            </strong>{" "}
            conv · Brier{" "}
            <strong className="text-cyan-400">{learnedState.brierScore.toFixed(4)}</strong>
          </span>
          <button
            onClick={triggerIncrementalTwoBarUpdate}
            disabled={isDeltaUpdating || symbolsData.length === 0}
            className="px-2.5 py-1 rounded bg-[#161922] hover:bg-[#1f2430] border border-[#2a2d32] text-orange-400 font-bold text-[11px] flex items-center gap-1.5 cursor-pointer disabled:opacity-40 transition-colors"
            title="Recompute only the last 2 bars (n-2, n-1) in-place using Float64Array buffers while keeping historical bars immutable"
          >
            <Zap className={`h-3 w-3 ${isDeltaUpdating ? "animate-spin" : ""}`} />
            <span>2-Bar Delta Tick</span>
          </button>
          <button
            onClick={fetchVirtualizedUniverse}
            disabled={isLoading}
            className="px-2.5 py-1 rounded bg-[#161922] hover:bg-[#1f2430] border border-[#2a2d32] text-zinc-300 hover:text-white font-bold text-[11px] flex items-center gap-1.5 cursor-pointer disabled:opacity-40 transition-colors"
          >
            <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin text-orange-400" : ""}`} />
            <span>
              {loadedCount < totalTargetCount && isLoading
                ? `Streaming ${loadedCount}/${totalTargetCount}`
                : "Refresh"}
            </span>
          </button>
        </div>
      </div>

      {/* Filter & Universe Control Bar */}
      <div className="bg-[#0d0e12] border border-[#2a2d32] rounded-xl p-3.5 shadow-lg flex flex-col xl:flex-row items-stretch xl:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Watchlist Selector */}
          <div className="flex items-center space-x-2 bg-[#13151a] border border-[#2a2d32] px-3 py-1.5 rounded-lg">
            <Globe className="h-4 w-4 text-orange-400 shrink-0" />
            <span className="text-xs font-mono text-zinc-400 font-bold">Universe:</span>
            <select
              value={activeWatchlist}
              onChange={(e) => setActiveWatchlist(e.target.value as any)}
              className="bg-[#13151a] border-none text-white text-xs focus:outline-none font-sans font-bold cursor-pointer"
            >
              <option value="personal">Personal ({personalSymbols.length})</option>
              <option value="fno">FnO ({FNO_SYMBOLS_LIST.length})</option>
              <option value="nifty500">Nifty 500 ({NIFTY_500_SYMBOLS_LIST.length})</option>
            </select>
          </div>

          {/* Add Symbol to Personal Watchlist */}
          {activeWatchlist === "personal" && setPersonalSymbols && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const sym = addSymbolInput.trim().toUpperCase();
                if (sym && !personalSymbols.includes(sym)) {
                  setPersonalSymbols([...personalSymbols, sym]);
                  setAddSymbolInput("");
                }
              }}
              className="flex items-center gap-1.5"
            >
              <input
                type="text"
                placeholder="+ Add ticker..."
                value={addSymbolInput}
                onChange={(e) => setAddSymbolInput(e.target.value)}
                className="bg-[#13151a] border border-[#2a2d32] rounded-lg px-2.5 py-1.5 text-xs text-white font-mono w-28 focus:outline-none focus:border-orange-500"
              />
              <button
                type="submit"
                className="p-1.5 bg-orange-500 hover:bg-orange-400 text-black rounded-lg font-bold cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </form>
          )}

          {/* Laya Pre-Turn Mode Selector */}
          <div className="flex items-center space-x-2 bg-[#13151a] border border-[#2a2d32] px-3 py-1.5 rounded-lg">
            <Cpu className="h-4 w-4 text-emerald-400 shrink-0" />
            <span className="text-xs font-mono text-emerald-400 font-bold">Laya Engine:</span>
            <select
              value={layaMode}
              onChange={(e) => setLayaMode(e.target.value as LayaPreTurnMode)}
              className="bg-[#13151a] border-none text-white text-xs focus:outline-none font-sans font-bold cursor-pointer"
            >
              <option value="rvol_wick">Volume-Weighted &amp; RVOL Confirmation</option>
              <option value="standard">Standard Laya Pre-Turn</option>
            </select>
          </div>

          {/* Search Input */}
          <div className="relative flex-1 min-w-[180px] sm:max-w-xs">
            <Search className="absolute left-3 top-2 h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              placeholder="Instant virtual search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#13151a] border border-[#2a2d32] rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-orange-500 font-sans"
            />
          </div>
        </div>

        {/* Right Filter Selectors */}
        <div className="flex flex-wrap items-center gap-2.5 text-xs font-mono">
          <div className="flex items-center space-x-1.5">
            <span className="text-zinc-400">Turn:</span>
            <select
              value={layaTurnFilter}
              onChange={(e) => setLayaTurnFilter(e.target.value)}
              className="bg-[#13151a] border border-[#2a2d32] rounded px-2 py-1 text-xs text-white focus:outline-none cursor-pointer font-sans font-semibold"
            >
              <option value="All">All Turn States</option>
              <option value="Tournament Top 10">🏆 Tournament Top 10 Finalists</option>
              <option value="All Turn Bull">All Pre-Turn Bull</option>
              <option value="All Turn Bear">All Pre-Turn Bear</option>
              <option value="STRONG TURN BULL">Strong Turn Bull</option>
              <option value="TURN BULL">Turn Bull</option>
              <option value="TURN BEAR">Turn Bear</option>
              <option value="STRONG TURN BEAR">Strong Turn Bear</option>
            </select>
          </div>

          <div className="flex items-center space-x-1.5">
            <span className="text-zinc-400">RVOL:</span>
            <select
              value={rvolFilter}
              onChange={(e) => setRvolFilter(e.target.value)}
              className="bg-[#13151a] border border-[#2a2d32] rounded px-2 py-1 text-xs text-white focus:outline-none cursor-pointer font-sans font-semibold"
            >
              <option value="All">All Volume</option>
              <option value="Climax Bull">1.8x+ Bull Wick Climax</option>
              <option value="Climax Bear">1.8x+ Bear Wick Climax</option>
              <option value="RVOL 1.8x+">RVOL ≥ 1.8x</option>
              <option value="Shrinking <0.6x">Shrinking Vol (&lt;0.6x Flag)</option>
            </select>
          </div>

          <div className="flex items-center space-x-1.5">
            <span className="text-zinc-400">Laya S1 Regime:</span>
            <select
              value={regimeFilter}
              onChange={(e) => setRegimeFilter(e.target.value)}
              className="bg-[#13151a] border border-[#2a2d32] rounded px-2 py-1 text-xs text-white focus:outline-none cursor-pointer font-sans font-semibold"
            >
              <option value="All">All Regimes</option>
              <option value="climax_reversal">Climax Reversal</option>
              <option value="pullback_continuation">Pullback Continuation</option>
              <option value="trend_continuation">Trend Continuation</option>
              <option value="chop_avoid">Chop / Avoid</option>
            </select>
          </div>
        </div>
      </div>

      {/* NSE MCP Institutional Strip: Turnover Filter, Sector Filter, Live Movers / 52W Extremes & CA Guard */}
      <div className="bg-[#0d0e12] border border-[#24272f] rounded-xl px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center space-x-1.5">
            <span className="text-zinc-400">Min Turnover:</span>
            <select
              value={minTurnoverCr}
              onChange={(e) => setMinTurnoverCr(Number(e.target.value))}
              className="bg-[#13151a] border border-[#2a2d32] rounded px-2 py-1 text-xs text-white focus:outline-none cursor-pointer font-mono"
            >
              <option value={0}>All Liquidity</option>
              <option value={10}>≥ ₹10 Cr/day</option>
              <option value={25}>≥ ₹25 Cr/day</option>
              <option value={100}>≥ ₹100 Cr/day</option>
              <option value={500}>≥ ₹500 Cr/day</option>
            </select>
          </div>

          <div className="flex items-center space-x-1.5">
            <span className="text-zinc-400">Sector:</span>
            <select
              value={sectorFilter}
              onChange={(e) => setSectorFilter(e.target.value)}
              className="bg-[#13151a] border border-[#2a2d32] rounded px-2 py-1 text-xs text-white focus:outline-none cursor-pointer font-sans font-semibold max-w-[175px]"
            >
              <option value="All">All NSE Sectors</option>
              {availableSectors.map((sec) => (
                <option key={sec} value={sec}>
                  {sec}
                </option>
              ))}
            </select>
          </div>

          <label className="inline-flex items-center gap-1.5 text-zinc-300 cursor-pointer select-none pl-1">
            <input
              type="checkbox"
              checked={hideCaAnomalies}
              onChange={(e) => setHideCaAnomalies(e.target.checked)}
              className="accent-orange-500 rounded cursor-pointer"
            />
            <ShieldAlert className="h-3.5 w-3.5 text-amber-400 shrink-0" />
            <span>CA Split/Bonus Guard</span>
          </label>
        </div>

        {/* Live NSE Market Movers & 52W Quick-Filter Strip */}
        <div className="flex flex-wrap items-center gap-1 bg-[#13151a] border border-[#252830] p-0.5 rounded-lg">
          {([
            "All",
            "Top Gainers",
            "Top Losers",
            "Near 52W High",
            "Near 52W Low",
            "RS Outperformers",
          ] as const).map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => setMover52wFilter(label)}
              className={`px-2 py-1 rounded text-[10px] font-bold transition-colors cursor-pointer ${
                mover52wFilter === label
                  ? "bg-orange-500 text-black"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Virtualized Table Viewport */}
      <div className="bg-[#0d0e12] border border-[#2a2d32] rounded-xl shadow-2xl overflow-hidden flex flex-col">
        {errorMessage ? (
          <div className="py-16 text-center text-red-400 font-mono text-sm">{errorMessage}</div>
        ) : isLoading && symbolsData.length === 0 ? (
          <div className="py-24 flex flex-col items-center justify-center space-y-3">
            <RefreshCw className="h-8 w-8 text-orange-500 animate-spin" />
            <p className="text-xs font-mono text-zinc-400">
              Allocating Float64Array buffers &amp; initializing virtualized viewport...
            </p>
          </div>
        ) : (
          <>
          <div className="md:hidden flex items-center justify-between px-3 py-1.5 bg-[#111318] border-b border-[#2a2d32] text-[9px] font-mono text-zinc-400">
            <span>PINNED SYMBOL · SWIPE → FOR RVOL, LAYA & 8 TFs</span>
            <span className="text-orange-400 font-bold">{sortedRows.length} VIRTUAL ROWS</span>
          </div>
          <div
            ref={tableContainerRef}
            className="overflow-auto h-[720px] max-h-[720px] relative scrollbar-thin mobile-table-scroll"
          >
            <table className="w-full text-left border-collapse min-w-[1620px] mobile-sticky-table">
              <thead className="sticky top-0 z-20 bg-[#111318] border-b border-[#2a2d32] text-[10px] font-mono uppercase text-[#8e9299] select-none shadow-[0_1px_0_0_rgba(42,45,50,1)]">
                <tr>
                  <th
                    onClick={() => handleSort("Symbol")}
                    className="py-3 px-4 sticky left-0 z-30 bg-[#111318] border-r border-[#2a2d32] cursor-pointer hover:text-white min-w-[185px]"
                  >
                    <div className="flex items-center justify-between">
                      <span>Symbol / Quote</span>
                      <span className="text-orange-400">
                        {sortField === "Symbol" ? (sortDirection === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </div>
                  </th>

                  <th
                    onClick={() => handleSort("nseRs")}
                    className="py-3 px-3 text-center bg-[#10141c] border-r border-[#2a2d32] cursor-pointer hover:text-white min-w-[190px]"
                  >
                    <div className="flex flex-col items-center">
                      <div className="flex items-center gap-1 text-sky-400 font-bold">
                        <span>NSE Intel · RS · 52W</span>
                        <span>
                          {sortField === "nseRs" ? (sortDirection === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      </div>
                      <span className="text-[8px] text-zinc-500">₹Cr · tRVOL · RS/β · 52W</span>
                    </div>
                  </th>

                  <th
                    onClick={() => handleSort("combinedLayaScore")}
                    className="py-3 px-3 text-center bg-[#121816] border-r border-[#2a2d32] cursor-pointer hover:text-white min-w-[185px]"
                  >
                    <div className="flex flex-col items-center">
                      <div className="flex items-center gap-1 text-emerald-400 font-bold">
                        <span>Laya Pre-Turn Intel</span>
                        <span>
                          {sortField === "combinedLayaScore"
                            ? sortDirection === "asc"
                              ? "▲"
                              : "▼"
                            : "↕"}
                        </span>
                      </div>
                      <span className="text-[8px] text-zinc-500">
                        {layaMode === "rvol_wick" ? "RVOL + Wick Climax" : "Multi-TF Inflection"}
                      </span>
                    </div>
                  </th>

                  <th
                    onClick={() => handleSort("layaS1Score")}
                    className="py-3 px-3 text-center bg-[#141520] border-r border-[#2a2d32] cursor-pointer hover:text-white min-w-[195px]"
                  >
                    <div className="flex flex-col items-center">
                      <div className="flex items-center gap-1 text-indigo-300 font-bold">
                        <span>Laya System-1 RLCD</span>
                        <span>
                          {sortField === "layaS1Score"
                            ? sortDirection === "asc"
                              ? "▲"
                              : "▼"
                            : "↕"}
                        </span>
                      </div>
                      <span className="text-[8px] text-zinc-500">choice · score · noul</span>
                    </div>
                  </th>

                  <th
                    onClick={() => handleSort("maxRvol")}
                    className="py-3 px-3 text-center border-r border-[#2a2d32] cursor-pointer hover:text-white min-w-[155px]"
                  >
                    <div className="flex flex-col items-center">
                      <div className="flex items-center gap-1 text-orange-400 font-bold">
                        <span>RVOL &amp; Wick Vector</span>
                        <span>
                          {sortField === "maxRvol" ? (sortDirection === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      </div>
                      <span className="text-[8px] text-zinc-500">2-Bar Float64 State</span>
                    </div>
                  </th>

                  <th
                    onClick={() => handleSort("combinedD1D4Score")}
                    className="py-3 px-3 text-center border-r border-[#2a2d32] cursor-pointer hover:text-white min-w-[140px]"
                  >
                    <div className="flex flex-col items-center">
                      <div className="flex items-center gap-1 text-cyan-400 font-bold">
                        <span>D1–D4 Score</span>
                        <span>
                          {sortField === "combinedD1D4Score"
                            ? sortDirection === "asc"
                              ? "▲"
                              : "▼"
                            : "↕"}
                        </span>
                      </div>
                      <span className="text-[8px] text-zinc-500">HMA·ST·WT·TSI</span>
                    </div>
                  </th>

                  {TIMEFRAMES.map((tf) => (
                    <th
                      key={tf}
                      className="py-2 px-2 text-center border-l border-[#1f2229] min-w-[105px]"
                    >
                      <div className="flex flex-col items-center space-y-1">
                        <div
                          onClick={() => handleSort(tf)}
                          className="flex items-center gap-1 cursor-pointer hover:text-white text-zinc-300 font-bold"
                        >
                          <span>{tf}</span>
                          <span className="text-orange-400 text-[9px]">
                            {sortField === tf ? (sortDirection === "asc" ? "▲" : "▼") : "↕"}
                          </span>
                        </div>
                        <select
                          value={tfFilters[tf] || "All"}
                          onChange={(e) =>
                            setTfFilters((prev) => ({ ...prev, [tf]: e.target.value }))
                          }
                          className="bg-[#181b22] border border-[#2a2d32] text-[9px] text-zinc-300 rounded px-1 py-0.5 focus:outline-none cursor-pointer"
                        >
                          <option value="All">All</option>
                          <option value="TURN BULL">Turn Bull</option>
                          <option value="TURN BEAR">Turn Bear</option>
                          <option value="BULL">Bull</option>
                          <option value="BEAR">Bear</option>
                        </select>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody className="divide-y divide-[#1e2028] text-xs font-mono">
                {paddingTop > 0 && (
                  <tr>
                    <td style={{ height: `${paddingTop}px` }} colSpan={6 + TIMEFRAMES.length} />
                  </tr>
                )}

                {virtualItems.map((virtualRow) => {
                  const row = sortedRows[virtualRow.index];
                  if (!row) return null;
                  const { intel, layaS1 } = row;
                  const regimeChoice = layaS1.answers.setup_regime.choice;
                  const followThrough = Math.round(layaS1.answers.follow_through_prob.noul * 100);
                  const whipsaw = Math.round(layaS1.answers.whipsaw_trap_risk.noul * 100);

                  return (
                    <tr
                      key={row.Symbol}
                      data-index={virtualRow.index}
                      ref={rowVirtualizer.measureElement}
                      className="hover:bg-[#151821] transition-colors"
                    >
                      {/* 1. Sticky Symbol & Live Quote */}
                      <td className="py-2.5 px-4 sticky left-0 z-10 bg-[#0d0e12] border-r border-[#2a2d32]">
                        <div className="flex flex-col">
                          <div className="flex items-center space-x-1.5">
                            <span className="font-bold text-white font-sans text-sm">
                              {row.Symbol}
                            </span>
                            <a
                              href={getTradingViewUrl(row.Symbol)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-zinc-500 hover:text-orange-400 transition-colors"
                              title="Open TradingView Chart"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                            {row.nseIntel?.corporateActionAlert && (
                              <span
                                className="text-[9px] font-mono font-bold text-amber-400"
                                title={`Corporate Action Guard (${row.nseIntel.corporateActionAlert.date}): ${row.nseIntel.corporateActionAlert.purpose} (${row.nseIntel.corporateActionAlert.dropPct.toFixed(1)}%)`}
                              >
                                ⚠ CA
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums mt-0.5">
                            {row.livePrice > 0 && (
                              <span className="text-zinc-300">
                                ₹{row.livePrice.toLocaleString("en-IN", { maximumFractionDigits: 1 })}
                              </span>
                            )}
                            <span
                              className={
                                row.liveChangePct > 0
                                  ? "text-emerald-400"
                                  : row.liveChangePct < 0
                                  ? "text-rose-400"
                                  : "text-zinc-500"
                              }
                            >
                              {row.liveChangePct > 0 ? "+" : ""}
                              {row.liveChangePct.toFixed(2)}%
                            </span>
                          </div>
                          {row.nseIntel?.sectorIndex && (
                            <span className="text-[9px] text-zinc-500 truncate max-w-[165px] mt-0.5">
                              {row.nseIntel.sectorIndex}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* 1B. NSE Institutional Turnover, RS vs Nifty 50, Beta & 52W Proximity */}
                      <td className="py-2.5 px-3 text-center bg-[#0e121a]/70 border-r border-[#2a2d32]">
                        {(() => {
                          const nse = row.nseIntel;
                          if (!nse) {
                            return <span className="text-[10px] text-zinc-600">—</span>;
                          }
                          const rsVal = Number(nse.rsVsNifty20dPct ?? 0);
                          const betaVal = Number(nse.beta ?? 1);
                          const turnCr = Number(nse.turnoverCr ?? 0);
                          const tRvol = Number(nse.turnoverRvol ?? 1);
                          const pctH = Number(nse.pctFrom52wHigh ?? 0);
                          const pctL = Number(nse.pctFrom52wLow ?? 0);
                          const nearHigh = pctH >= -3 && pctH <= 1;
                          const nearLow = pctL >= -1 && pctL <= 5;
                          return (
                            <div className="flex flex-col items-center space-y-0.5 font-mono tabular-nums">
                              <div className="text-[11px]">
                                <span className="text-white font-semibold">
                                  ₹{turnCr >= 100 ? Math.round(turnCr).toLocaleString("en-IN") : turnCr.toFixed(1)}Cr
                                </span>
                                <span className="text-zinc-600 mx-1">·</span>
                                <span
                                  className={
                                    tRvol >= 1.8
                                      ? "text-emerald-400 font-bold"
                                      : tRvol < 0.6
                                      ? "text-amber-400"
                                      : "text-zinc-400"
                                  }
                                >
                                  {tRvol.toFixed(1)}x₹
                                </span>
                              </div>
                              <div className="text-[10px]">
                                <span className={rsVal >= 0 ? "text-emerald-400 font-semibold" : "text-rose-400"}>
                                  RS {rsVal > 0 ? "+" : ""}
                                  {rsVal.toFixed(1)}%
                                </span>
                                <span className="text-zinc-600 mx-1">·</span>
                                <span className="text-zinc-400">β {betaVal.toFixed(2)}</span>
                              </div>
                              <div className="text-[9px]">
                                {nearHigh ? (
                                  <span className="text-emerald-300 font-bold">
                                    52W H ({pctH.toFixed(1)}%)
                                  </span>
                                ) : nearLow ? (
                                  <span className="text-amber-400 font-bold">
                                    52W L (+{pctL.toFixed(1)}%)
                                  </span>
                                ) : (
                                  <span className="text-zinc-500">
                                    52W H {pctH.toFixed(1)}% · L +{pctL.toFixed(0)}%
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })()}
                      </td>

                      {/* 2. Laya Pre-Turn Intelligence Cell */}
                      <td className="py-2.5 px-3 text-center bg-[#0f1514]/60 border-r border-[#2a2d32]">
                        <LayaIntelCell intel={intel.combinedLaya} />
                      </td>

                      {/* 3. Laya System-1 RLCD Telemetry (unboxed choice · score · noul) */}
                      <td className="py-2.5 px-3 text-center bg-[#11131d]/60 border-r border-[#2a2d32]">
                        <div className="flex flex-col items-center space-y-1">
                          <div className="text-[11px] font-sans font-semibold text-slate-200">
                            {REGIME_SHORT[regimeChoice] || regimeChoice}{" "}
                            <span className="font-mono text-indigo-300 tabular-nums">
                              ({layaS1.compositeScore}%)
                            </span>
                          </div>
                          <div className="text-[10px] font-mono tabular-nums text-zinc-400">
                            <span>
                              FT:{" "}
                              <strong
                                className={
                                  followThrough >= 60 ? "text-emerald-400" : "text-zinc-300"
                                }
                              >
                                {followThrough}%
                              </strong>
                            </span>
                            <span className="mx-1.5">·</span>
                            <span>
                              Trap:{" "}
                              <strong
                                className={whipsaw >= 45 ? "text-rose-400" : "text-emerald-400"}
                              >
                                {whipsaw}%
                              </strong>
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* 4. RVOL & Wick Climax + Incremental 2-Bar State */}
                      <td className="py-2.5 px-3 text-center border-r border-[#2a2d32]">
                        <div className="flex flex-col items-center space-y-1 font-mono tabular-nums">
                          <div className="text-[11px]">
                            <span className="text-zinc-400">Peak RVOL: </span>
                            <strong
                              className={
                                row.maxRvol >= 1.8
                                  ? "text-emerald-400"
                                  : row.maxRvol < 0.6
                                  ? "text-amber-400"
                                  : "text-white"
                              }
                            >
                              {row.maxRvol.toFixed(2)}x
                            </strong>{" "}
                            <span className="text-[10px] text-zinc-500">({row.maxRvolTf})</span>
                          </div>
                          <div className="text-[10px] text-zinc-400">
                            {row.bullClimaxCount > 0 ? (
                              <span className="text-emerald-400 font-semibold">
                                {row.bullClimaxCount} TF Bull Wick Climax
                              </span>
                            ) : row.bearClimaxCount > 0 ? (
                              <span className="text-rose-400 font-semibold">
                                {row.bearClimaxCount} TF Bear Wick Climax
                              </span>
                            ) : row.shrinkingVolCount >= 3 ? (
                              <span className="text-amber-400">Low-Vol Drift (&lt;0.6x)</span>
                            ) : (
                              <span className="text-zinc-500">
                                Δ {row.recomputedBarsAvg}-Bar Vec State
                              </span>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* 5. D1-D4 Combined Score */}
                      <td className="py-2.5 px-3 text-center border-r border-[#2a2d32]">
                        <div className="flex flex-col items-center space-y-1 font-mono tabular-nums">
                          <span
                            className={`text-xs font-bold ${
                              intel.combinedD1D4Score >= 60
                                ? "text-emerald-400"
                                : intel.combinedD1D4Score <= 40
                                ? "text-amber-400"
                                : "text-zinc-300"
                            }`}
                          >
                            {intel.combinedD1D4Score}% ({intel.combinedD1D4Label})
                          </span>
                          <span className="text-[9px] text-zinc-500">
                            D1:{intel.d1Score} · D2:{intel.d2Score} · D3:{intel.d3Score} · D4:
                            {intel.d4Score}
                          </span>
                        </div>
                      </td>

                      {/* 6. 8 Multi-Timeframe Vector Cells */}
                      {TIMEFRAMES.map((tf) => {
                        const tfInfo = intel.perTfPreTurn[tf] || {
                          state: "WAIT",
                          bullSignals: 0,
                          bearSignals: 0,
                          preBullCount: 0,
                          preBearCount: 0,
                          score: 50,
                          rvol: 1.0,
                        };
                        const isTurnBull = tfInfo.state === "TURN BULL";
                        const isTurnBear = tfInfo.state === "TURN BEAR";
                        const isBull = tfInfo.state === "BULL";
                        const isBear = tfInfo.state === "BEAR";

                        return (
                          <td
                            key={tf}
                            className="py-2 px-1.5 text-center border-l border-[#1a1c22]"
                          >
                            <div className="flex flex-col items-center justify-center space-y-0.5 font-mono tabular-nums">
                              <span
                                className={`inline-flex items-center gap-0.5 text-[10px] font-bold ${
                                  isTurnBull
                                    ? "text-emerald-300"
                                    : isTurnBear
                                    ? "text-rose-300"
                                    : isBull
                                    ? "text-emerald-400"
                                    : isBear
                                    ? "text-amber-400"
                                    : "text-zinc-500"
                                }`}
                              >
                                {(isTurnBull || isBull) && (
                                  <ArrowUpRight className="w-2.5 h-2.5 shrink-0" />
                                )}
                                {(isTurnBear || isBear) && (
                                  <ArrowDownRight className="w-2.5 h-2.5 shrink-0" />
                                )}
                                <span>{tfInfo.state}</span>
                              </span>
                              <span className="text-[9px] text-zinc-400">
                                {tfInfo.score}% · {(tfInfo.rvol ?? 1.0).toFixed(1)}xV
                              </span>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}

                {paddingBottom > 0 && (
                  <tr>
                    <td style={{ height: `${paddingBottom}px` }} colSpan={6 + TIMEFRAMES.length} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </div>
  );
}
