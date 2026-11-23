import React, { useEffect, useState, useCallback } from "react";
import { Activity, Layers, RefreshCw, ShieldAlert } from "lucide-react";
import { setGlobalMarketMoodContext, LayaMarketMoodContext } from "../lib/laya-engine.js";

interface MarketMoodPayload {
  date: string;
  updatedAt: string;
  indiaVix: {
    level: number;
    prevClose: number;
    change1dPct: number;
    change1wPct: number;
    change1mPct: number;
    yearHigh: number;
    yearLow: number;
    zone: "LOW_COMPLACENCY" | "NORMAL" | "ELEVATED" | "PANIC_SPIKE";
  };
  breadth: {
    stocksUp: number;
    stocksDown: number;
    stocksUnchanged: number;
    totalStocks: number;
    advPct: number;
    reading: string;
    indicesUp: number;
    indicesDown: number;
  };
  benchmarks: {
    nifty50: { close: number; changePct: number };
    nifty500: { close: number; changePct: number };
    bankNifty: { close: number; changePct: number };
    midcap100: { close: number; changePct: number };
    smallcap100: { close: number; changePct: number };
  };
  moodRegime: LayaMarketMoodContext["moodRegime"];
  regimeNote: string;
}

const REGIME_STYLE: Record<
  LayaMarketMoodContext["moodRegime"],
  { label: string; color: string; dot: string }
> = {
  WASHOUT_FEAR: {
    label: "WASHOUT FEAR",
    color: "text-rose-400",
    dot: "bg-rose-500",
  },
  ELEVATED_VOL: {
    label: "ELEVATED VOL",
    color: "text-amber-400",
    dot: "bg-amber-400",
  },
  RISK_ON: {
    label: "RISK-ON TREND",
    color: "text-emerald-400",
    dot: "bg-emerald-500",
  },
  OVERBOUGHT_GREED: {
    label: "OVERBOUGHT EXTREME",
    color: "text-orange-400",
    dot: "bg-orange-400",
  },
  NEUTRAL: {
    label: "BALANCED REGIME",
    color: "text-cyan-400",
    dot: "bg-cyan-400",
  },
};

function fmtSigned(val: number, suffix = "%") {
  if (!Number.isFinite(val)) return `0.00${suffix}`;
  return `${val > 0 ? "+" : ""}${val.toFixed(2)}${suffix}`;
}

export default function MarketMoodBar({
  onOpenSectoral,
}: {
  onOpenSectoral?: () => void;
}) {
  const [mood, setMood] = useState<MarketMoodPayload | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadMood = useCallback(async (force = false) => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/nse/market-mood${force ? "?refresh=1" : ""}`);
      const ct = res.headers.get("content-type") || "";
      if (!res.ok || !ct.includes("application/json")) return;
      const json = await res.json();
      if (json?.status === "ok" && json.data) {
        const d: MarketMoodPayload = json.data;
        setMood(d);
        setGlobalMarketMoodContext({
          vixLevel: d.indiaVix?.level ?? 14,
          vixChange1dPct: d.indiaVix?.change1dPct ?? 0,
          vixChange1wPct: d.indiaVix?.change1wPct ?? 0,
          advPct: d.breadth?.advPct ?? 50,
          moodRegime: d.moodRegime || "NEUTRAL",
          updatedAt: d.updatedAt,
        });
      }
    } catch {
      // Retain last known mood silently
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadMood(false);
    const id = setInterval(() => loadMood(false), 90_000);
    return () => clearInterval(id);
  }, [loadMood]);

  if (!mood || !mood.indiaVix || !mood.breadth) {
    return (
      <div className="w-full bg-[#0b0c10] border-b border-[#20232a] px-4 py-1.5 text-[11px] font-mono text-zinc-500 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-3.5 w-3.5 text-orange-400/70 animate-pulse" />
          <span>Syncing NSE Market Mood, India VIX &amp; Advance/Decline Breadth via MCP...</span>
        </div>
      </div>
    );
  }

  const regimeMeta = REGIME_STYLE[mood.moodRegime] || REGIME_STYLE.NEUTRAL;
  const vixElevated = mood.indiaVix.level >= 18;
  const advPctClamped = Math.max(0, Math.min(100, mood.breadth.advPct ?? 50));
  const n50 = mood.benchmarks?.nifty50;
  const n500 = mood.benchmarks?.nifty500;

  return (
    <div className="w-full bg-[#0b0c10] border-b border-[#22252d] px-4 py-1.5 text-[11px] font-mono tabular-nums text-zinc-300">
      <div className="max-w-[1800px] mx-auto flex flex-wrap items-center justify-between gap-x-5 gap-y-1.5">
        {/* Left: India VIX + Breadth + Nifty Benchmarks */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {/* India VIX */}
          <div
            className="flex items-center gap-1.5"
            title={`India VIX (${mood.indiaVix.zone}): 1D ${fmtSigned(mood.indiaVix.change1dPct)} | 1W ${fmtSigned(mood.indiaVix.change1wPct)} | 1M ${fmtSigned(mood.indiaVix.change1mPct)}`}
          >
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
              INDIA VIX
            </span>
            <span className={`font-bold ${vixElevated ? "text-amber-400" : "text-white"}`}>
              {mood.indiaVix.level > 0 ? mood.indiaVix.level.toFixed(2) : "—"}
            </span>
            <span
              className={
                mood.indiaVix.change1dPct > 0
                  ? "text-rose-400"
                  : mood.indiaVix.change1dPct < 0
                  ? "text-emerald-400"
                  : "text-zinc-500"
              }
            >
              {fmtSigned(mood.indiaVix.change1dPct)} 1D
            </span>
            <span className="text-zinc-600 hidden sm:inline">·</span>
            <span className="text-zinc-400 hidden sm:inline">
              {fmtSigned(mood.indiaVix.change1wPct)} 1W
            </span>
            <span className="text-zinc-600 hidden xl:inline">·</span>
            <span className="text-zinc-500 hidden xl:inline">
              {fmtSigned(mood.indiaVix.change1mPct)} 1M
            </span>
          </div>

          <span className="text-zinc-700 hidden md:inline">|</span>

          {/* NSE Advance / Decline Breadth */}
          <div className="flex items-center gap-2" title={mood.breadth.reading}>
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
              NSE A/D
            </span>
            <span className="text-emerald-400 font-semibold">
              {(mood.breadth.stocksUp ?? 0).toLocaleString("en-IN")}↑
            </span>
            <span className="text-zinc-600">/</span>
            <span className="text-rose-400 font-semibold">
              {(mood.breadth.stocksDown ?? 0).toLocaleString("en-IN")}↓
            </span>
            <div className="w-12 h-1.5 bg-rose-500/35 rounded-full overflow-hidden hidden sm:block">
              <div
                className="h-full bg-emerald-500 transition-all duration-300"
                style={{ width: `${advPctClamped}%` }}
              />
            </div>
            <span
              className={
                advPctClamped >= 58
                  ? "text-emerald-400"
                  : advPctClamped <= 42
                  ? "text-rose-400"
                  : "text-zinc-400"
              }
            >
              {advPctClamped.toFixed(0)}% Adv
            </span>
          </div>

          <span className="text-zinc-700 hidden lg:inline">|</span>

          {/* NIFTY 50 & NIFTY 500 Spot */}
          <div className="hidden lg:flex items-center gap-3">
            {n50 && n50.close > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase text-zinc-500 font-semibold">NIFTY 50</span>
                <span className="text-white font-semibold">
                  {n50.close.toLocaleString("en-IN", { maximumFractionDigits: 1 })}
                </span>
                <span className={n50.changePct >= 0 ? "text-emerald-400" : "text-rose-400"}>
                  {fmtSigned(n50.changePct)}
                </span>
              </div>
            )}
            {n500 && n500.close > 0 && (
              <div className="hidden 2xl:flex items-center gap-1.5">
                <span className="text-[10px] uppercase text-zinc-500 font-semibold">NIFTY 500</span>
                <span className="text-zinc-200">
                  {n500.close.toLocaleString("en-IN", { maximumFractionDigits: 1 })}
                </span>
                <span className={n500.changePct >= 0 ? "text-emerald-400" : "text-rose-400"}>
                  {fmtSigned(n500.changePct)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Right: Laya Macro Regime Overlay + Quick D6 Sectoral Jump + Refresh */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5" title={mood.regimeNote}>
            <span className={`w-1.5 h-1.5 rounded-full ${regimeMeta.dot}`} />
            <span className="text-[10px] uppercase text-zinc-500">LAYA S1 MACRO:</span>
            <span className={`font-bold tracking-wide ${regimeMeta.color}`}>
              {regimeMeta.label}
            </span>
            {mood.moodRegime === "WASHOUT_FEAR" && (
              <ShieldAlert className="h-3 w-3 text-rose-400" />
            )}
          </div>

          {onOpenSectoral && (
            <button
              type="button"
              onClick={onOpenSectoral}
              className="hidden sm:inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-orange-400 hover:text-orange-300 border-l border-[#252830] pl-3 transition-colors cursor-pointer"
              title="Open D6 — Sectoral Rotation & Heatmap"
            >
              <Layers className="h-3 w-3" />
              <span>D6 Sectoral</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => loadMood(true)}
            disabled={refreshing}
            className="text-zinc-500 hover:text-white transition-colors cursor-pointer disabled:opacity-40"
            title="Refresh NSE Market Mood & India VIX"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin text-orange-400" : ""}`} />
          </button>
        </div>
      </div>
    </div>
  );
}
