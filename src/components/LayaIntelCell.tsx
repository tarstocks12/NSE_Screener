import React from "react";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import { LayaPreTurnIntel } from "../lib/laya-engine.js";

interface LayaIntelCellProps {
  intel?: LayaPreTurnIntel | null;
  compact?: boolean;
}

export function LayaIntelCell({ intel, compact = false }: LayaIntelCellProps) {
  const {
    score = 50,
    label = "NEUTRAL",
    direction = "NEUTRAL",
    triggerTfs = [],
    summary = "No Imminent Turn",
    conversionRatePct,
    avgMfePct,
    symbolReliabilityPrior,
    followThroughNoul,
    tournamentRank,
    tournamentQualified,
  } = intel || {};

  const badgeStyle =
    label === "STRONG TURN BULL"
      ? "bg-emerald-950/60 text-emerald-300 border-emerald-400/50 shadow-[0_0_10px_rgba(16,185,129,0.2)]"
      : label === "TURN BULL"
      ? "bg-emerald-950/35 text-emerald-400 border-emerald-500/35"
      : label === "STRONG TURN BEAR"
      ? "bg-rose-950/60 text-rose-300 border-rose-400/50 shadow-[0_0_10px_rgba(244,63,94,0.2)]"
      : label === "TURN BEAR"
      ? "bg-amber-950/40 text-amber-400 border-amber-500/35"
      : "bg-zinc-900/90 text-zinc-400 border-zinc-800";

  const barStyle =
    direction === "BULL"
      ? "bg-gradient-to-r from-emerald-600 to-teal-400"
      : direction === "BEAR"
      ? "bg-gradient-to-r from-rose-600 to-amber-500"
      : "bg-zinc-600";

  const scoreTextStyle =
    direction === "BULL"
      ? "text-emerald-400"
      : direction === "BEAR"
      ? "text-amber-400"
      : "text-zinc-400";

  const fullTooltip = [
    summary,
    conversionRatePct !== undefined ? `Walk-Forward 3-5b Conversion: ${conversionRatePct}%` : null,
    avgMfePct !== undefined ? `Avg MFE: +${avgMfePct}%` : null,
    symbolReliabilityPrior !== undefined && symbolReliabilityPrior !== 0
      ? `Symbol Memory Prior: ${symbolReliabilityPrior > 0 ? `+${symbolReliabilityPrior}` : symbolReliabilityPrior} pts`
      : null,
    followThroughNoul !== undefined ? `RLCD Follow-Through Noul: ${followThroughNoul.toFixed(2)}` : null,
    tournamentQualified && tournamentRank ? `Laya 2-Round Tournament Rank #${tournamentRank}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  if (compact) {
    return (
      <div className="flex flex-col items-center justify-center space-y-1" title={fullTooltip}>
        <div className="flex items-center gap-1">
          <div
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-mono font-bold tracking-wider uppercase border ${badgeStyle}`}
          >
            {direction === "BULL" && <ArrowUpRight className="w-2.5 h-2.5 shrink-0" />}
            {direction === "BEAR" && <ArrowDownRight className="w-2.5 h-2.5 shrink-0" />}
            <span>{label}</span>
          </div>
          {tournamentQualified && tournamentRank && (
            <span className="px-1 py-0.5 rounded text-[8px] font-mono font-extrabold bg-indigo-950/70 text-indigo-300 border border-indigo-500/40">
              T#{tournamentRank}
            </span>
          )}
        </div>
        <div className="flex items-center space-x-1.5">
          <div className="w-14 bg-[#181a20] h-1 rounded-full overflow-hidden p-[0.5px] border border-white/5">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barStyle}`}
              style={{ width: `${score}%` }}
            />
          </div>
          <span className={`text-[10px] font-mono font-bold tabular-nums ${scoreTextStyle}`}>
            {score}%
          </span>
          {conversionRatePct !== undefined && (
            <span className="text-[8px] font-mono text-zinc-500 tabular-nums">
              ({conversionRatePct}%W)
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center space-y-1" title={fullTooltip}>
      <div className="flex items-center gap-1">
        <div
          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-[10px] font-mono font-bold tracking-wider uppercase border ${badgeStyle}`}
        >
          {direction === "BULL" && <ArrowUpRight className="w-3 h-3 shrink-0" />}
          {direction === "BEAR" && <ArrowDownRight className="w-3 h-3 shrink-0" />}
          <span>{label}</span>
        </div>
        {tournamentQualified && tournamentRank && (
          <span className="px-1.5 py-0.5 rounded text-[8.5px] font-mono font-extrabold bg-indigo-950/70 text-indigo-300 border border-indigo-500/40">
            T#{tournamentRank}
          </span>
        )}
      </div>
      <div className="flex items-center space-x-1.5">
        <div className="w-16 bg-[#181a20] h-1.5 rounded-full overflow-hidden p-[1px] border border-white/5">
          <div
            className={`h-full rounded-full transition-all duration-500 ${barStyle}`}
            style={{ width: `${score}%` }}
          />
        </div>
        <span className={`text-[10px] font-mono font-bold tabular-nums ${scoreTextStyle}`}>
          {score}%
        </span>
        {conversionRatePct !== undefined && (
          <span
            className={`text-[8.5px] font-mono font-semibold px-1 py-0.2 rounded border tabular-nums ${
              conversionRatePct >= 70
                ? "text-emerald-400/90 border-emerald-500/25 bg-emerald-950/20"
                : conversionRatePct <= 54
                ? "text-amber-400/90 border-amber-500/25 bg-amber-950/20"
                : "text-zinc-400 border-zinc-800 bg-zinc-900/60"
            }`}
          >
            {conversionRatePct}% Conv
          </span>
        )}
      </div>
      <span className="text-[9px] font-mono text-zinc-500 tracking-tight truncate max-w-[155px]">
        {triggerTfs.length > 0
          ? `${direction === "BULL" ? "Pre-Bull:" : direction === "BEAR" ? "Pre-Bear:" : "TF:"} ${triggerTfs.join(", ")}`
          : summary}
        {symbolReliabilityPrior !== undefined && symbolReliabilityPrior !== 0
          ? ` · ${symbolReliabilityPrior > 0 ? `+${symbolReliabilityPrior}` : symbolReliabilityPrior}p Mem`
          : ""}
      </span>
    </div>
  );
}

