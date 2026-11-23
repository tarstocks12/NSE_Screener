import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  RefreshCw,
  ExternalLink,
  Search,
  ArrowUpRight,
  ArrowDownRight,
  Layers,
  Filter,
  TrendingUp,
  TrendingDown,
  BarChart3
} from "lucide-react";

type RotationQuadrant = "Leading" | "Improving" | "Weakening" | "Lagging";

interface SectoralHeatmapItem {
  indexName: string;
  shortName: string;
  last: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  change1dPct: number;
  change1wPct: number;
  change1mPct: number;
  rsVsNifty1d: number;
  rsVsNifty1w: number;
  rsVsNifty1m: number;
  turnoverCr: number;
  pe: number;
  pb: number;
  divYield: number;
  quadrant: RotationQuadrant;
  rotationScore: number;
  constituentCount: number;
  fnoCount: number;
}

interface SectorConstituent {
  symbol: string;
  description: string;
  industry: string;
  isFno: boolean;
  ltp: number;
  prevClose: number;
  changePct: number;
  volume: number;
  turnoverCr: number;
}

interface MarketMoverRow {
  symbol: string;
  ltp: number;
  prevPrice: number;
  perChange: number;
  turnover: string;
  tradeQuantity: string;
}

interface SectoralRotationDashboardProps {
  onSelectSectorForD5?: (sectorIndex: string) => void;
}

const QUADRANT_META: Record<
  RotationQuadrant,
  { text: string; bar: string; desc: string }
> = {
  Leading: {
    text: "text-emerald-400",
    bar: "bg-emerald-500",
    desc: "Outperforming Nifty 50 on both 1M trend and 1W momentum"
  },
  Improving: {
    text: "text-cyan-400",
    bar: "bg-cyan-500",
    desc: "Lagging 1M trend but accelerating ahead of Nifty 50 over 1W"
  },
  Weakening: {
    text: "text-amber-400",
    bar: "bg-amber-500",
    desc: "Outperforming 1M trend but losing 1W relative momentum"
  },
  Lagging: {
    text: "text-rose-400",
    bar: "bg-rose-500",
    desc: "Underperforming Nifty 50 on both 1M trend and 1W momentum"
  }
};

async function safeFetchJson(url: string) {
  const res = await fetch(url);
  const ct = res.headers.get("content-type") || "";
  if (!res.ok || !ct.includes("application/json")) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export default function SectoralRotationDashboard({
  onSelectSectorForD5
}: SectoralRotationDashboardProps) {
  const [sectors, setSectors] = useState<SectoralHeatmapItem[]>([]);
  const [nifty50, setNifty50] = useState<{
    last: number;
    change1dPct: number;
    change1wPct: number;
    change1mPct: number;
  } | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [periodView, setPeriodView] = useState<"1d" | "1w" | "1m" | "rs">("1d");
  const [quadrantFilter, setQuadrantFilter] = useState<"All" | RotationQuadrant>("All");

  // Drill-down constituent state
  const [selectedSector, setSelectedSector] = useState<string>("");
  const [constituents, setConstituents] = useState<SectorConstituent[]>([]);
  const [loadingConstituents, setLoadingConstituents] = useState<boolean>(false);
  const [constituentSearch, setConstituentSearch] = useState<string>("");
  const [fnoOnlyConstituents, setFnoOnlyConstituents] = useState<boolean>(false);
  const [minTurnoverCr, setMinTurnoverCr] = useState<number>(0);

  // Live NSE Market Movers strip
  const [moversTab, setMoversTab] = useState<"gainers" | "losers">("gainers");
  const [movers, setMovers] = useState<{ gainers: MarketMoverRow[]; losers: MarketMoverRow[] }>({
    gainers: [],
    losers: []
  });

  const getTradingViewUrl = (symbol: string) => {
    try {
      const saved = localStorage.getItem("custom_tradingview_links");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === "object" && parsed[symbol]) {
          return parsed[symbol];
        }
      }
    } catch {
      // ignore
    }
    return `https://www.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(symbol)}`;
  };

  const loadSectoralData = useCallback(async (force = false, sectorToLoad?: string) => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const qs = new URLSearchParams();
      if (force) qs.set("refresh", "1");
      if (sectorToLoad) qs.set("sector", sectorToLoad);
      const [rotJson, moversJson] = await Promise.all([
        safeFetchJson(`/api/nse/sectoral-rotation${qs.toString() ? `?${qs.toString()}` : ""}`),
        safeFetchJson("/api/nse/market-movers?limit=12").catch(() => null)
      ]);

      if (rotJson?.status === "ok" && rotJson.data) {
        const nextSectors: SectoralHeatmapItem[] = rotJson.data.sectors || [];
        setSectors(nextSectors);
        setNifty50(rotJson.data.nifty50 || null);
        setUpdatedAt(rotJson.data.updatedAt || "");
        if (sectorToLoad && Array.isArray(rotJson.data.constituents)) {
          setConstituents(rotJson.data.constituents);
        } else if (!sectorToLoad && nextSectors.length > 0) {
          // Auto-select the top leading sector with constituents on initial load
          const firstWithMembers = nextSectors.find(s => s.constituentCount > 0) || nextSectors[0];
          if (firstWithMembers) {
            setSelectedSector(firstWithMembers.indexName);
          }
        }
      }

      if (moversJson?.status === "ok" && moversJson.data) {
        setMovers({
          gainers: moversJson.data.gainers || [],
          losers: moversJson.data.losers || []
        });
      }
    } catch (err: any) {
      setErrorMsg(err?.message || "Unable to fetch NSE sectoral rotation data");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSectoralData(false);
  }, [loadSectoralData]);

  // Fetch live constituent quotes whenever user selects a sector tile
  useEffect(() => {
    if (!selectedSector) return;
    let cancelled = false;
    setLoadingConstituents(true);
    safeFetchJson(`/api/nse/sectoral-rotation?sector=${encodeURIComponent(selectedSector)}`)
      .then(json => {
        if (!cancelled && json?.status === "ok" && Array.isArray(json.data?.constituents)) {
          setConstituents(json.data.constituents);
        }
      })
      .catch(() => {
        if (!cancelled) setConstituents([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingConstituents(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSector]);

  const getMetricValue = (item: SectoralHeatmapItem): number => {
    if (periodView === "1d") return item.change1dPct;
    if (periodView === "1w") return item.change1wPct;
    if (periodView === "1m") return item.change1mPct;
    return item.rotationScore;
  };

  const filteredSectors = useMemo(() => {
    const list = quadrantFilter === "All" ? sectors : sectors.filter(s => s.quadrant === quadrantFilter);
    return [...list].sort((a, b) => getMetricValue(b) - getMetricValue(a));
  }, [sectors, quadrantFilter, periodView]);

  const filteredConstituents = useMemo(() => {
    const q = constituentSearch.trim().toLowerCase();
    return constituents.filter(c => {
      if (fnoOnlyConstituents && !c.isFno) return false;
      if (minTurnoverCr > 0 && c.turnoverCr < minTurnoverCr) return false;
      if (q) {
        return c.symbol.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.industry.toLowerCase().includes(q);
      }
      return true;
    });
  }, [constituents, constituentSearch, fnoOnlyConstituents, minTurnoverCr]);

  const summary = useMemo(() => {
    if (!sectors.length) return null;
    const by1d = [...sectors].sort((a, b) => b.change1dPct - a.change1dPct);
    const upCount = sectors.filter(s => s.change1dPct > 0).length;
    const downCount = sectors.filter(s => s.change1dPct < 0).length;
    const leadingCount = sectors.filter(s => s.quadrant === "Leading").length;
    const improvingCount = sectors.filter(s => s.quadrant === "Improving").length;
    return {
      leader: by1d[0],
      laggard: by1d[by1d.length - 1],
      upCount,
      downCount,
      leadingCount,
      improvingCount
    };
  }, [sectors]);

  const getTileSurfaceStyle = (val: number, isSelected: boolean): string => {
    const ring = isSelected ? "ring-2 ring-orange-400 border-orange-400/80" : "border-[#2a2d32] hover:border-zinc-500";
    if (val >= 2.0) return `bg-emerald-950/65 ${ring}`;
    if (val >= 0.6) return `bg-emerald-950/35 ${ring}`;
    if (val > 0) return `bg-emerald-950/20 ${ring}`;
    if (val <= -2.0) return `bg-rose-950/65 ${ring}`;
    if (val <= -0.6) return `bg-rose-950/35 ${ring}`;
    if (val < 0) return `bg-rose-950/20 ${ring}`;
    return `bg-[#13151a] ${ring}`;
  };

  const selectedSectorMeta = sectors.find(s => s.indexName === selectedSector) || null;
  const activeMoversList = moversTab === "gainers" ? movers.gainers : movers.losers;

  return (
    <div className="flex-1 max-w-[1800px] w-full mx-auto p-4 sm:p-6 flex flex-col space-y-5">
      {/* Top Header & Controls */}
      <div className="bg-[#0d0e12] border border-[#2a2d32] rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-white tracking-tight font-sans">
            D6 — NSE Sectoral Rotation &amp; Heatmap
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-zinc-400 mt-1">
            <span>Live NSE CM Sectoral Indices</span>
            <span aria-hidden="true">·</span>
            <span>Bhavcopy 1W / 1M Relative Strength vs Nifty 50</span>
            <span aria-hidden="true">·</span>
            <span>Nifty 500 Industry Drill-Down</span>
            {updatedAt && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums text-zinc-500">
                  Synced {new Date(updatedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Metric Period Switcher */}
          <div className="flex items-center gap-1 p-1 bg-[#13151a] border border-[#2a2d32] rounded-lg">
            {(
              [
                { id: "1d", label: "1D Live" },
                { id: "1w", label: "1W Return" },
                { id: "1m", label: "1M Return" },
                { id: "rs", label: "RS Score" }
              ] as const
            ).map(tab => (
              <button
                key={tab.id}
                onClick={() => setPeriodView(tab.id)}
                className={`px-3 py-1.5 text-xs font-mono font-bold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  periodView === tab.id
                    ? "bg-orange-500 text-black"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Quadrant Filter */}
          <div className="flex items-center gap-1 p-1 bg-[#13151a] border border-[#2a2d32] rounded-lg">
            {(["All", "Leading", "Improving", "Weakening", "Lagging"] as const).map(q => (
              <button
                key={q}
                onClick={() => setQuadrantFilter(q)}
                className={`px-2.5 py-1.5 text-xs font-mono font-bold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  quadrantFilter === q
                    ? "bg-[#222630] text-white"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                {q}
              </button>
            ))}
          </div>

          <button
            onClick={() => loadSectoralData(true, selectedSector)}
            disabled={isLoading}
            className="px-3.5 py-2 text-xs font-mono font-bold rounded-lg bg-[#161922] hover:bg-[#1f2430] border border-[#2a2d32] text-zinc-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin text-orange-400" : ""}`} />
            <span>Refresh NSE</span>
          </button>
        </div>
      </div>

      {/* Summary Metrics Strip */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-[#0d0e12] border border-[#2a2d32] rounded-xl p-4">
            <div className="text-xs font-mono text-zinc-400">Benchmark · Nifty 50</div>
            <div className="mt-1.5 flex items-baseline justify-between font-mono tabular-nums">
              <span className="text-lg font-bold text-white">
                {nifty50 ? nifty50.last.toLocaleString("en-IN", { minimumFractionDigits: 2 }) : "—"}
              </span>
              <span className={`text-sm font-bold ${(nifty50?.change1dPct || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {(nifty50?.change1dPct || 0) >= 0 ? "+" : ""}
                {(nifty50?.change1dPct || 0).toFixed(2)}%
              </span>
            </div>
            <div className="mt-1 text-[11px] font-mono tabular-nums text-zinc-500">
              1W {(nifty50?.change1wPct || 0) >= 0 ? "+" : ""}{(nifty50?.change1wPct || 0).toFixed(2)}% · 1M {(nifty50?.change1mPct || 0) >= 0 ? "+" : ""}{(nifty50?.change1mPct || 0).toFixed(2)}%
            </div>
          </div>

          <div className="bg-[#0d0e12] border border-[#2a2d32] rounded-xl p-4">
            <div className="text-xs font-mono text-zinc-400">Top Sector (1D)</div>
            <div className="mt-1.5 flex items-baseline justify-between font-mono tabular-nums">
              <span className="text-sm font-bold text-white truncate pr-2">{summary.leader.shortName}</span>
              <span className={`text-base font-bold ${summary.leader.change1dPct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {summary.leader.change1dPct >= 0 ? "+" : ""}{summary.leader.change1dPct.toFixed(2)}%
              </span>
            </div>
            <div className="mt-1 text-[11px] font-mono tabular-nums text-zinc-500">
              RS vs Nifty 1M: {summary.leader.rsVsNifty1m >= 0 ? "+" : ""}{summary.leader.rsVsNifty1m.toFixed(2)}% · {summary.leader.quadrant}
            </div>
          </div>

          <div className="bg-[#0d0e12] border border-[#2a2d32] rounded-xl p-4">
            <div className="text-xs font-mono text-zinc-400">Weakest Sector (1D)</div>
            <div className="mt-1.5 flex items-baseline justify-between font-mono tabular-nums">
              <span className="text-sm font-bold text-white truncate pr-2">{summary.laggard.shortName}</span>
              <span className={`text-base font-bold ${summary.laggard.change1dPct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {summary.laggard.change1dPct >= 0 ? "+" : ""}{summary.laggard.change1dPct.toFixed(2)}%
              </span>
            </div>
            <div className="mt-1 text-[11px] font-mono tabular-nums text-zinc-500">
              RS vs Nifty 1M: {summary.laggard.rsVsNifty1m >= 0 ? "+" : ""}{summary.laggard.rsVsNifty1m.toFixed(2)}% · {summary.laggard.quadrant}
            </div>
          </div>

          <div className="bg-[#0d0e12] border border-[#2a2d32] rounded-xl p-4">
            <div className="text-xs font-mono text-zinc-400">Sectoral Breadth &amp; Rotation</div>
            <div className="mt-1.5 flex items-baseline justify-between font-mono tabular-nums">
              <span className="text-base font-bold text-emerald-400">{summary.upCount} Up</span>
              <span className="text-zinc-600">/</span>
              <span className="text-base font-bold text-rose-400">{summary.downCount} Down</span>
            </div>
            <div className="mt-1 text-[11px] font-mono tabular-nums text-zinc-500">
              {summary.leadingCount} Leading · {summary.improvingCount} Improving · {sectors.length} Tracked
            </div>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="bg-rose-950/30 border border-rose-500/40 rounded-xl p-4 text-xs font-mono text-rose-300 flex items-center justify-between">
          <span>{errorMsg}</span>
          <button
            onClick={() => loadSectoralData(true)}
            className="px-3 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 font-bold cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Main Sectoral Heatmap Grid */}
      <div className="bg-[#0d0e12] border border-[#2a2d32] rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-4 border-b border-[#22252b]">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-orange-400" />
            <h3 className="text-sm font-bold text-white">Sectoral Heatmap &amp; Relative Strength Matrix</h3>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-zinc-400">
            <span className="text-emerald-400">Leading: +1M &amp; +1W RS</span>
            <span aria-hidden="true">·</span>
            <span className="text-cyan-400">Improving: -1M &amp; +1W RS</span>
            <span aria-hidden="true">·</span>
            <span className="text-amber-400">Weakening: +1M &amp; -1W RS</span>
            <span aria-hidden="true">·</span>
            <span className="text-rose-400">Lagging: -1M &amp; -1W RS</span>
          </div>
        </div>

        {isLoading && sectors.length === 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="h-32 rounded-lg bg-[#13151a] border border-[#22252b] animate-pulse" />
            ))}
          </div>
        ) : filteredSectors.length === 0 ? (
          <div className="py-10 text-center text-xs font-mono text-zinc-500">
            No NSE sectoral indices match the selected quadrant filter.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
            {filteredSectors.map(sec => {
              const metricVal = getMetricValue(sec);
              const isSelected = selectedSector === sec.indexName;
              const qMeta = QUADRANT_META[sec.quadrant];
              return (
                <button
                  key={sec.indexName}
                  type="button"
                  onClick={() => setSelectedSector(sec.indexName)}
                  className={`text-left rounded-lg border p-3.5 transition-all cursor-pointer ${getTileSurfaceStyle(
                    metricVal,
                    isSelected
                  )}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white truncate">{sec.shortName}</div>
                      <div className="text-[11px] font-mono tabular-nums text-zinc-400 mt-0.5">
                        {sec.last.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      </div>
                    </div>
                    <div className="text-right font-mono tabular-nums shrink-0">
                      <div
                        className={`text-base font-extrabold ${
                          metricVal >= 0 ? "text-emerald-400" : "text-rose-400"
                        }`}
                      >
                        {metricVal >= 0 ? "+" : ""}
                        {metricVal.toFixed(2)}%
                      </div>
                      <div className={`text-[10px] font-bold ${qMeta.text}`}>{sec.quadrant}</div>
                    </div>
                  </div>

                  {/* Multi-horizon strip */}
                  <div className="mt-3 pt-2.5 border-t border-white/10 grid grid-cols-3 gap-1 text-[10px] font-mono tabular-nums">
                    <div>
                      <span className="text-zinc-500 block">1D</span>
                      <span className={sec.change1dPct >= 0 ? "text-emerald-300" : "text-rose-300"}>
                        {sec.change1dPct >= 0 ? "+" : ""}{sec.change1dPct.toFixed(2)}%
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block">1W</span>
                      <span className={sec.change1wPct >= 0 ? "text-emerald-300" : "text-rose-300"}>
                        {sec.change1wPct >= 0 ? "+" : ""}{sec.change1wPct.toFixed(2)}%
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block">1M RS</span>
                      <span className={sec.rsVsNifty1m >= 0 ? "text-emerald-300" : "text-rose-300"}>
                        {sec.rsVsNifty1m >= 0 ? "+" : ""}{sec.rsVsNifty1m.toFixed(2)}%
                      </span>
                    </div>
                  </div>

                  <div className="mt-2 flex items-center justify-between text-[10px] font-mono text-zinc-400 tabular-nums">
                    <span>
                      {sec.constituentCount} Nifty500 · {sec.fnoCount} F&amp;O
                    </span>
                    {sec.pe > 0 && <span>P/E {sec.pe.toFixed(1)}</span>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom Split: Selected Sector Nifty 500 Constituents + Live NSE Market Movers */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        {/* Sector Constituents Drill-Down (8 cols) */}
        <div className="xl:col-span-8 bg-[#0d0e12] border border-[#2a2d32] rounded-xl p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 mb-3 border-b border-[#22252b]">
            <div>
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-orange-400" />
                <h3 className="text-sm font-bold text-white">
                  {selectedSectorMeta ? `${selectedSectorMeta.indexName} — Nifty 500 Constituents` : "Sector Constituents"}
                </h3>
              </div>
              {selectedSectorMeta && (
                <div className="text-[11px] font-mono text-zinc-400 mt-0.5 tabular-nums">
                  {QUADRANT_META[selectedSectorMeta.quadrant].desc} ·{" "}
                  {selectedSectorMeta.turnoverCr > 0 ? `Index Turnover ₹${selectedSectorMeta.turnoverCr.toLocaleString("en-IN")} Cr` : `${constituents.length} mapped stocks`}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {selectedSector && onSelectSectorForD5 && (
                <button
                  onClick={() => onSelectSectorForD5(selectedSector)}
                  className="px-3 py-1.5 rounded-lg bg-orange-500 hover:bg-orange-400 text-black font-mono font-bold text-xs flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                >
                  <Filter className="w-3.5 h-3.5" />
                  <span>Screen in D5 Matrix</span>
                </button>
              )}
            </div>
          </div>

          {/* Constituent Filters */}
          <div className="flex flex-wrap items-center gap-2.5 mb-3">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Filter sector stocks..."
                value={constituentSearch}
                onChange={e => setConstituentSearch(e.target.value)}
                className="w-full bg-[#13151a] border border-[#2a2d32] rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-orange-500"
              />
            </div>

            <select
              value={minTurnoverCr}
              onChange={e => setMinTurnoverCr(Number(e.target.value))}
              aria-label="Minimum Turnover"
              className="bg-[#13151a] border border-[#2a2d32] rounded-lg px-2.5 py-1.5 text-xs font-mono text-zinc-200 focus:outline-none cursor-pointer"
            >
              <option value={0}>Turnover: All</option>
              <option value={10}>Turnover ≥ ₹10 Cr</option>
              <option value={25}>Turnover ≥ ₹25 Cr</option>
              <option value={50}>Turnover ≥ ₹50 Cr</option>
              <option value={100}>Turnover ≥ ₹100 Cr</option>
            </select>

            <button
              type="button"
              onClick={() => setFnoOnlyConstituents(v => !v)}
              className={`px-3 py-1.5 rounded-lg border text-xs font-mono font-bold cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
                fnoOnlyConstituents
                  ? "bg-orange-500/20 border-orange-500 text-orange-300"
                  : "bg-[#13151a] border-[#2a2d32] text-zinc-400 hover:text-white"
              }`}
            >
              F&amp;O Only
            </button>
          </div>

          <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-[#13151a] text-[11px] font-mono text-zinc-400 border-b border-[#2a2d32]">
                <tr>
                  <th className="py-2.5 px-3">Symbol</th>
                  <th className="py-2.5 px-3">NSE Industry</th>
                  <th className="py-2.5 px-3 text-right">LTP (₹)</th>
                  <th className="py-2.5 px-3 text-right">1D Chg</th>
                  <th className="py-2.5 px-3 text-right">Turnover (Cr)</th>
                  <th className="py-2.5 px-3 text-right">Chart</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1d2026] text-xs">
                {loadingConstituents ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i}>
                      <td colSpan={6} className="py-3 px-3">
                        <div className="h-4 bg-[#161922] rounded animate-pulse" />
                      </td>
                    </tr>
                  ))
                ) : filteredConstituents.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center font-mono text-zinc-500">
                      No constituents match the current filter for {selectedSector || "this sector"}.
                    </td>
                  </tr>
                ) : (
                  filteredConstituents.map(c => (
                    <tr key={c.symbol} className="hover:bg-[#161922] transition-colors">
                      <td className="py-2.5 px-3">
                        <div className="font-mono font-bold text-white flex items-center gap-1.5">
                          <span>{c.symbol}</span>
                          {c.isFno && (
                            <span className="text-[10px] font-mono text-orange-400 font-semibold">F&amp;O</span>
                          )}
                        </div>
                        <div className="text-[11px] text-zinc-500 truncate max-w-[200px]">{c.description}</div>
                      </td>
                      <td className="py-2.5 px-3 text-[11px] text-zinc-400">{c.industry}</td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-zinc-200">
                        {c.ltp > 0 ? c.ltp.toLocaleString("en-IN", { minimumFractionDigits: 2 }) : "—"}
                      </td>
                      <td
                        className={`py-2.5 px-3 text-right font-mono tabular-nums font-bold ${
                          c.changePct >= 0 ? "text-emerald-400" : "text-rose-400"
                        }`}
                      >
                        {c.changePct >= 0 ? "+" : ""}{c.changePct.toFixed(2)}%
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-zinc-300">
                        {c.turnoverCr > 0 ? `₹${c.turnoverCr.toFixed(1)}` : "—"}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <a
                          href={getTradingViewUrl(c.symbol)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] font-mono text-zinc-400 hover:text-orange-400"
                        >
                          <span>TV</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Live NSE Market Movers Panel (4 cols) */}
        <div className="xl:col-span-4 bg-[#0d0e12] border border-[#2a2d32] rounded-xl p-4">
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-[#22252b]">
            <div className="flex items-center gap-2">
              {moversTab === "gainers" ? (
                <TrendingUp className="w-4 h-4 text-emerald-400" />
              ) : (
                <TrendingDown className="w-4 h-4 text-rose-400" />
              )}
              <h3 className="text-sm font-bold text-white">Live NSE Market Movers</h3>
            </div>
            <div className="flex items-center gap-1 p-0.5 bg-[#13151a] border border-[#2a2d32] rounded-lg">
              <button
                onClick={() => setMoversTab("gainers")}
                className={`px-2.5 py-1 text-[11px] font-mono font-bold rounded cursor-pointer transition-colors ${
                  moversTab === "gainers" ? "bg-emerald-500/20 text-emerald-300" : "text-zinc-400 hover:text-white"
                }`}
              >
                Gainers
              </button>
              <button
                onClick={() => setMoversTab("losers")}
                className={`px-2.5 py-1 text-[11px] font-mono font-bold rounded cursor-pointer transition-colors ${
                  moversTab === "losers" ? "bg-rose-500/20 text-rose-300" : "text-zinc-400 hover:text-white"
                }`}
              >
                Losers
              </button>
            </div>
          </div>

          <div className="divide-y divide-[#1d2026]">
            {activeMoversList.length === 0 ? (
              <div className="py-8 text-center text-xs font-mono text-zinc-500">
                Loading live NSE market movers...
              </div>
            ) : (
              activeMoversList.map(m => (
                <a
                  key={m.symbol}
                  href={getTradingViewUrl(m.symbol)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="py-2.5 flex items-center justify-between hover:bg-[#161922] px-2 -mx-2 rounded transition-colors"
                >
                  <div>
                    <div className="text-xs font-mono font-bold text-white flex items-center gap-1">
                      <span>{m.symbol}</span>
                      <ExternalLink className="w-2.5 h-2.5 text-zinc-500" />
                    </div>
                    <div className="text-[11px] font-mono text-zinc-500 tabular-nums">
                      Turnover {m.turnover}
                    </div>
                  </div>
                  <div className="text-right font-mono tabular-nums">
                    <div className="text-xs text-zinc-200">
                      ₹{m.ltp.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </div>
                    <div
                      className={`text-xs font-bold flex items-center justify-end gap-0.5 ${
                        m.perChange >= 0 ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {m.perChange >= 0 ? (
                        <ArrowUpRight className="w-3 h-3" />
                      ) : (
                        <ArrowDownRight className="w-3 h-3" />
                      )}
                      <span>
                        {m.perChange >= 0 ? "+" : ""}
                        {m.perChange.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                </a>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
